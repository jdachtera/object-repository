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
import { isMigrationLowering } from "../core/Backend.ts";
import type { Context } from "../core/types.ts";
import { SYSTEM_CONTEXT } from "../core/types.ts";
import { generateUuid } from "../core/uuid.ts";
import { applyOp, type ExecuteOptions } from "./execute.ts";
import { MigrationBlockedError, SchemaVersionError } from "./errors.ts";
import { acquireLock, BackendJournal, indexRows, rowId, type JournalRow, type MigrationJournal, type SchemaState } from "./journal.ts";
import { assertNoNarrowingRetype, downOps, opsHash, splitPhases, OpRecorder } from "./ops.ts";
import type {
  DeferredContract,
  MigrateOptions,
  Migration,
  MigrationBlocker,
  MigrationOp,
  MigrationReport,
  Phase
} from "./types.ts";

/** Thrown when another runner already holds the migration lease. */
export class MigrationLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationLockedError";
  }
}

export interface RunnerOptions extends MigrateOptions {
  /**
   * Skip the cooperative lease that stops two replicas migrating at once. Only for a caller that
   * already guarantees a single runner (a dedicated deploy step); leaving it on is the safe default.
   */
  skipLock?: boolean;
  /** Identifies this runner in the lease row. Defaults to a fresh id per call. */
  lockOwner?: string;
  /** The build's declared schema version. `0` means ungated — today's behaviour. */
  schemaVersion?: number;
  /** Supplied for tests; defaults to the wall clock. */
  now?: () => number;
  /** Overrides the journal implementation (the SQL backends supply their own table-backed one). */
  journal?: MigrationJournal;
}

const DEFAULT_BATCH = 500;

/** Is this migration's contract half permitted to run? */
export function gateOpen(migration: Migration, minSupported: number): boolean {
  return migration.schemaVersion === undefined || minSupported >= migration.schemaVersion;
}

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
  const ctx = options.ctx ?? SYSTEM_CONTEXT;
  const now = options.now ?? Date.now;
  const journal = options.journal ?? new BackendJournal(backend, ctx);

  const lock = options.skipLock
    ? null
    : await acquireLock(backend, ctx, now, options.lockOwner ?? generateUuid());
  if (!options.skipLock && !lock) {
    throw new MigrationLockedError(
      "Another process is already migrating this store. Run migrations from one place — a deploy step, not application startup."
    );
  }

  try {
    return await applyAll(backend, migrations, { ...options, ctx, now, journal });
  } finally {
    await lock?.release();
  }
}

