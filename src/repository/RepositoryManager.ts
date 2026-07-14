import type { Backend, IndexSpec, IndexField, FieldSpec } from "../core/Backend.ts";
import { isRawQueryable, isSchemaAware, isTransactional } from "../core/Backend.ts";
import { isMigratable, type Migration, type MigrationReport } from "../backends/sql/migrate.ts";
import { commandClient, isChangeDeliverable, type CommandClient, type CommandMap } from "../transport/command.ts";
import type { Transport } from "../core/Transport.ts";
import type { Expression } from "../expressions/Expression.ts";
import type { Context } from "../core/types.ts";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly registry = new Map<string, Repository<any>>();
  /** Enough of each model's definition to rebuild it over a tx-scoped backend (interactive transactions). */
  private readonly defs = new Map<
    string,
    { properties: PropertyMap; timestamps: TimestampFields | null; softDelete: SoftDeleteConfig | null }
  >();
  /** Shared with every repository so an immediately-persisting write can refuse to escape a transaction. */
  private readonly txState: TransactionState = { mode: "none" };

  constructor(options: RepositoryManagerOptions = {}) {
    this.backend = options.backend ?? new InMemoryBackend();
    this.ctx = options.context ?? SYSTEM_CONTEXT;
    this.generateId = options.generateId;
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
    const repository = new Repository<P>(
      config.name,
      typed,
      this.backend,
      this.ctx,
      (model) => this.registry.get(model),
      config.timestamps ? TIMESTAMP_FIELDS : null,
      softDelete,
      this.generateId,
      { state: this.txState, scoped: false }
    );
    // Registered by name so relations resolve their target regardless of definition order.
    this.registry.set(config.name, repository);
    this.defs.set(config.name, { properties: typed, timestamps: config.timestamps ? TIMESTAMP_FIELDS : null, softDelete });

    // Let schema-aware backends (IndexedDB, SQL) provision stores/indexes/columns from the metadata.
    if (isSchemaAware(this.backend)) {
      void this.backend.registerModel(config.name, indexSpecs(typed, config.indexes), fieldSpecs(typed));
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
        new Repository(name, def.properties, backend, this.ctx, resolve, def.timestamps, def.softDelete, this.generateId, { state: this.txState, scoped: true })
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
   * Apply a versioned migration set for non-additive schema changes the auto-provisioner can't do —
   * rename/drop columns, type changes, index DDL, and raw data backfills. Each migration runs once
   * (tracked in `_object_repository_migrations`) inside a transaction where the engine supports transactional DDL.
   * Run at deploy/startup, before defining models against the new shape. Throws if the backend has no
   * migration support (in-memory / IndexedDB).
   *
   *   await orm.migrate([
   *     { name: "0001_add_status", up: (m) => m.addColumn("User", "status", "text") },
   *     { name: "0002_backfill",   up: (m) => m.sql(`UPDATE "User" SET "status" = 'active'`) }
   *   ]);
   */
  async migrate(migrations: Migration[]): Promise<MigrationReport> {
    if (!isMigratable(this.backend)) {
      throw new Error("The configured backend does not support migrations.");
    }
    return this.backend.migrate(migrations);
  }

  /** Revert the `count` most-recently-applied migrations that declare a `down` (default 1). */
  async rollback(migrations: Migration[], count = 1): Promise<MigrationReport> {
    if (!isMigratable(this.backend)) {
      throw new Error("The configured backend does not support migrations.");
    }
    return this.backend.rollback(migrations, count);
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

/** The scalar columns of a model (name + stored-type tag), in declaration order — for columnar backends. */
function fieldSpecs(properties: PropertyMap): FieldSpec[] {
  const fields: FieldSpec[] = [];
  for (const name of Object.keys(properties)) {
    const property = properties[name] as AnyProperty;
    if (property.kind === "scalar") fields.push({ name, type: property.type });
  }
  return fields;
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
