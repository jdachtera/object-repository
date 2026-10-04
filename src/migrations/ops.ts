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
  copyField(model: string, from: string, to: string, type: StoredType, options?: { overwrite?: boolean; fromType?: StoredType }): void {
    this.ops.push({
      kind: "copyField",
      model,
      from,
      to,
      type,
      overwrite: options?.overwrite ?? false,
      ...(options?.fromType ? { fromType: options.fromType } : {})
    });
  }
  addIndex(model: string, index: IndexSpec): void {
    this.ops.push({ kind: "addIndex", model, index });
  }
  dropIndex(model: string, name: string): void {
    this.ops.push({ kind: "dropIndex", model, index: name });
  }
  transform(model: string, transformId: string, fields: string[], where?: Expression, options?: { phase?: Phase }): void {
    this.ops.push({
      kind: "transform",
      model,
      transform: transformId,
      fields,
      ...(where ? { where: where.serialize() } : {}),
      ...(options?.phase ? { phase: options.phase } : {})
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
    // No `from`: this alias never knew the original type, and claiming one would either fabricate a
    // widening check or fail every legacy migration that used it.
    this.ops.push({ kind: "retypeField", model, field: name, to: asStoredType(type) });
  }
  createIndex(model: string, name: string, columns: string[], unique = false, columnTypes?: Record<string, string>): void {
    this.ops.push({
      kind: "addIndex",
      model,
      index: { name, fields: columns.map((path) => ({ path })), ...(unique ? { unique: true } : {}) },
      ...(columnTypes ? { columnTypes } : {}),
      exactName: true
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
  // `uuid` was the original builder's name for a key column: text, which an index can cover (MySQL
  // prefixes it), where the `scalar` fallback is a LONGTEXT it can't.
  if (type === "uuid") return "text";
  return (STORED_TYPES.has(type) ? type : "scalar") as StoredType;
}

/**
 * The type lattice: which retypes preserve every existing value. Widening is `expand`; anything else
 * has to be authored as a new field of the new type, with the values converted by a transform.
 */
const WIDER_THAN: Readonly<Record<StoredType, readonly StoredType[]>> = {
  integer: ["float", "text", "json", "scalar"],
  float: ["text", "json", "scalar"],
  boolean: ["text", "json", "scalar"],
  date: ["text", "json", "scalar"],
  text: ["json", "scalar"],
  array: ["json", "scalar"],
  // Not `json` → `scalar`: the stored JSON text would stay a string, so the runtime value would change
  // from the object it encodes to the text itself.
  json: [],
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
 * A copy that overwrites is `contract`: it clobbers whatever the target field already holds.
 *
 * A transform is `contract` unless its author declared it `expand`. It can delete a record or
 * overwrite a value, and only running it would tell which.
 *
 * A raw statement defaults to `expand` because the documented use is a backfill; defaulting it to
 * `contract` would silently stop running every backfill in every existing migration.
 */
export function classify(op: MigrationOp): Phase {
  switch (op.kind) {
    case "createModel":
    case "addField":
      return "expand";
    case "copyField":
      return op.overwrite ? "contract" : "expand";
    case "transform":
      return op.phase ?? "contract";
    case "retypeField":
      // An unstated `from` (the legacy alias) can't be judged, so it keeps its historical behaviour
      // of simply applying rather than being withheld as destructive.
      return op.from === undefined || isWidening(op.from, op.to) ? "expand" : "contract";
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

/** Record a migration's ops and split them by phase. See `splitPhases` for `whole`. */
export async function phaseOps(migration: Migration, whole: boolean): Promise<PhasedOps> {
  const recorder = new OpRecorder();
  await migration.up(recorder);
  return splitPhases(recorder.ops, whole);
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

/**
 * Desugar and classify, unless the whole migration runs in one pass. Exported for tests.
 *
 * `whole` is true only when both halves are going to run right now anyway: an ungated migration, or a
 * gated one whose gate is open *and* whose contracts the caller asked to apply. Then a `renameField`
 * stays whole, so SQL does it as an O(1) metadata rename instead of rewriting every row, and ops run
 * in the order they were written. An open gate alone is not enough: without `applyContracts` the
 * destructive half must still be split off and withheld.
 */
export function splitPhases(ops: MigrationOp[], whole: boolean): PhasedOps {
  if (whole) return { expand: [...ops], contract: [] };
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
      // Both halves of a rename hold the rename's type. Said explicitly, because the legacy field is in
      // no layout once the application has moved on: read by the catalog alone, a scalar's JSON text
      // comes back as plain text, and the release copies `"0"` over `0`.
      expand.push({ kind: "copyField", model: op.model, from: op.from, to: op.to, type: op.type, overwrite: false, fromType: op.type });
      contract.push({ kind: "copyField", model: op.model, from: op.from, to: op.to, type: op.type, overwrite: true, exact: true, fromType: op.type });
      contract.push({ kind: "dropField", model: op.model, field: op.from, closes: { renamedTo: op.to } });
      continue;
    }
    (classify(op) === "expand" ? expand : contract).push(op);
  }
  return { expand, contract };
}

/** Narrowing retypes, refused before anything runs — the values they would destroy are not recoverable. */
export function narrowingRetypes(migration: string, ops: MigrationOp[]): MigrationBlocker[] {
  const blockers: MigrationBlocker[] = [];
  for (const op of ops) {
    if (op.kind !== "retypeField" || op.from === undefined || isWidening(op.from, op.to)) continue;
    blockers.push({
      code: "NARROWING_RETYPE",
      migration,
      message: `"${migration}" narrows ${op.model}.${op.field} from ${op.from} to ${op.to}, which loses values. Add a new field of the new type and convert the values with a transform, then retire the old field.`
    });
  }
  return blockers;
}

/**
 * A versioned migration runs in two halves: its expand steps now, its contract steps (drops, an
 * overwriting copy, a unique index, a rename's release) only once released. A contract step written
 * *before* an expand step that touches the same field therefore runs after it, not before — and the
 * migration means something else: a field dropped and re-added is deleted by the late drop, a retyped
 * rename target gets the late re-copy in the old type, a transform sees a field that was meant to be
 * gone. Refused, naming the pair: reorder them, or put the later step in a migration of its own.
 */
export function phaseReorders(migration: string, ops: MigrationOp[]): MigrationBlocker[] {
  const blockers: MigrationBlocker[] = [];
  const deferred: Array<{ op: MigrationOp; touches: string[] }> = [];
  for (const op of ops) {
    const touches = touched(op);
    if (classify(op) === "expand") {
      const earlier = deferred.find((entry) => overlaps(entry.touches, touches));
      if (earlier) {
        blockers.push({
          code: "PHASE_REORDER",
          migration,
          message: `"${migration}" has a ${describeOp(earlier.op)} before a ${describeOp(op)} on the same field. With a schemaVersion the first is a contract step, withheld until released, so it would run after the second rather than before. Reorder them, or move the second into a later migration.`
        });
      }
    } else {
      deferred.push({ op, touches });
    }
  }
  return blockers;
}

/** The `model\0field` keys an op reads or writes; `model\0*` for one that sees whole records. */
function touched(op: MigrationOp): string[] {
  if (!("model" in op)) return [];
  const key = (field: string) => `${op.model}\0${field}`;
  switch (op.kind) {
    case "addField":
    case "dropField":
    case "retypeField":
      return [key(op.field)];
    case "renameField":
    case "copyField":
      return [key(op.from), key(op.to)];
    case "addIndex":
      return [...op.index.fields.map((field) => key(field.path)), key(`#${op.index.name}`)];
    case "dropIndex":
      return [key(`#${op.index}`)];
    default:
      return [key("*")]; // a transform, a model created or dropped
  }
}

function overlaps(a: string[], b: string[]): boolean {
  const model = (key: string) => key.slice(0, key.indexOf("\0"));
  return a.some((x) => b.some((y) => x === y || (model(x) === model(y) && (x.endsWith("\0*") || y.endsWith("\0*")))));
}

function describeOp(op: MigrationOp): string {
  if (!("model" in op)) return op.kind;
  switch (op.kind) {
    case "addField":
    case "dropField":
    case "retypeField":
      return `${op.kind}(${op.model}.${op.field})`;
    case "renameField":
    case "copyField":
      return `${op.kind}(${op.model}.${op.from} → ${op.to})`;
    case "addIndex":
      return `addIndex(${op.model}.${op.index.name})`;
    case "dropIndex":
      return `dropIndex(${op.model}.${op.index})`;
    case "transform":
      return `transform(${op.model}, ${op.transform})`;
    default:
      return `${op.kind}(${op.model})`;
  }
}

/** Refuse a narrowing retype before anything runs. */
export function assertNoNarrowingRetype(migration: string, ops: MigrationOp[]): void {
  const blockers = narrowingRetypes(migration, ops);
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