/** The body of a run, once the lease is held. */
async function applyAll(
  backend: Backend,
  migrations: Migration[],
  options: RunnerOptions & { ctx: Context; now: () => number; journal: MigrationJournal }
): Promise<MigrationReport> {
  const { ctx, now, journal } = options;
  const state = await resolveVersions(journal, options);

  const rows = indexRows(await adoptLegacyHistory(backend, journal, now));
  const report: MigrationReport = {
    applied: [],
    skipped: [],
    expanded: [],
    contracted: [],
    deferred: [],
    releasable: []
  };
  const blockers: MigrationBlocker[] = [];

  for (const migration of migrations) {
    const open = gateOpen(migration, state.minSupportedSchemaVersion);
    const recorder = new OpRecorder();
    await migration.up(recorder);
    assertNoNarrowingRetype(migration.name, recorder.ops);
    const phases = splitPhases(recorder.ops, open);
    const bodyHash = opsHash(recorder.ops);

    const expandRow = rows.get(rowId(migration.name, "expand"));
    const contractRow = rows.get(rowId(migration.name, "contract"));

    if (expandRow?.status !== "applied" && contractRow?.status === "applied") {
      throw new Error(
        `Journal for "${migration.name}" records a contract with no expand. The store's migration log is inconsistent.`
      );
    }

    // --- expand -------------------------------------------------------------------------------
    if (expandRow?.status !== "applied") {
      await runPhase(backend, migration, phases.expand, "expand", { ...options, ctx, now, journal });
      await journal.write(row(migration, "expand", "applied", phases.expand, bodyHash, now()));
      report.expanded.push(migration.name);
      report.applied.push(migration.name);
      // Record what the contract half owes *now*, while the migration is in front of us — that debt
      // has to outlive this source file being edited, reordered or deleted.
      await journal.write(
        phases.contract.length
          ? row(migration, "contract", "pending", phases.contract, bodyHash, now())
          : row(migration, "contract", "applied", [], bodyHash, now())
      );
      if (!phases.contract.length) continue;
    } else {
      const drift = driftBlocker(migration, expandRow, bodyHash);
      if (drift) blockers.push(drift);
      if (contractRow?.status === "applied") {
        report.skipped.push(migration.name);
        continue;
      }
    }

    // --- contract -----------------------------------------------------------------------------
    // Prefer the ops the journal recorded when the expand ran: the migration in front of us may have
    // been edited or deleted since, and the store's debt is what actually has to be settled.
    const owed = contractRow?.status === "pending" && contractRow.ops.length ? contractRow.ops : phases.contract;
    if (!owed.length) continue;

    const outstanding: DeferredContract = {
      migration: migration.name,
      gate: migration.schemaVersion ?? 0,
      minSupported: state.minSupportedSchemaVersion,
      ops: owed,
      reason: describe(migration, owed, state.minSupportedSchemaVersion)
    };

    if (!gateOpen(migration, state.minSupportedSchemaVersion)) {
      report.deferred.push(outstanding);
      continue;
    }
    if (!options.applyContracts) {
      report.releasable.push(outstanding);
      continue;
    }

    await runPhase(backend, migration, owed, "contract", { ...options, ctx, now, journal });
    await journal.write(row(migration, "contract", "applied", owed, bodyHash, now()));
    report.contracted.push(migration.name);
    if (!report.applied.includes(migration.name)) report.applied.push(migration.name);
  }

  if (blockers.length) throw new MigrationBlockedError(blockers);

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
  const ctx = options.ctx ?? SYSTEM_CONTEXT;
  const now = options.now ?? Date.now;
  const journal = options.journal ?? new BackendJournal(backend, ctx);
  const rows = await journal.load();
  const report: MigrationReport = { applied: [], skipped: [], expanded: [], contracted: [], deferred: [], releasable: [] };
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));

  // Walk the order things were actually applied in, newest first. Declaration order can have been
  // reshuffled since it ran, so the store's own history is the only reliable inverse ordering.
  const order = rows
    .filter((row) => row.status === "applied" && row.phase === "expand" && byName.has(row.name))
    .sort((a, b) => b.appliedAt - a.appliedAt);

  for (const row of order) {
    if (report.applied.length >= count) break;
    const migration = byName.get(row.name)!;
    if (!migration.down) {
      report.skipped.push(migration.name);
      continue;
    }
    // If what already ran destroyed data, `down` can restore the schema but not the values, so
    // rolling back would quietly hand back an empty column. (A rename's drop is exempt — its values
    // live on under the new name.)
    const destroyed = rows.some(
      (candidate) => candidate.name === migration.name && candidate.status === "applied" && destroysData(candidate.ops)
    );
    if (destroyed) {
      report.skipped.push(migration.name);
      continue;
    }

    await runPhase(backend, migration, await downOps(migration), "expand", { ...options, ctx, now, journal });
    await journal.remove(migration.name, "expand");
    await journal.remove(migration.name, "contract");
    report.applied.push(migration.name);
  }

  return report;
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
  const existing = await journal.load();
  if (existing.length > 0) return existing;

  const lowering = backend as Partial<{ legacyMigrationNames(): Promise<string[]> }>;
  if (typeof lowering.legacyMigrationNames !== "function") return existing;

  let names: string[];
  try {
    names = await lowering.legacyMigrationNames();
  } catch {
    return existing; // no legacy table, or it isn't readable — a greenfield store, then
  }
  if (!names.length) return existing;

  const adopted: JournalRow[] = [];
  for (const name of names) {
    for (const phase of ["expand", "contract"] as const) {
      const entry: JournalRow = {
        name,
        phase,
        status: "applied",
        version: 0, // predates gating
        ops: [],
        opsHash: "", // unknown, so never reported as drift
        cursor: null,
        appliedAt: now()
      };
      await journal.write(entry);
      adopted.push(entry);
    }
  }
  return adopted;
}

