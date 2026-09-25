/**
 * The runner: the version gate, the per-phase state machine, and dispatch between a backend's native
 * lowering and the portable reference executor.
 *
 * The gate is one predicate — `migration.schemaVersion === undefined || minSupported >= schemaVersion`
 * — applied to a migration's *contract* half only. Expands always run. That asymmetry is the whole
 * feature: shipping a migration and destroying the shape it replaced are two separate, deliberate acts,
 * usually separated by however long it takes every old build and every offline client to go away.
 *
 * `applyContracts` defaults to **false**, so a bare `migrate()` in a deploy script can only ever add.
 * Contracts whose gate has cleared are reported as `releasable` and wait for someone to say so.
 */
import type { Backend } from "../core/Backend.ts";
import { isMigrationLowering, isSchemaAware, isTransactional, migrationTarget } from "../core/Backend.ts";
import type { Context } from "../core/types.ts";
import { SYSTEM_CONTEXT } from "../core/types.ts";
import { generateUuid } from "../core/uuid.ts";
import { applyOp, reappliesSafely, type ExecuteOptions } from "./execute.ts";
import { MigrationBlockedError, MigrationInterruptedError, SchemaVersionError } from "./errors.ts";
import {
  acquireLock,
  BackendJournal,
  indexRows,
  MigrationLockedError,
  validateMigrationNames,
  type JournalRow,
  type Lease,
  type MigrationJournal,
  type SchemaState
} from "./journal.ts";
import { downOps } from "./ops.ts";
import { destroysInWholePass, encodeResume, evaluateMigrations, type ResumePoint } from "./evaluate.ts";
import type {
  MigrationBlocker,
  MigrateOptions,
  Migration,
  MigrationOp,
  MigrationReport,
  Phase
} from "./types.ts";

export { MigrationLockedError };

export interface RunnerOptions extends MigrateOptions {
  /** Identifies this runner in the lease row. Defaults to a fresh id per call. */
  lockOwner?: string;
  /** The build's declared schema version. `0` means ungated — today's behaviour. */
  schemaVersion?: number;
  /** Supplied for tests; defaults to the wall clock. */
  now?: () => number;

  /**
   * Called as soon as each migration's `down` has run and its journal rows are gone — so a caller can
   * react to a rollback that fails part-way, for the migrations it did revert.
   */
  onRolledBack?: (migration: Migration) => void | Promise<void>;
  /** Overrides the journal implementation (the SQL backends supply their own table-backed one). */
  journal?: MigrationJournal;
}

const DEFAULT_BATCH = 500;

export { gateOpen } from "./evaluate.ts";

/**
 * Apply every migration that hasn't run yet.
 *
 * Expands apply immediately. A contract applies only when its gate has cleared *and* the caller passed
 * `applyContracts`. Everything withheld comes back in the report — never silently skipped, which is
 * the failure this whole mechanism exists to prevent.
 */
export async function runMigrations(
  backend: Backend,
  migrations: Migration[],
  options: RunnerOptions = {}
): Promise<MigrationReport> {
  assertUniqueNames(migrations);
  const store = migrationTarget(backend);
  const ctx = options.ctx ?? SYSTEM_CONTEXT;
  const now = options.now ?? Date.now;
  const journal = options.journal ?? new BackendJournal(store, ctx);

  const models = { ...(options.models ?? {}) }; // followed as ops run; the caller's copy is untouched
  return withLease(store, ctx, now, { ...options, models }, (lease, registered) =>
    applyAll(store, migrations, { ...options, models, ctx, now, journal, lease, registered })
  );
}

/**
 * Hold the lease for the duration of `body`.
 *
 * On failure, whatever the body left queued is discarded first: the release's own persist (on a store
 * without native leases) would otherwise commit it. And a release that fails never masks the error
 * that got us here.
 */
