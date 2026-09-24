/**
 * The pre-flight: everything a run is going to do, and every reason it must refuse, decided before a
 * single operation touches the store.
 *
 * `runMigrations` executes exactly these decisions and `planMigrations` prints them, so a plan that
 * comes back clean is a run that won't be refused halfway through. Refusing *before* anything runs is
 * the point: a blocker discovered after an earlier migration's contract already executed is a
 * post-mortem, not a safeguard.
 */
import { classify, narrowingRetypes, opsHash, OpRecorder, splitPhases } from "./ops.ts";
import { rowId, type JournalRow } from "./journal.ts";
import type { DeferredContract, Migration, MigrationBlocker, MigrationOp } from "./types.ts";

/** What one migration's contract half will do in this run. */
export type ContractAction =
  /** Nothing is owed: already settled, or the migration has no destructive half. */
  | "none"
  /** Withheld: the gate hasn't reached this migration's version. */
  | "deferred"
  /** The gate permits it, but the caller didn't pass `applyContracts`. */
  | "releasable"
  /** Runs now. */
  | "run";

export interface MigrationDecision {
  migration: Migration;
  /** A pending contract from the journal whose migration is no longer declared. */
  orphaned: boolean;
  bodyHash: string;
  /** The expand ops to run now, or `null` when the expand was applied by an earlier run. */
  expand: MigrationOp[] | null;
  /** The expand runs both halves in one pass (see `splitPhases`), destructive ops included. */
  whole: boolean;
  /** What the contract half owes: recorded in the journal, or derived from the source. */
  owed: MigrationOp[];
  contract: ContractAction;
  /** Set when `owed` is non-empty and not yet settled. */
  outstanding: DeferredContract | null;
  /** Where an interrupted expand pass stopped, to resume rather than restart. */
  expandResume: ResumePoint | null;
  /** Where an interrupted contract pass stopped. */
  contractResume: ResumePoint | null;
}

/** An interrupted pass: the op it was on, and the last uuid whose page was persisted. */
export interface ResumePoint {
  op: number;
  after: string | null;
  /**
   * Set while a page was being written on a store that can't commit a page together with its marker:
   * the records after `after`, up to and including `through`, may be written, partly written, or not.
   */
  inFlight?: { through: string };
}

export function encodeResume(point: ResumePoint): string {
  return JSON.stringify(point);
}

function decodeResume(cursor: string | null): ResumePoint | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<ResumePoint>;
    if (typeof parsed.op !== "number") return null;
    const point: ResumePoint = { op: parsed.op, after: typeof parsed.after === "string" ? parsed.after : null };
    if (typeof parsed.inFlight?.through === "string") point.inFlight = { through: parsed.inFlight.through };
    return point;
  } catch {
    return null;
  }
}

export interface Evaluation {
  decisions: MigrationDecision[];
  blockers: MigrationBlocker[];
}

/** Is this migration's contract half permitted to run? */
export function gateOpen(migration: Partial<Migration>, minSupported: number): boolean {
  return migration.schemaVersion === undefined || minSupported >= migration.schemaVersion;
}