/** Run one phase's ops, preferring a backend's native lowering and falling back to the reference. */
async function runPhase(
  backend: Backend,
  migration: Migration,
  ops: MigrationOp[],
  phase: Phase,
  options: RunnerOptions & { ctx: Context; now: () => number; journal: MigrationJournal }
): Promise<void> {
  const execute: ExecuteOptions = {
    ctx: options.ctx,
    batchSize: options.batchSize ?? DEFAULT_BATCH,
    migration: migration.name,
    phase,
    models: options.models ?? {},
    transforms: migration.transforms ?? {},
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    backendName: backend.constructor?.name ?? "this backend"
  };

  for (const op of ops) {
    const lowered = isMigrationLowering(backend) ? await backend.lowerMigrationOp(op, options.ctx) : null;
    if (lowered) continue; // the backend did it natively — same effect, lower cost
    await applyOp(backend, op, execute);
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
  const stored = await journal.readSchemaState();
  const schemaVersion = options.schemaVersion ?? 0;
  const minSupported = options.minSupportedSchemaVersion ?? Math.max(0, schemaVersion - 1);

  if (!Number.isInteger(schemaVersion) || !Number.isInteger(minSupported)) {
    throw new SchemaVersionError(schemaVersion, minSupported, "Schema versions must be integers.");
  }
  if (minSupported > schemaVersion) {
    throw new SchemaVersionError(
      schemaVersion,
      minSupported,
      `minSupportedSchemaVersion (${minSupported}) cannot exceed schemaVersion (${schemaVersion}).`
    );
  }
  if (stored && schemaVersion < stored.schemaVersion) {
    throw new SchemaVersionError(
      schemaVersion,
      minSupported,
      `This build declares schema version ${schemaVersion} but the store is already at ${stored.schemaVersion}. Running an older build against a newer store would re-apply migrations it has no record of.`
    );
  }

  return { schemaVersion, minSupportedSchemaVersion: minSupported, stored };
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
  at: number
): JournalRow {
  return {
    name: migration.name,
    phase,
    status,
    version: migration.schemaVersion ?? 0,
    ops,
    opsHash: bodyHash,
    cursor: null,
    appliedAt: at
  };
}

/** An already-applied migration whose authored body no longer hashes the same was edited after the fact. */
function driftBlocker(migration: Migration, applied: JournalRow, bodyHash: string): MigrationBlocker | null {
  if (!applied.opsHash) return null; // seeded from a legacy tracking table — no hash to compare against
  if (applied.opsHash === bodyHash) return null;
  return {
    code: "CHECKSUM_DRIFT",
    migration: migration.name,
    message: `"${migration.name}" has already been applied, but its operations have changed since. Add a new migration instead of editing an applied one.`
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

function describe(migration: Migration, ops: MigrationOp[], minSupported: number): string {
  const what = ops
    .map((op) => {
      if (op.kind === "dropField") return `drops ${op.model}.${op.field}`;
      if (op.kind === "dropModel") return `drops ${op.model}`;
      if (op.kind === "dropIndex") return `drops index ${op.index} on ${op.model}`;
      if (op.kind === "addIndex") return `adds unique index ${op.index.name} on ${op.model}`;
      return op.kind;
    })
    .join(", ");
  const gate = migration.schemaVersion ?? 0;
  return `"${migration.name}" ${what} at schema version ${gate}; minSupportedSchemaVersion is ${minSupported}.`;
}

function assertUniqueNames(migrations: Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.name)) throw new Error(`Duplicate migration name: ${JSON.stringify(migration.name)}`);
    seen.add(migration.name);
  }
}