async function withLease<T>(
  backend: Backend,
  ctx: Context,
  now: () => number,
  options: RunnerOptions,
  body: (lease: Lease | null, registered: Set<string>) => Promise<T>
): Promise<T> {
  const lease = options.skipLock ? null : await acquireLock(backend, ctx, now, options.lockOwner ?? generateUuid());
  if (!options.skipLock && !lease) {
    throw new MigrationLockedError(
      "Another process is already migrating this store. Run migrations from one place — a deploy step, not application startup."
    );
  }

  let failed = false;
  const registered = new Set<string>();
  try {
    return await body(lease, registered);
  } catch (error) {
    failed = true;
    backend.discardPending?.();
    throw error;
  } finally {
    // On a transactional store `registered` holds only what committed phases registered: a failed
    // phase's registration was made in its rolled-back scope and never reached this backend, and
    // re-registering it here would re-provision the very columns the rollback just removed.
    await restoreRegistrations(backend, registered, options);
    try {
      await lease?.release();
    } catch (releaseError) {
      if (!failed) throw releaseError; // eslint-disable-line no-unsafe-finally
    }
  }
}

/**
 * The body of a run, once the lease is held.
 *
 * Two passes. The first decides everything and collects every refusal; only if there are none does the
 * second touch the store. A refusal found halfway through would arrive after the migrations before it
 * had already run — including, possibly, the very contract it was meant to stop.
 */
async function applyAll(
  backend: Backend,
  migrations: Migration[],
  options: Running
): Promise<MigrationReport> {
  const { now, journal } = options;
  const state = await resolveVersions(journal, options);

  const rows = indexRows(await adoptLegacyHistory(backend, journal, now));
  const { decisions, blockers } = await evaluateMigrations(
    migrations,
    rows,
    state.minSupportedSchemaVersion,
    options.applyContracts ?? false
  );
  if (blockers.length) throw new MigrationBlockedError(blockers);

  const report: MigrationReport = {
    applied: [],
    skipped: [],
    expanded: [],
    contracted: [],
    deferred: [],
    releasable: []
  };

  for (const decision of decisions) {
    const { migration, bodyHash } = decision;

    if (decision.expand) {
      // The expand's completion and what the contract half owes are recorded together, with the
      // phase's own writes where the store allows: that debt has to outlive this source file being
      // edited, reordered or deleted, so it must never be lost between two separate writes.
      await runPhase(backend, migration, decision.expand, "expand", options, {
        resume: decision.expandResume,
        progress: (cursor) => row(migration, "expand", "pending", decision.expand!, bodyHash, now(), cursor),
        done: () => [
          row(migration, "expand", "applied", decision.expand!, bodyHash, now()),
          decision.owed.length
            ? row(migration, "contract", "pending", decision.owed, bodyHash, now())
            : row(migration, "contract", "applied", [], bodyHash, now())
        ]
      });
      report.expanded.push(migration.name);
      report.applied.push(migration.name);
      if (decision.whole && destroysInWholePass(decision.expand)) report.contracted.push(migration.name);
    } else if (decision.contract === "none" && !decision.orphaned) {
      report.skipped.push(migration.name);
    }

    switch (decision.contract) {
      case "none":
        break;
      case "deferred":
        report.deferred.push(decision.outstanding!);
        break;
      case "releasable":
        report.releasable.push(decision.outstanding!);
        break;
      case "run":
        await runPhase(backend, migration, decision.owed, "contract", options, {
          resume: decision.contractResume,
          progress: (cursor) => row(migration, "contract", "pending", decision.owed, bodyHash, now(), cursor),
          done: () => [row(migration, "contract", "applied", decision.owed, bodyHash, now())]
        });
        report.contracted.push(migration.name);
        if (!report.applied.includes(migration.name)) report.applied.push(migration.name);
        break;
    }
  }

  // The declared version is always recorded — it's what catches an older build being run against a
  // newer store. The *floor*, though, only rises when contracts have actually been released against
  // it, so a fat-fingered environment variable that nothing acted on leaves no trace to live with.
  const storedFloor = state.stored?.minSupportedSchemaVersion ?? 0;
  await journal.writeSchemaState({
    schemaVersion: Math.max(state.schemaVersion, state.stored?.schemaVersion ?? 0),
    minSupportedSchemaVersion: report.contracted.length
      ? Math.max(storedFloor, state.minSupportedSchemaVersion)
      : storedFloor
  });

  return report;
}

