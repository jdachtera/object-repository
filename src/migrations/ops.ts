/**
 * The op IR: recording, classification, phase decomposition and fusion. Pure functions — nothing here
 * touches a store.
 *
 * `OpRecorder` replaces the original builder's eager "render DDL immediately" funnel: it collects
 * portable `MigrationOp` objects instead, which is what lets the same migration run on a SQL table, a
 * Mongo collection and an IndexedDB object store, and lets a plan be printed without executing it.
 */
import type { FieldSpec, IndexSpec } from "../core/Backend.ts";
import type { JsonValue } from "../core/types.ts";
import type { Expression } from "../expressions/Expression.ts";
import { MigrationBlockedError } from "./errors.ts";
import type { Migration, MigrationBlocker, MigrationBuilder, MigrationOp, PhasedOps, Phase, StoredType } from "./types.ts";

/** Collects the ops an `up`/`down` body declares, in call order. */
export class OpRecorder implements MigrationBuilder {
  readonly ops: MigrationOp[] = [];

  createModel(model: string, fields: FieldSpec[], indexes?: IndexSpec[]): void {
    this.ops.push({ kind: "createModel", model, fields, ...(indexes ? { indexes } : {}) });
  }
  dropModel(model: string): void {
    this.ops.push({ kind: "dropModel", model });
  }
  addField(model: string, field: string, type: StoredType, options?: { fill?: JsonValue }): void {
    this.ops.push({ kind: "addField", model, field, type, ...(options?.fill !== undefined ? { fill: options.fill } : {}) });
  }
  dropField(model: string, field: string): void {
    this.ops.push({ kind: "dropField", model, field });
  }
  renameField(model: string, from: string, to: string, type: StoredType): void {
    this.ops.push({ kind: "renameField", model, from, to, type });
  }
  retypeField(model: string, field: string, from: StoredType, to: StoredType): void {
    this.ops.push({ kind: "retypeField", model, field, from, to });
  }
  copyField(model: string, from: string, to: string, type: StoredType, options?: { overwrite?: boolean }): void {
    this.ops.push({ kind: "copyField", model, from, to, type, overwrite: options?.overwrite ?? false });
  }
  addIndex(model: string, index: IndexSpec): void {
    this.ops.push({ kind: "addIndex", model, index });
  }
  dropIndex(model: string, name: string): void {
    this.ops.push({ kind: "dropIndex", model, index: name });
  }
  transform(model: string, transformId: string, fields: string[], where?: Expression): void {
    this.ops.push({
      kind: "transform",
      model,
      transform: transformId,
      fields,
      ...(where ? { where: where.serialize() } : {})
    });
  }
  sql(statement: string, params: JsonValue[] = [], options?: { phase?: Phase }): void {
    this.ops.push({ kind: "rawSql", dialect: "*", statement, params, phase: options?.phase ?? "expand" });
  }

  // --- retained aliases ----------------------------------------------------------------------

  createTable(model: string, fields: FieldSpec[]): void {
    this.createModel(model, fields);
  }
  dropTable(model: string): void {
    this.dropModel(model);
  }
  addColumn(model: string, name: string, type: string): void {
    this.addField(model, name, asStoredType(type));
  }
  dropColumn(model: string, name: string): void {
    this.dropField(model, name);
  }
  renameColumn(model: string, from: string, to: string): void {
    this.renameField(model, from, to, "scalar");
  }
  alterColumnType(model: string, name: string, type: string): void {
    this.ops.push({ kind: "retypeField", model, field: name, from: "scalar", to: asStoredType(type) });
  }
  createIndex(model: string, name: string, columns: string[], unique = false, columnTypes?: Record<string, string>): void {
    this.ops.push({
      kind: "addIndex",
      model,
      index: { name, fields: columns.map((path) => ({ path })), ...(unique ? { unique: true } : {}) },
      ...(columnTypes ? { columnTypes } : {})
    });
  }
}

const STORED_TYPES: ReadonlySet<string> = new Set<StoredType>([
  "text",
  "integer",
  "float",
  "boolean",
  "date",
  "json",
  "array",
  "scalar"
]);

/** Narrow a caller-supplied type tag, tolerating the legacy aliases' loose `string`. */
function asStoredType(type: string): StoredType {
  return (STORED_TYPES.has(type) ? type : "scalar") as StoredType;
}

/**
 * The type lattice: which retypes preserve every existing value. Widening is `expand`; anything else
 * has to be authored as a rename to a new field, which gets a proper compatibility window.
 */
const WIDER_THAN: Readonly<Record<StoredType, readonly StoredType[]>> = {
  integer: ["float", "text", "json", "scalar"],
  float: ["text", "json", "scalar"],
  boolean: ["text", "json", "scalar"],
  date: ["text", "json", "scalar"],
  text: ["json", "scalar"],
  array: ["json", "scalar"],
  json: ["scalar"],
  scalar: []
};

/** Is `to` guaranteed to hold every value `from` can? (Reflexively true.) */
export function isWidening(from: StoredType, to: StoredType): boolean {
  return from === to || (WIDER_THAN[from]?.includes(to) ?? false);
}

