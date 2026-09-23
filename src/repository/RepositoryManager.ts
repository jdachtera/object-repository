import type { Backend, IndexSpec, IndexField, FieldSpec } from "../core/Backend.ts";
import { isRawQueryable, isSchemaAware, isTransactional, migrationTarget } from "../core/Backend.ts";
import { runMigrations, rollbackMigrations, type RunnerOptions } from "../migrations/run.ts";
import { BackendJournal, type JournalRow } from "../migrations/journal.ts";
import { downOps } from "../migrations/ops.ts";
import { WindowState } from "./windowState.ts";
import { planMigrations } from "../migrations/plan.ts";
import type { MigrateOptions, Migration, MigrationPlan, MigrationReport } from "../migrations/types.ts";
import { commandClient, isChangeDeliverable, type CommandClient, type CommandMap } from "../transport/command.ts";
import type { Transport } from "../core/Transport.ts";
import type { Expression } from "../expressions/Expression.ts";
import type { Context, SchemaVersioning } from "../core/types.ts";
import { SYSTEM_CONTEXT } from "../core/types.ts";
import type { AnyProperty, PropertyMap } from "../properties/infer.ts";
import type { ScalarProperty } from "../properties/ScalarProperty.ts";
import { schemaFingerprint } from "../properties/fingerprint.ts";
import { date, softDeleteMarker } from "../properties/factories.ts";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.ts";
import { Repository, TIMESTAMP_FIELDS, type SoftDeleteConfig, type TimestampFields, type TransactionState } from "./Repository.ts";

/** The `createdAt` / `updatedAt` properties added by `timestamps: true` (typed as `Date`). */
export interface TimestampProperties {
  createdAt: ScalarProperty<Date, number>;
  updatedAt: ScalarProperty<Date, number>;
}

/** The default column name the soft-delete marker is stored under. */
export const SOFT_DELETE_FIELD = "deletedAt";

/** The nullable `deletedAt` marker property added by `softDelete: true` (typed as `Date | null`). */
export interface SoftDeleteProperties {
  deletedAt: ScalarProperty<Date | null, number | null>;
}

export interface RepositoryManagerOptions {
  /** Backend shared by every repository this manager defines (defaults to in-memory). */
  backend?: Backend;
  /** Ambient context passed to every backend operation (defaults to the system context). */
  context?: Context;
  /**
   * Mint a new record id (defaults to a 32-char uuid). Override to match an adopted store's id shape
   * — e.g. `() => new ObjectId().toString()` alongside a Mongo `objectIdIdentity`.
   */
  generateId?: () => string;
  /**
   * The schema versions this build declares (ARCHITECTURE.md §13). Omitting it means ungated — every
   * migration operation applies immediately, the behaviour that predates the gate.
   */
  schema?: SchemaVersioning;
}

export interface DefineConfig<P extends PropertyMap> {
  name: string;
  properties: P;
  /**
   * Auto-manage `createdAt` / `updatedAt` (`date()` fields, added to the model type). `createdAt`
   * is set once on first save; `updatedAt` is set on every save and `patch`. Fields you declare
   * yourself with those names are respected (not overwritten with a default property).
   */
  timestamps?: boolean;
  /**
   * Soft-delete: `remove()` stamps a nullable `deletedAt` marker instead of deleting the row, and every
   * read excludes soft-deleted rows by default (use `.includeDeleted()` to include them, `restore()` to
   * bring one back, or `remove(instance, { hard: true })` to truly delete). Pass `{ field }` to rename
   * the marker column. A soft-deleted row keeps occupying any `unique` value (restore or hard-delete to
   * reuse it).
   */
  softDelete?: boolean | { field?: string };
  /** Model-level indexes (compound, unique, TTL, text, partial) beyond the per-scalar `index`/`unique` hints. */
  indexes?: IndexDecl[];
}

/**
 * The handle `RepositoryManager.transaction` passes to its callback. `repository(name)` returns the
 * tx-scoped repository for a model — over a transactional backend its reads and writes run on the
 * transaction's connection (interactive isolation). Pass the outer repo's type to recover full typing:
 * `tx.repository<typeof users>("User")`.
 */
export interface TransactionScope {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repository<R extends Repository<any> = Repository<any>>(model: string): R;
}