/** Revert the most recently applied migrations that declare a `down`. */
export async function rollbackMigrations(
  backend: Backend,
  migrations: Migration[],
  count = 1,
  options: RunnerOptions = {}
): Promise<MigrationReport> {
  assertUniqueNames(migrations);
  const store = migrationTarget(backend);
  const ctx = options.ctx ?? SYSTEM_CONTEXT;
  const now = options.now ?? Date.now;
  const journal = options.journal ?? new BackendJournal(store, ctx);
  // A rollback rewrites the store exactly as a run does, so it takes the same lease: a rollback racing
  // a deploy's migrate would otherwise interleave with it.
  const models = { ...(options.models ?? {}) };
  return withLease(store, ctx, now, { ...options, models }, (lease, registered) =>
    rollbackAll(store, migrations, count, { ...options, models, ctx, now, journal, lease, registered })
  );
}

/**
 * The body of a rollback, once the lease is held.
 *
 * The targets are the `count` most recently applied migrations — exactly those, in that order. One
 * that can't be reverted safely refuses the whole rollback before anything runs. Skipping past it
 * would revert an *older* migration instead, underneath a newer one that may depend on it.
 */
async function rollbackAll(backend: Backend, migrations: Migration[], count: number, options: Running): Promise<MigrationReport> {
  const { journal } = options;
  // A store upgraded from the SQL-only mechanism may have its history only in the legacy table: adopt
  // it first, as a run does, or a rollback before the first run would find nothing and do nothing.
  const rows = await adoptLegacyHistory(backend, journal, options.now);
  const report: MigrationReport = { applied: [], skipped: [], expanded: [], contracted: [], deferred: [], releasable: [] };
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  const position = new Map(migrations.map((migration, index) => [migration.name, index]));

  // Newest first, by the store's own history: declaration order can have been reshuffled since. Rows
  // written within the same millisecond tie on `appliedAt`, so declaration order breaks the tie —
  // never the reverse, which would pick the oldest of a batch applied together.
  const targets = rows
    .filter((row) => row.status === "applied" && row.phase === "expand")
    .sort((a, b) => b.appliedAt - a.appliedAt || (position.get(b.name) ?? -1) - (position.get(a.name) ?? -1))
    .slice(0, count);

  const blockers: MigrationBlocker[] = [];
  for (const target of targets) {
    const refusal = rollbackRefusal(target, byName.get(target.name), rows, options);
    if (refusal) blockers.push({ code: "ROLLBACK_REFUSED", migration: target.name, message: refusal });
  }
  if (blockers.length) throw new MigrationBlockedError(blockers);

  for (const target of targets) {
    const migration = byName.get(target.name)!;
    await runPhase(backend, migration, await downOps(migration), "expand", options, {
      resume: null,
      progress: null,
      done: () => [],
      // Contract first: interrupted between the two, the journal still reads as a valid state (an
      // expand whose contract is owed) rather than a contract with no expand, which is refused.
      forget: [
        { name: migration.name, phase: "contract" },
        { name: migration.name, phase: "expand" }
      ]
    });
    report.applied.push(migration.name);
    await options.onRolledBack?.(migration);
  }

  return report;
}

/** Why rolling back this applied migration would be unsafe, or `null` if it can be. */
function rollbackRefusal(
  expand: JournalRow,
  migration: Migration | undefined,
  rows: JournalRow[],
  options: RunnerOptions
): string | null {
  const name = JSON.stringify(expand.name);
  if (!migration) return `${name} is the most recently applied migration but is not declared, so its \`down\` is unknown.`;
  if (!migration.down) return `${name} declares no \`down\`.`;
  if (!expand.opsHash && !expand.ops.length && !options.rollbackAdopted) {
    // Adopted from an earlier tracking table: no record of what it did, nor of when relative to its
    // neighbours. Its `down` may undo far more than intended (dropping the table it created).
    return `${name} was adopted from the legacy tracking table, so what it did isn't recorded. Pass \`rollbackAdopted: true\` to run its \`down\` anyway.`;
  }
  const contract = rows.find((row) => row.name === expand.name && row.phase === "contract");
  if (contract?.status === "pending" && contract.ops.length) {
    // Mid-window, the legacy field is the authoritative copy: a `down` reversing the rename would
    // copy the new build's stale mirror over what older builds have been writing.
    return `${name} is mid-window — its contract hasn't run, and the legacy field still holds the authoritative values. Roll forward instead, or release the contract first.`;
  }
  // If what ran destroyed data, `down` can restore the schema but not the values: it would hand back
  // an empty column. (A rename's drop is exempt — its values live on under the new name.)
  if (rows.some((row) => row.name === expand.name && row.status === "applied" && destroysData(row.ops))) {
    return `${name} destroyed data its \`down\` can't restore.`;
  }
  return null;
}