/**
 * Which phase an op belongs to — a pure property of the op, so the same migration classifies
 * identically on every backend and in every process.
 *
 * A unique index is `contract`, which surprises people: it rejects writes an older, still-supported
 * build is entitled to make, and on IndexedDB a unique index over already-duplicate data aborts the
 * versionchange transaction, which surfaces through the open request and bricks the local database.
 *
 * A raw statement defaults to `expand` because the documented use is a backfill; defaulting it to
 * `contract` would silently stop running every backfill in every existing migration.
 */
export function classify(op: MigrationOp): Phase {
  switch (op.kind) {
    case "createModel":
    case "addField":
    case "copyField":
    case "transform":
      return "expand";
    case "retypeField":
      return isWidening(op.from, op.to) ? "expand" : "contract";
    case "addIndex":
      return op.index.unique ? "contract" : "expand";
    case "dropField":
    case "dropModel":
    case "dropIndex":
    case "renameField":
      return "contract";
    case "rawSql":
      return op.phase;
    default: {
      // An unrecognised op is treated as destructive — the deliberate inverse of the dialect's
      // silent fallback to an opaque column type. Withholding something harmless is recoverable;
      // running something destructive is not.
      return "contract";
    }
  }
}

/**
 * Record a migration's ops and split them by phase.
 *
 * `gateOpen` says whether this migration's contract may run in the same pass as its expand — i.e. no
 * compatibility window was requested. When it is open, an adjacent `copyField(overwrite:false)` +
 * `dropField` pair fuses back into a single `renameField`, so SQL keeps its O(1) metadata rename
 * rather than rewriting every row. Closing the window is what costs the fast path, and only then.
 */
export async function phaseOps(migration: Migration, gateOpen: boolean): Promise<PhasedOps> {
  const recorder = new OpRecorder();
  await migration.up(recorder);
  return splitPhases(recorder.ops, gateOpen);
}

/**
 * Record a migration's `down` ops, in the order authored.
 *
 * Deliberately phase-blind and un-reordered: a rollback runs whole, and the inverse of an expand is
 * usually a contract, so filtering by phase would run nothing. Author order also carries sequencing
 * a phase split would break — dropping an index before the column it covers, say.
 */
export async function downOps(migration: Migration): Promise<MigrationOp[]> {
  if (!migration.down) return [];
  const recorder = new OpRecorder();
  await migration.down(recorder);
  return recorder.ops;
}

/** Desugar and classify, unless the whole migration runs in one pass. Exported for tests. */
export function splitPhases(ops: MigrationOp[], gateOpen: boolean): PhasedOps {
  // Gate already open — no compatibility window was requested, so everything runs now and a
  // `renameField` stays whole, letting SQL do it as an O(1) metadata rename instead of rewriting
  // every row. Closing the window is what costs that fast path, and only then.
  if (gateOpen) return { expand: [...ops], contract: [] };
  return desugar(ops);
}

/**
 * Expand `renameField` into its four constituent ops across the two phases.
 *
 * The contract half leads with a re-copy that *does* overwrite. That step is the one everybody
 * forgets: old writers kept writing the legacy field for the entire window, so dropping it without
 * re-copying first destroys everything they wrote. The `overwrite` polarity flip between the halves
 * is the precise statement of that — don't clobber a new-build write during the window, do adopt the
 * legacy value at the end of it.
 */
function desugar(ops: MigrationOp[]): PhasedOps {
  const expand: MigrationOp[] = [];
  const contract: MigrationOp[] = [];
  for (const op of ops) {
    if (op.kind === "renameField") {
      expand.push({ kind: "addField", model: op.model, field: op.to, type: op.type });
      expand.push({ kind: "copyField", model: op.model, from: op.from, to: op.to, type: op.type, overwrite: false });
      contract.push({ kind: "copyField", model: op.model, from: op.from, to: op.to, type: op.type, overwrite: true });
      contract.push({ kind: "dropField", model: op.model, field: op.from, closes: { renamedTo: op.to } });
      continue;
    }
    (classify(op) === "expand" ? expand : contract).push(op);
  }
  return { expand, contract };
}

/** Refuse a narrowing retype before anything runs — the values it would destroy are not recoverable. */
export function assertNoNarrowingRetype(migration: string, ops: MigrationOp[]): void {
  const blockers: MigrationBlocker[] = [];
  for (const op of ops) {
    if (op.kind !== "retypeField" || isWidening(op.from, op.to)) continue;
    blockers.push({
      code: "NARROWING_RETYPE",
      migration,
      message: `"${migration}" narrows ${op.model}.${op.field} from ${op.from} to ${op.to}, which loses values. Author it as a rename to a new field so it gets a compatibility window.`
    });
  }
  if (blockers.length) throw new MigrationBlockedError(blockers);
}

/**
 * A stable content hash of an op list, for detecting that an already-applied migration was edited.
 * Key order is normalized so a cosmetic reshuffle isn't reported as drift.
 */
export function opsHash(ops: MigrationOp[]): string {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  const text = JSON.stringify(ops, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return value as unknown;
  });
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