export async function evaluateMigrations(
  migrations: Migration[],
  rows: Map<string, JournalRow>,
  minSupported: number,
  applyContracts: boolean
): Promise<Evaluation> {
  const decisions: MigrationDecision[] = [];
  const blockers: MigrationBlocker[] = [];
  const declared = new Set(migrations.map((migration) => migration.name));

  for (const migration of migrations) {
    const recorder = new OpRecorder();
    await migration.up(recorder);
    blockers.push(...narrowingRetypes(migration.name, recorder.ops));
    const bodyHash = opsHash(recorder.ops);
    const open = gateOpen(migration, minSupported);

    const expandRow = rows.get(rowId(migration.name, "expand"));
    const contractRow = rows.get(rowId(migration.name, "contract"));
    const expandApplied = expandRow?.status === "applied";

    if (!expandApplied && contractRow?.status === "applied") {
      blockers.push({
        code: "JOURNAL_INCONSISTENT",
        migration: migration.name,
        message: `The journal records a contract for "${migration.name}" but no expand. The store's migration log is inconsistent; repair it before migrating.`
      });
      continue;
    }

    let expand: MigrationOp[] | null = null;
    let whole = false;
    let owed: MigrationOp[];
    let expandResume: ResumePoint | null = null;
    let contractResume: ResumePoint | null = null;

    if (expandRow?.status === "pending") {
      // An expand that was interrupted part-way. Finish exactly the ops it started — the gate or
      // `applyContracts` may have moved since, and re-deciding would re-run ops it already did.
      if (expandRow.opsHash && expandRow.opsHash !== bodyHash) {
        blockers.push({
          code: "CHECKSUM_DRIFT",
          migration: migration.name,
          message: `"${migration.name}" was interrupted part-way, and its operations have changed since. Restore the version that started, let it finish, then add a new migration.`
        });
      }
      expand = expandRow.ops;
      whole = ranWhole(migration, expandRow);
      owed = whole ? [] : splitPhases(recorder.ops, false).contract;
      expandResume = decodeResume(expandRow.cursor);
    } else if (!expandApplied) {
      whole = migration.schemaVersion === undefined || (open && applyContracts);
      const phases = splitPhases(recorder.ops, whole);
      expand = phases.expand;
      owed = phases.contract;
    } else {
      const drifted = Boolean(expandRow.opsHash) && expandRow.opsHash !== bodyHash;
      if (drifted) {
        blockers.push({
          code: "CHECKSUM_DRIFT",
          migration: migration.name,
          message: `"${migration.name}" has already been applied, but its operations have changed since. Add a new migration instead of editing an applied one.`
        });
      }
      if (contractRow?.status === "applied") {
        owed = [];
      } else if (contractRow?.status === "pending" && contractRow.ops.length) {
        // The journal's record wins: the source may have been edited or reordered since.
        owed = contractRow.ops;
        contractResume = decodeResume(contractRow.cursor);
      } else if (drifted) {
        owed = []; // already blocked; the edited source is no guide to what is owed
      } else {
        // No usable record — a crash between the two row writes, or a corrupt ops payload. The
        // source is unchanged (the hash matches), so re-derive the debt from it rather than drop it.
        owed = ranWhole(migration, expandRow) ? [] : splitPhases(recorder.ops, false).contract;
      }
    }

    decisions.push({
      ...decide(migration, false, bodyHash, expand, whole, owed, open, applyContracts, minSupported),
      expandResume,
      contractResume
    });
  }

  // Debts whose migration has since been deleted from the array. The journal recorded what they owe
  // precisely so that deleting the source can't quietly cancel them.
  for (const row of rows.values()) {
    if (row.phase !== "contract" || row.status !== "pending" || declared.has(row.name)) continue;
    const migration: Migration = { name: row.name, schemaVersion: row.version, up: () => {} };
    const open = gateOpen(migration, minSupported);
    const decision = {
      ...decide(migration, true, row.opsHash, null, false, row.ops, open, applyContracts, minSupported),
      contractResume: decodeResume(row.cursor)
    };
    const unrecoverable = !row.ops.length || row.ops.some((op) => op.kind === "transform");
    if (unrecoverable && (decision.contract === "run" || !row.ops.length)) {
      blockers.push({
        code: "UNRECOVERABLE_CONTRACT",
        migration: row.name,
        message: row.ops.length
          ? `"${row.name}" still owes a contract that runs a record transform, but the migration is no longer declared, so the transform's code is gone. Restore the migration to the array to release it.`
          : `"${row.name}" still owes a contract, but the migration is no longer declared and the journal's record of it is unreadable. Restore the migration to the array so the debt can be re-derived.`
      });
    }
    decisions.push(decision);
  }

  return { decisions, blockers };
}

function decide(
  migration: Migration,
  orphaned: boolean,
  bodyHash: string,
  expand: MigrationOp[] | null,
  whole: boolean,
  owed: MigrationOp[],
  open: boolean,
  applyContracts: boolean,
  minSupported: number
): MigrationDecision {
  const contract: ContractAction = !owed.length ? "none" : !open ? "deferred" : applyContracts ? "run" : "releasable";
  const outstanding: DeferredContract | null = owed.length
    ? {
        migration: migration.name,
        gate: migration.schemaVersion ?? 0,
        minSupported,
        ops: owed,
        reason: describe(migration, owed, minSupported),
        ...(orphaned ? { orphaned: true } : {})
      }
    : null;
  return {
    migration,
    orphaned,
    bodyHash,
    expand,
    whole,
    owed,
    contract,
    outstanding,
    expandResume: null,
    contractResume: null
  };
}

/** Did an earlier run take this migration's expand as a single, whole pass? Then nothing is owed. */
function ranWhole(migration: Migration, expandRow: JournalRow): boolean {
  return migration.schemaVersion === undefined || expandRow.ops.some((op) => classify(op) === "contract");
}

/** Does a whole pass include anything destructive, so the run should report it as a contract too? */
export function destroysInWholePass(ops: MigrationOp[]): boolean {
  return ops.some((op) => classify(op) === "contract");
}

function describe(migration: Migration, ops: MigrationOp[], minSupported: number): string {
  const what = ops
    .map((op) => {
      if (op.kind === "dropField") return `drops ${op.model}.${op.field}`;
      if (op.kind === "dropModel") return `drops ${op.model}`;
      if (op.kind === "dropIndex") return `drops index ${op.index} on ${op.model}`;
      if (op.kind === "addIndex") return `adds unique index ${op.index.name} on ${op.model}`;
      if (op.kind === "copyField") return `overwrites ${op.model}.${op.to} from ${op.from}`;
      if (op.kind === "transform") return `rewrites ${op.model} via "${op.transform}"`;
      return op.kind;
    })
    .join(", ");
  const gate = migration.schemaVersion ?? 0;
  return `"${migration.name}" ${what} at schema version ${gate}; minSupportedSchemaVersion is ${minSupported}.`;
}