/**
 * Adopt an earlier mechanism's history into the journal, once, before anything is planned.
 *
 * A database migrated under the original SQL-only tracking table has a populated
 * `_object_repository_migrations` the portable journal has never seen. Left alone, the first run under
 * the new mechanism would consider every historical migration pending and re-apply it — against live
 * data. Each adopted name is recorded as **both** phases applied, because it ran under pre-gate
 * semantics where `up()` executed in full, and with an empty hash so it is exempt from drift checks
 * (there is no record of what its ops were).
 */
async function adoptLegacyHistory(
  backend: Backend,
  journal: MigrationJournal,
  now: () => number
): Promise<JournalRow[]> {
  const { rows, adopted } = await readHistory(backend, journal, now);
  if (adopted) for (const entry of rows) await journal.write(entry);
  return rows;
}

/**
 * The journal's rows, or — for a store that has none yet — the rows adopting its legacy history
 * would write. Reads only, so `plan()` sees exactly what a run would.
 */
export async function readHistory(
  backend: Backend,
  journal: MigrationJournal,
  now: () => number
): Promise<{ rows: JournalRow[]; adopted: boolean }> {
  const existing = await journal.load();
  if (existing.length > 0) return { rows: existing, adopted: false };

  const lowering = backend as Partial<{ legacyMigrationNames(): Promise<string[]> }>;
  if (typeof lowering.legacyMigrationNames !== "function") return { rows: existing, adopted: false };

  let names: string[];
  try {
    names = await lowering.legacyMigrationNames();
  } catch {
    return { rows: existing, adopted: false }; // no legacy table, or it isn't readable — a greenfield store, then
  }
  if (!names.length) return { rows: existing, adopted: false };

  // Stamped in the legacy table's own order, one millisecond apart, so the history keeps its sequence:
  // a single shared stamp would leave "most recent" to chance.
  const adopted: JournalRow[] = [];
  const base = now();
  names.forEach((name, index) => {
    for (const phase of ["expand", "contract"] as const) {
      adopted.push({
        name,
        phase,
        status: "applied",
        version: 0, // predates gating
        ops: [],
        opsHash: "", // unknown, so never reported as drift
        cursor: null,
        appliedAt: base - names.length + index
      });
    }
  });
  return { rows: adopted, adopted: true };
}

/** The runner's options once resolved, plus the lease it holds. */
type Running = RunnerOptions & {
  ctx: Context;
  now: () => number;
  journal: MigrationJournal;
  lease: Lease | null;
  registered: Set<string>;
};

/**
 * Give every model a pass registered with a reduced index set its full registration back, so the
 * store enforces its unique constraints again. A unique index that can't be built yet — its de-dupe
 * contract hasn't been released — is left as `define()` would leave it; the run's outcome stands.
 */
async function restoreRegistrations(backend: Backend, registered: Set<string>, options: RunnerOptions): Promise<void> {
  if (!isSchemaAware(backend)) return;
  for (const model of registered) {
    const schema = options.models?.[model];
    if (!schema) continue;
    try {
      await backend.registerModel(model, schema.indexes, schema.fields);
    } catch {
      // see above
    }
  }
}

/** How a phase is journalled. */
interface PhaseRecord {
  /** Where an interrupted attempt stopped. */
  resume: ResumePoint | null;
  /** The in-progress row marking a resume point, or `null` for a pass that can't resume (a rollback). */
  progress: ((cursor: string) => JournalRow) | null;
  /** The rows recording the phase as complete. */
  done: () => JournalRow[];
  /** Rows to delete on completion (a rollback un-applies them). */
  forget?: Array<{ name: string; phase: Phase }>;
}