/** A model-level index declaration — `{ fields: ["a", { path: "b", descending: true }], unique: true }`. */
export interface IndexDecl {
  /** Index name; derived from the field paths when omitted. */
  name?: string;
  fields: Array<string | IndexField>;
  unique?: boolean;
  sparse?: boolean;
  /** Mongo TTL — expire documents `ttlSeconds` after the field's date value. */
  ttlSeconds?: number;
  /** Mongo text index over the fields. */
  text?: boolean;
  /** Partial-index predicate (Mongo `partialFilterExpression`). */
  where?: Expression;
}

/**
 * Entry point for defining models (ARCHITECTURE.md §5).
 *
 * All repositories from one manager share a single backend, which serves many models keyed by
 * `plan.model`. Swapping the backend (in-memory → IndexedDB → a sync composite) is a one-line
 * change here, by design.
 */
export class RepositoryManager {
  private readonly backend: Backend;
  private readonly ctx: Context;
  private readonly generateId: (() => string) | undefined;
  private readonly schema: SchemaVersioning | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly registry = new Map<string, Repository<any>>();
  /** Enough of each model's definition to rebuild it over a tx-scoped backend (interactive transactions). */
  private readonly defs = new Map<
    string,
    {
      properties: PropertyMap;
      timestamps: TimestampFields | null;
      softDelete: SoftDeleteConfig | null;
      /** Retained because a migration's generic pass needs to re-register the model's full layout. */
      indexes: IndexDecl[] | undefined;
    }
  >();
  /** Shared with every repository so an immediately-persisting write can refuse to escape a transaction. */
  private readonly txState: TransactionState = { mode: "none" };
  /** Which compatibility windows the store says have closed — read once a model declares one. */
  private readonly windows = new WindowState();
  private windowsLoaded = false;
  /** The applied journal rows this process knows about; newer ones changed the store behind it. */
  private seenApplied: Set<string> | null = null;

  constructor(options: RepositoryManagerOptions = {}) {
    this.backend = options.backend ?? new InMemoryBackend();
    this.ctx = options.context ?? SYSTEM_CONTEXT;
    this.generateId = options.generateId;
    this.schema = options.schema;
  }

  /** Define a model and get back a repository typed by its property map. */
  define<P extends PropertyMap>(config: DefineConfig<P> & { timestamps: true; softDelete: true | { field?: string } }): Repository<P & TimestampProperties & SoftDeleteProperties>;
  define<P extends PropertyMap>(config: DefineConfig<P> & { softDelete: true | { field?: string } }): Repository<P & SoftDeleteProperties>;
  define<P extends PropertyMap>(config: DefineConfig<P> & { timestamps: true }): Repository<P & TimestampProperties>;
  define<P extends PropertyMap>(config: DefineConfig<P>): Repository<P>;
  define<P extends PropertyMap>(config: DefineConfig<P>): Repository<P> {
    const softDelete = config.softDelete
      ? { field: (typeof config.softDelete === "object" ? config.softDelete.field : undefined) ?? SOFT_DELETE_FIELD }
      : null;
    let properties = config.timestamps ? withTimestamps(config.properties) : config.properties;
    if (softDelete) properties = withSoftDelete(properties, softDelete.field);
    const typed = properties as P;
    assertMirrorsAreSound(config.name, typed);
    const repository = new Repository<P>(
      config.name,
      typed,
      this.backend,
      this.ctx,
      (model) => this.registry.get(model),
      config.timestamps ? TIMESTAMP_FIELDS : null,
      softDelete,
      this.generateId,
      { state: this.txState, scoped: false },
      this.windows
    );
    // Registered by name so relations resolve their target regardless of definition order.
    this.registry.set(config.name, repository);
    this.defs.set(config.name, {
      properties: typed,
      timestamps: config.timestamps ? TIMESTAMP_FIELDS : null,
      softDelete,
      indexes: config.indexes
    });

    // Let schema-aware backends (IndexedDB, SQL) provision stores/indexes/columns from the metadata.
    // Registered now, with every window open, so a write issued before the journal is read still
    // lands in real columns; re-registered below once any window turns out to be closed.
    this.register(config.name);
    if (declaresWindow(typed) && !this.windowsLoaded) {
      this.windowsLoaded = true;
      this.windows.ready = this.refreshSchemaState().catch(() => {
        // An unreadable journal leaves every window open: right until the contract runs, and the
        // same state this process would have without the journal at all.
      });
    }

    return repository;
  }

