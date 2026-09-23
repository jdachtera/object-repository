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
import { acquireLock, BackendJournal, indexRows, rowId, validateMigrationNames, type JournalRow, type MigrationJournal, type SchemaState } from "./journal.ts";
import { downOps } from "./ops.ts";
import { destroysInWholePass, evaluateMigrations } from "./evaluate.ts";
import type {
  MigrateOptions,
  Migration,
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
  options: RunnerOptions & { ctx: Context; now: () => number; journal: MigrationJournal }
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
      await runPhase(backend, migration, decision.expand, "expand", options);
      await journal.write(row(migration, "expand", "applied", decision.expand, bodyHash, now()));
      report.expanded.push(migration.name);
      report.applied.push(migration.name);
      if (decision.whole && destroysInWholePass(decision.expand)) report.contracted.push(migration.name);
      // Record what the contract half owes *now*, while the migration is in front of us — that debt
      // has to outlive this source file being edited, reordered or deleted.
      await journal.write(
        decision.owed.length
          ? row(migration, "contract", "pending", decision.owed, bodyHash, now())
          : row(migration, "contract", "applied", [], bodyHash, now())
      );
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
        await runPhase(backend, migration, decision.owed, "contract", options);
        await journal.write(row(migration, "contract", "applied", decision.owed, bodyHash, now()));
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

  const adopted: JournalRow[] = [];
  for (const name of names) {
    for (const phase of ["expand", "contract"] as const) {
      adopted.push({
        name,
        phase,
        status: "applied",
        version: 0, // predates gating
        ops: [],
        opsHash: "", // unknown, so never reported as drift
        cursor: null,
        appliedAt: now()
      });
    }
  }
  return { rows: adopted, adopted: true };
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