/**
 * Run one phase's ops and journal it.
 *
 * On a store with real transactions the ops and the journal rows commit together, so a crash leaves
 * either the whole phase recorded or none of it — never a column added with no record of why, which
 * the retry would then trip over. Statements issued inside the transaction run on its own connection,
 * outside the executor's per-statement timeout, so a long backfill can't time out client-side while
 * it quietly commits server-side.
 *
 * Elsewhere, each page of a record pass is persisted together with a resume marker, so an interrupted
 * pass continues from where it stopped rather than re-applying a non-idempotent transform to pages
 * that already had it.
 */
async function runPhase(
  backend: Backend,
  migration: Migration,
  ops: MigrationOp[],
  phase: Phase,
  options: Running,
  record: PhaseRecord
): Promise<void> {
  const { journal, lease } = options;
  // Always prove the lease before a contract: that is the step that must never run twice.
  await lease?.renew(phase === "contract");

  // MySQL commits on DDL — the phase's own, or a re-registration's — taking whatever is queued with it
  // and running the rest outside any transaction. There, journal page by page like any other store.
  if (isTransactional(backend) && backend.capabilities.transactions && backend.capabilities.transactionalDdl !== false) {
    // What this phase registers, and how it moves the run's layouts, count only once it commits. Each
    // phase commits on its own, so an earlier phase's registration stands even when a later one fails,
    // and must still be restored when the run ends.
    const registered = new Set<string>();
    const layouts = options.models ? { ...options.models } : undefined;
    let journalled = false;
    try {
      await backend.transaction(async (tx) => {
        await executeOps(tx, migration, ops, phase, { ...options, registered }, null, {
          heartbeat: async () => lease?.renew(false, tx)
        });
        const scoped = journal.within?.(tx);
        if (scoped) {
          await settle(scoped, record);
          journalled = true;
        }
      }, options.ctx);
    } catch (error) {
      if (options.models && layouts) {
        for (const model of Object.keys(options.models)) delete options.models[model];
        Object.assign(options.models, layouts);
      }
      throw error;
    }
    for (const model of registered) options.registered.add(model);
    if (!journalled) await settle(journal, record);
    return;
  }

  const progress = record.progress;
  const at = (op: number) => (cursor: string) => progress!(encodeResume({ op, after: cursor }));
  // A marker staged with its page shares the page's flush — atomic only where that flush is (not a
  // Mongo bulkWrite per collection, say).
  const sharedFlush = !!journal.stage && backend.capabilities.transactions;
  // A natively lowered op is journalled as done in the transaction that holds its data changes, so a
  // retry resumes after it rather than running a JSON-quoting UPDATE twice.
  const recordLowered = (index: number) => async (tx: Backend) => {
    const scoped = journal.within?.(tx) ?? journal;
    await scoped.write(progress!(encodeResume({ op: index + 1, after: null })));
  };
  await executeOps(backend, migration, ops, phase, options, record.resume, (index) =>
    progress && sharedFlush
      ? {
          // Queued now, persisted with the page it describes.
          checkpoint: async (cursor) => journal.stage!(at(index)(cursor)),
          heartbeat: async () => lease?.renew(),
          recordLowered: recordLowered(index)
        }
      : progress
        ? {
            recordLowered: recordLowered(index),
            // The marker can't share the page's flush. Record it after the page lands; and for an op
            // that must not run twice, mark the page in flight first, so a resume knows which records
            // it can't vouch for instead of silently applying them again.
            ...(reappliesSafely(ops[index]!)
              ? {}
              : {
                  beforePage: async (after: string | null, through: string) =>
                    journal.write(progress(encodeResume({ op: index, after, inFlight: { through } })))
                }),
            heartbeat: async (cursor) => {
              await journal.write(at(index)(cursor));
              await lease?.renew();
            }
          }
        : { heartbeat: async () => lease?.renew() }
  );
  await settle(journal, record);
}

async function settle(journal: MigrationJournal, record: PhaseRecord): Promise<void> {
  for (const entry of record.done()) await journal.write(entry);
  for (const entry of record.forget ?? []) await journal.remove(entry.name, entry.phase);
}

type PageHooks = Pick<ExecuteOptions, "checkpoint" | "beforePage"> & {
  heartbeat?: (cursor: string) => Promise<void>;
  /** Journal a natively lowered op as done, inside the transaction that commits its data changes. */
  recordLowered?: (tx: Backend) => Promise<void>;
};