  /**
   * Run `fn` as one atomic unit and commit everything it wrote, or roll back on error.
   *
   *   await orm.transaction(async () => { accounts.save(from); accounts.save(to); });
   *
   * On a backend with real transactions (Postgres / MySQL / SQLite), `fn` also receives a `tx`
   * **scope** whose repositories are **interactive**: a write you `persist()` through a `tx`
   * repository is visible to a later read through the same `tx` repository, before commit —
   *
   *   await orm.transaction(async (tx) => {
   *     const accounts = tx.repository<typeof accounts>("Account");
   *     const a = await accounts.get(id);           // reads on the tx connection
   *     accounts.save({ ...a, balance: a.balance - 10 });
   *     await accounts.persist();                   // now visible to the next tx read
   *   });
   *
   * Writes made through the *outer* repositories inside `fn` are folded into the same transaction, so
   * mixing the two still commits atomically. If `fn` throws, nothing is persisted, the DB transaction
   * rolls back, and queued writes are discarded — but instances you mutated in memory are not reverted
   * (re-fetch after a failure). On a backend without transactions (in-memory, IndexedDB) this degrades
   * to write-batching: `fn` runs, then its queued writes flush once; the `tx` scope still works but
   * offers no uncommitted-read isolation.
   */
  async transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    const prevMode = this.txState.mode;
    if (isTransactional(this.backend)) {
      return this.backend.transaction(async (txBackend) => {
        const scope = this.scopeOver(txBackend);
        this.txState.mode = "interactive";
        try {
          return await fn(scope.scope);
        } finally {
          this.txState.mode = prevMode;
          scope.dispose();
        }
      }, this.ctx);
    }
    const scope = this.scopeOver(this.backend);
    this.txState.mode = "batching";
    let result: T;
    try {
      result = await fn(scope.scope);
    } catch (error) {
      this.backend.discardPending?.();
      throw error;
    } finally {
      this.txState.mode = prevMode;
      scope.dispose();
    }
    await this.backend.persist(this.ctx);
    return result;
  }

  /**
   * Build a transaction scope over `backend` — a fresh set of repositories (one per defined model)
   * bound to it, resolving relations amongst themselves. Over a tx-scoped backend these are the
   * interactive repositories `fn` reads and writes through. `dispose()` unsubscribes them from the
   * change feed once the transaction ends (they're single-use).
   */
  private scopeOver(backend: Backend): { scope: TransactionScope; dispose: () => void } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new Map<string, Repository<any>>();
    const resolve = (model: string) => registry.get(model);
    for (const [name, def] of this.defs) {
      registry.set(
        name,
        new Repository(name, def.properties, backend, this.ctx, resolve, def.timestamps, def.softDelete, this.generateId, { state: this.txState, scoped: true }, this.windows)
      );
    }
    const scope: TransactionScope = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repository: <R extends Repository<any> = Repository<any>>(model: string): R => {
        const repository = registry.get(model);
        if (!repository) throw new Error(`No model named "${model}" is defined on this manager.`);
        return repository as unknown as R;
      }
    };
    return { scope, dispose: () => registry.forEach((repository) => repository.dispose()) };
  }

  /**
   * Escape hatch to the backend's native query language for what the compiler can't express — a
   * SQL string + params on the SQL backends, an aggregation pipeline on Mongo. Runs through the
   * backend's own connection and decorator stack (so it still reaches the real store the same way
   * every other operation does), and returns the driver rows untouched:
   *
   *   const rows = await orm.raw<{ region: string; n: number }>({
   *     sql: `SELECT region, COUNT(*) n FROM "sales" GROUP BY region`
   *   });
   *
   * The query is opaque, so row-level read policy is *not* woven into it — scope it yourself. Throws
   * if the configured backend has no raw hatch (e.g. in-memory / IndexedDB).
   */
  async raw<R extends Record<string, unknown> = Record<string, unknown>>(query: unknown, ctx?: Context): Promise<R[]> {
    if (!isRawQueryable(this.backend)) {
      throw new Error("The configured backend does not support raw queries.");
    }
    return (await this.backend.raw(query, ctx ?? this.ctx)) as R[];
  }

  /**
   * Apply a versioned migration set — renames, drops, type changes, index changes and data rewrites
   * the additive auto-provisioner can't do (ARCHITECTURE.md §13).
   *
   * Works on **every** backend, not just SQL: operations are portable, and a backend that can realize
   * one natively does, while the rest fall back to a shared record-rewriting reference. Run at
   * deploy/startup, before defining models against the new shape.
   *
   *   await orm.migrate([
   *     { name: "0001_add_status", up: (m) => m.addField("User", "status", "text", { fill: "active" }) },
   *     { name: "0012_fullname", schemaVersion: 7, up: (m) => m.renameField("User", "name", "fullName", "text") }
   *   ]);
   *
   * **This never destroys anything on its own.** A migration carrying a `schemaVersion` has its
   * destructive half withheld until `minSupportedSchemaVersion` reaches that number *and* the caller
   * passes `applyContracts` — until then those operations come back in the report's `deferred` and
   * `releasable` lists rather than running.
   */
  async migrate(migrations: Migration[], options: MigrateOptions = {}): Promise<MigrationReport> {
    await this.snapshotJournal();
    try {
      return await runMigrations(this.backend, migrations, this.runnerOptions(options));
    } finally {
      await this.refreshSchemaState().catch(() => {});
    }
  }

  /**
   * Re-read the migration journal: stop mirroring compatibility windows whose contract has run, and
   * bring the repositories' write baselines in line with any field a migration has since dropped or
   * renamed (otherwise a save of a record loaded earlier writes the dropped field back). `migrate()` and `rollback()` do this for their own process; a long-running
   * process whose store was migrated by another (a deploy step releasing a contract) calls it to pick
   * the change up, or is restarted without the retired property.
   */
  async refreshSchemaState(): Promise<void> {
    const rows = await new BackendJournal(migrationTarget(this.backend), this.ctx).load();
    // Journalled work this process hasn't seen yet changed the stored shape under its repositories.
    const applied = rows.filter((row) => row.status === "applied");
    if (this.seenApplied) {
      for (const row of applied) {
        if (this.seenApplied.has(journalKey(row))) continue;
        for (const op of row.ops) if ("model" in op) this.registry.get(op.model)?.storeChanged(op);
      }
    }
    this.seenApplied = new Set(applied.map(journalKey));
    const changed = this.windows.update(rows);
    for (const model of changed) {
      this.register(model);
      this.registry.get(model)?.windowsChanged();
    }
  }

  /** Remember which journal rows exist before this process migrates, so it can tell what ran. */
  private async snapshotJournal(): Promise<void> {
    if (this.seenApplied) return;
    try {
      const rows = await new BackendJournal(migrationTarget(this.backend), this.ctx).load();
      this.seenApplied = new Set(rows.filter((row) => row.status === "applied").map(journalKey));
    } catch {
      // unreadable: nothing to compare against, as for a process that never read it
    }
  }

  /** (Re-)register a model's layout under the current window state. */
  private register(model: string): void {
    const def = this.defs.get(model);
    if (!def || !isSchemaAware(this.backend)) return;
    void this.backend.registerModel(
      model,
      indexSpecs(def.properties, def.indexes),
      fieldSpecs(def.properties, (legacy) => this.windows.isClosed(model, legacy))
    );
  }

  /**
   * Revert exactly the `count` most recently applied migrations (default 1), newest first.
   *
   * Refuses the whole rollback, before anything runs, if one of them can't be reverted safely: no
   * `down`, a compatibility window still open, data destroyed that `down` cannot restore, or history
   * adopted from the legacy table (unless `rollbackAdopted`). See docs/MIGRATIONS.md.
   */
  async rollback(migrations: Migration[], count = 1, options: MigrateOptions = {}): Promise<MigrationReport> {
    await this.snapshotJournal();
    let report: MigrationReport | undefined;
    try {
      report = await rollbackMigrations(this.backend, migrations, count, this.runnerOptions(options));
      return report;
    } finally {
      // A rollback's `down` ops aren't journalled, so apply the ones that ran to the baselines directly.
      for (const name of report?.applied ?? []) {
        const migration = migrations.find((candidate) => candidate.name === name);
        if (!migration) continue;
        for (const op of await downOps(migration)) if ("model" in op) this.registry.get(op.model)?.storeChanged(op);
      }
      await this.refreshSchemaState().catch(() => {});
    }
  }

  /**
   * What `migrate` *would* do: the operations pending, what the gate is withholding, and what
   * `applyContracts` would destroy right now. Reads the store and writes nothing, so it is safe in
   * production and belongs in CI as the "what does this deploy touch?" check.
   */
  async plan(migrations: Migration[], options: MigrateOptions = {}): Promise<MigrationPlan> {
    return planMigrations(this.backend, migrations, this.runnerOptions(options));
  }

  /**
   * Fill in what the runner needs from this manager: the declared schema versions, and every defined
   * model's field/index layout — without which a generic rewrite through a schema-aware backend would
   * refuse (it can't write a columnar table whose columns it hasn't been told about).
   */
  private runnerOptions(options: MigrateOptions): RunnerOptions {
    const models: Record<string, { fields: FieldSpec[]; indexes: IndexSpec[] }> = {};
    for (const [name, def] of this.defs) {
      models[name] = {
        fields: fieldSpecs(def.properties, (legacy) => this.windows.isClosed(name, legacy)),
        indexes: indexSpecs(def.properties, def.indexes)
      };
    }
    return {
      ctx: this.ctx,
      ...(this.schema ? { schemaVersion: this.schema.schemaVersion } : {}),
      ...(this.schema?.minSupportedSchemaVersion !== undefined
        ? { minSupportedSchemaVersion: this.schema.minSupportedSchemaVersion }
        : {}),
      ...options,
      models: { ...models, ...(options.models ?? {}) }
    };
  }

  /**
   * A typed client for the server's command plane (task-based RPC), dispatched over `transport`. Type
   * it with the server's command-map type: `orm.commands<typeof commands>(transport)`. It integrates
   * with the data system automatically — the change events a command's writes produce come back with
   * the reply and are fed through this manager's backend, so a command-triggered mutation invalidates
   * the same query caches and drives the same reactive reloads as a local write (even over plain HTTP).
   */
  commands<M extends CommandMap>(transport: Transport): CommandClient<M> {
    return commandClient<M>(transport, {
      context: this.ctx,
      onChanges: (events) => {
        // Route into the backend's change feed when it can receive them (a RemoteBackend); for an
        // in-process backend the command already ran against it, so its own feed fired the events.
        if (isChangeDeliverable(this.backend)) this.backend.deliverChanges(events);
      }
    });
  }

  /** Look up a previously defined repository by model name. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repository(model: string): Repository<any> | undefined {
    return this.registry.get(model);
  }

  /**
   * A stable fingerprint of every model defined on this manager — the schema contract to compare
   * across a transport (`RemoteBackend.handshake`) so client/server drift is caught at connect time.
   */
  fingerprint(): string {
    const models: Record<string, PropertyMap> = {};
    for (const [name, repository] of this.registry) models[name] = repository.properties;
    return schemaFingerprint(models);
  }
}