/** Run `ops` in order, preferring a backend's native lowering and falling back to the reference. */
async function executeOps(
  backend: Backend,
  migration: Migration,
  ops: MigrationOp[],
  phase: Phase,
  options: Running,
  resume: ResumePoint | null,
  hooks: PageHooks | ((index: number) => PageHooks)
): Promise<void> {
  // The ops before the resume point ran in an earlier attempt: this run's layouts must still follow
  // them, or a re-registration would re-provision a field one of them dropped.
  for (let index = 0; index < (resume?.op ?? 0); index++) followLayout(options, ops[index]!);
  for (let index = resume?.op ?? 0; index < ops.length; index++) {
    const op = ops[index]!;
    const { checkpoint, heartbeat, beforePage, recordLowered } = typeof hooks === "function" ? hooks(index) : hooks;
    const lowered = !isMigrationLowering(backend)
      ? null
      : recordLowered && backend.lowerMigrationOpRecorded
        ? await backend.lowerMigrationOpRecorded(op, options.ctx, recordLowered)
        : await backend.lowerMigrationOp(op, options.ctx);
    if (lowered) {
      followLayout(options, op);
      continue; // the backend did it natively — same effect, lower cost
    }

    let after = resume && index === resume.op ? resume.after : null;
    if (resume?.inFlight && index === resume.op && !reappliesSafely(op)) {
      // The interrupted run may have written some, all or none of this page: only the operator can say.
      if (!options.interruptedPage) throw new MigrationInterruptedError(migration.name, op, resume.after, resume.inFlight.through);
      if (options.interruptedPage === "skip") after = resume.inFlight.through;
    }
    let cursor = "";
    await applyOp(backend, op, {
      ctx: options.ctx,
      batchSize: options.batchSize ?? DEFAULT_BATCH,
      migration: migration.name,
      phase,
      models: options.models ?? {},
      transforms: migration.transforms ?? {},
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      backendName: backend.constructor?.name ?? "this backend",
      after,
      ...(beforePage ? { beforePage } : {}),
      ...(checkpoint
        ? {
            checkpoint: async (at: string) => {
              cursor = at;
              await checkpoint(at);
            }
          }
        : { checkpoint: (at: string) => void (cursor = at) }),
      ...(heartbeat ? { heartbeat: () => heartbeat(cursor) } : {}),
      registered: options.registered
    });
    followLayout(options, op);
  }
}

/**
 * Keep the run's model layouts in step with the ops it has applied. The layouts come from the
 * application's model definitions, which still declare a field a contract has just dropped; handed
 * to a later registration unchanged, the additive provisioner would re-create that column, empty.
 */
function followLayout(options: Running, op: MigrationOp): void {
  // A model the migration itself creates has no definition to come from: its layout is the one it
  // was created with, so later ops on it in the same run can register and write it.
  if (op.kind === "createModel" && options.models && !options.models[op.model]) {
    options.models[op.model] = { fields: [...op.fields], indexes: [...(op.indexes ?? [])] };
    return;
  }
  if (!("model" in op) || !options.models?.[op.model]) return;
  const layout = options.models[op.model]!;
  if (op.kind === "retypeField") {
    // The field now holds the new type: a later registration under the old one would encode and decode
    // it wrongly against a column that has already changed.
    options.models[op.model] = { ...layout, fields: layout.fields.map((field) => (field.name === op.field ? { ...field, type: op.to } : field)) };
  } else if (op.kind === "addField" && !layout.fields.some((field) => field.name === op.field)) {
    options.models[op.model] = { ...layout, fields: [...layout.fields, { name: op.field, type: op.type }] };
  } else if (op.kind === "dropModel") {
    delete options.models[op.model];
  } else if (op.kind === "dropField") {
    options.models[op.model] = { ...layout, fields: layout.fields.filter((field) => field.name !== op.field) };
  } else if (op.kind === "addIndex") {
    options.models[op.model] = { ...layout, indexes: [...layout.indexes.filter((i) => i.name !== op.index.name), op.index] };
  } else if (op.kind === "dropIndex") {
    options.models[op.model] = { ...layout, indexes: layout.indexes.filter((i) => i.name !== op.index) };
  } else if (op.kind === "renameField") {
    // The field ends up as `to`, of the rename's type. The application usually declares `to` already
    // (it defines the model as it is after the migration): keep that entry rather than drop it.
    const renamed = { name: op.to, type: op.type };
    const fields = layout.fields.filter((field) => field.name !== op.from && field.name !== op.to);
    const at = layout.fields.findIndex((field) => field.name === op.to || field.name === op.from);
    fields.splice(at < 0 ? fields.length : Math.min(at, fields.length), 0, renamed);
    options.models[op.model] = { ...layout, fields };
  }
}