/** Add default `date()` timestamp properties, but never clobber ones the caller declared. */
function withTimestamps(properties: PropertyMap): PropertyMap {
  return { [TIMESTAMP_FIELDS.createdAt]: date(), [TIMESTAMP_FIELDS.updatedAt]: date(), ...properties };
}

/** Add the nullable soft-delete marker property, unless the caller already declared one by that name. */
function withSoftDelete(properties: PropertyMap, field: string): PropertyMap {
  if (field in properties) return properties;
  return { ...properties, [field]: softDeleteMarker() };
}

/**
 * The scalar columns a backend should provision, in declaration order.
 *
 * The legacy half of a compatibility window is omitted once that window is `closed` — its contract
 * has dropped the field. Not when the floor is raised: until the release re-copies it, the legacy
 * column is the authoritative copy, and leaving it out of the layout would send every write-through
 * to the JSON overflow while the column itself goes stale.
 */
function fieldSpecs(properties: PropertyMap, closed: (legacy: string) => boolean = () => false): FieldSpec[] {
  const heldBy = new Map<string, string>();
  for (const name of Object.keys(properties)) {
    const property = properties[name] as AnyProperty;
    if (property.kind === "scalar" && property.mirrors && !closed(name)) heldBy.set(property.mirrors, name);
  }
  const fields: FieldSpec[] = [];
  for (const name of Object.keys(properties)) {
    const property = properties[name] as AnyProperty;
    if (property.kind !== "scalar") continue;
    if (property.mirrors && closed(name)) continue;
    const legacy = heldBy.get(name);
    fields.push(legacy ? { name, type: property.type, mirroredBy: legacy } : { name, type: property.type });
  }
  return fields;
}

function declaresWindow(properties: PropertyMap): boolean {
  return Object.values(properties).some((property) => (property as AnyProperty).kind === "scalar" && Boolean((property as ScalarProperty<unknown>).mirrors));
}

/**
 * Reject compatibility-window declarations that can't hold.
 *
 * Each of these is a case where mirroring would appear to work and then quietly produce wrong data,
 * so they're refused at definition time rather than discovered in production.
 */
function assertMirrorsAreSound(model: string, properties: PropertyMap): void {
  const scalars = new Set(
    Object.keys(properties).filter((name) => (properties[name] as AnyProperty).kind === "scalar")
  );
  for (const name of Object.keys(properties)) {
    const property = properties[name] as AnyProperty;
    if (property.kind !== "scalar" || !property.mirrors) continue;
    const canonical = property.mirrors;

    if (!scalars.has(canonical)) {
      throw new Error(
        `"${model}.${name}" mirrors "${canonical}", which is not a declared scalar property on this model.`
      );
    }
    if (property.deprecatedSince === undefined) {
      throw new Error(`"${model}.${name}" declares \`mirrors\` without \`deprecatedSince\`, so its window has no gate to close.`);
    }
    const target = properties[canonical] as AnyProperty;
    if (target.kind === "scalar" && (target.type !== property.type || (target.type === "scalar" && target.codec !== property.codec))) {
      // Mirroring copies stored values between the halves as they are. Different types would hand
      // the canonical field values in the legacy field's encoding — strings from an integer field,
      // comparisons that never match — and write them back into a field an older build reads.
      throw new Error(
        `"${model}.${name}" (${property.type}) mirrors "${canonical}" (${target.type}). Both halves of a window must have the same type; change a type by adding a new field and migrating values with a transform.`
      );
    }
    if (target.kind === "scalar" && target.unique) {
      // Two unique constraints over one logical value double-report in the uniqueness pre-check, and
      // the legacy half already carries the constraint until the contract runs.
      throw new Error(
        `"${model}.${canonical}" cannot be \`unique\` while "${name}" mirrors it — the legacy field carries the constraint until the window closes.`
      );
    }
    if (target.kind === "scalar" && target.mirrors) {
      throw new Error(
        `"${model}.${name}" mirrors "${canonical}", which mirrors "${target.mirrors}". Chained windows are not supported — close one before opening the next.`
      );
    }
  }
}

/** Index specs from per-scalar `index`/`unique` hints plus the model-level `indexes` declarations. */
function indexSpecs(properties: PropertyMap, declared: IndexDecl[] | undefined): IndexSpec[] {
  const specs: IndexSpec[] = [];
  for (const name of Object.keys(properties)) {
    const property = properties[name] as AnyProperty;
    if (property.kind === "scalar" && (property.index || property.unique)) {
      specs.push({ name, fields: [{ path: name }], unique: property.unique });
    }
  }
  for (const decl of declared ?? []) {
    const fields: IndexField[] = decl.fields.map((f) => (typeof f === "string" ? { path: f } : f));
    specs.push({
      name: decl.name ?? `${fields.map((f) => f.path).join("_")}_idx`,
      fields,
      unique: decl.unique,
      sparse: decl.sparse,
      ttlSeconds: decl.ttlSeconds,
      text: decl.text,
      where: decl.where?.serialize()
    });
  }
  return specs;
}

/** A journal row's identity across reads: re-applying a phase (after a rollback) is a new event. */
function journalKey(row: JournalRow): string {
  return `${row.name}\0${row.phase}\0${row.appliedAt}`;
}