interface ResolvedVersions extends SchemaState {
  stored: SchemaState | null;
}

/**
 * Reconcile the declared versions against what the store records.
 *
 * `minSupportedSchemaVersion` defaults to `schemaVersion - 1`, so merely bumping the version never
 * destroys anything on the same deploy — releasing a contract always takes a second, explicit step.
 */
async function resolveVersions(journal: MigrationJournal, options: RunnerOptions): Promise<ResolvedVersions> {
  const resolved = checkVersions(await journal.readSchemaState(), options);
  if (resolved.error) throw resolved.error;
  return resolved;
}

/** The declared versions, reconciled against the store's; `error` says why a run must refuse them. */
export function checkVersions(
  stored: SchemaState | null,
  options: Pick<RunnerOptions, "schemaVersion" | "minSupportedSchemaVersion">
): ResolvedVersions & { error: SchemaVersionError | null; code: "INVALID_SCHEMA_VERSION" | "VERSION_REGRESSION" | null } {
  const schemaVersion = options.schemaVersion ?? 0;
  const minSupported = options.minSupportedSchemaVersion ?? Math.max(0, schemaVersion - 1);
  const resolved = { schemaVersion, minSupportedSchemaVersion: minSupported, stored };
  const fail = (code: "INVALID_SCHEMA_VERSION" | "VERSION_REGRESSION", message: string) => ({
    ...resolved,
    error: new SchemaVersionError(schemaVersion, minSupported, message),
    code
  });

  if (!Number.isInteger(schemaVersion) || !Number.isInteger(minSupported)) {
    return fail("INVALID_SCHEMA_VERSION", "Schema versions must be integers.");
  }
  if (minSupported > schemaVersion) {
    return fail(
      "INVALID_SCHEMA_VERSION",
      `minSupportedSchemaVersion (${minSupported}) cannot exceed schemaVersion (${schemaVersion}).`
    );
  }
  if (stored && schemaVersion < stored.schemaVersion) {
    return fail(
      "VERSION_REGRESSION",
      `This build declares schema version ${schemaVersion} but the store is already at ${stored.schemaVersion}. Running an older build against a newer store would re-apply migrations it has no record of.`
    );
  }
  return { ...resolved, error: null, code: null };
}

/**
 * A journal row.
 *
 * `ops` records what actually ran (or, on a pending contract, what is still owed). `opsHash` covers
 * the migration's **authored body**, deliberately *not* the phase-split result: the split depends on
 * where the gate stood at the time, so hashing it would report a false edit the moment the gate moved.
 */
function row(
  migration: Migration,
  phase: Phase,
  status: "applied" | "pending",
  ops: MigrationOp[],
  bodyHash: string,
  at: number,
  cursor: string | null = null
): JournalRow {
  return {
    name: migration.name,
    phase,
    status,
    version: migration.schemaVersion ?? 0,
    ops,
    opsHash: bodyHash,
    cursor,
    appliedAt: at
  };
}

/**
 * Did these ops destroy data a `down` cannot bring back?
 *
 * A rename's drop doesn't count: the values live on under the new name, so reversing it restores them.
 * A bare drop does — `down` can re-create the column, but not what was in it.
 */
function destroysData(ops: MigrationOp[]): boolean {
  return ops.some((op) => (op.kind === "dropField" && !op.closes) || op.kind === "dropModel");
}

export function assertUniqueNames(migrations: Migration[]): void {
  validateMigrationNames(migrations.map((migration) => migration.name));
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.name)) throw new Error(`Duplicate migration name: ${JSON.stringify(migration.name)}`);
    seen.add(migration.name);
  }
}
