/**
 * Random migration scenarios for the property-based suites: a starting layout, records of it (with
 * absent fields, stored nulls, awkward strings and floats), and a sequence of valid migration steps
 * planned against the layout the steps before each one left.
 */
import fc from "fast-check";
import { isWidening } from "../migrations/ops.js";
import { everything } from "../migrations/paging.js";
import { SYSTEM_CONTEXT, type JsonObject, type JsonValue } from "../core/types.js";
import type { Backend, FieldSpec } from "../core/Backend.js";
import type { Migration, MigrationBuilder, RecordTransform, StoredType } from "../migrations/types.js";

const ctx = SYSTEM_CONTEXT;
export const MODEL = "Prop";

// --- values -------------------------------------------------------------------------------------

export const TYPES: StoredType[] = ["text", "integer", "float", "boolean", "array", "scalar", "json"];

const awkwardText = fc.constantFrom("", "42", "-7", "1e15", "0.1", "abc", 'say "hi"', "null", "true", "[1]", "ünïcødé", " padded ");
const plainText = (max: number) => fc.string({ maxLength: max }).filter((s) => !s.includes("\u0000"));
// Engines store doubles exactly, but -0 is not worth chasing (JSON can't carry it).
const finiteDouble = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e18, max: 1e18 }).filter((n) => !Object.is(n, -0));

export function valueOf(type: StoredType): fc.Arbitrary<JsonValue> {
  switch (type) {
    case "text":
      return fc.oneof(awkwardText, plainText(12));
    case "integer":
      return fc.integer({ min: -1_000_000, max: 1_000_000 });
    case "float":
      return fc.oneof(fc.constantFrom(1e15, 1e-7, 0.1, 1.5, -2.25, 3), finiteDouble);
    case "boolean":
      return fc.boolean();
    case "array":
      return fc.array(fc.oneof(awkwardText, plainText(6)), { maxLength: 3 });
    case "scalar":
      return fc.oneof(awkwardText, fc.integer({ min: -1000, max: 1000 }), fc.boolean());
    case "json":
      // The json() codec stores JSON text.
      return fc.oneof(fc.integer(), awkwardText, fc.array(fc.integer(), { maxLength: 3 })).map((v) => JSON.stringify(v));
    default:
      return fc.constant(null);
  }
}

// --- layouts, records, steps --------------------------------------------------------------------

export const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** A starting layout: three to five fields of random types. */
export const layoutArb: fc.Arbitrary<FieldSpec[]> = fc
  .uniqueArray(fc.constantFrom(...NAMES), { minLength: 3, maxLength: 5 })
  .chain((names) => fc.tuple(...names.map(() => fc.constantFrom(...TYPES))).map((types) => names.map((name, i) => ({ name, type: types[i]! }))));

/** Records of a layout: each field absent, null, or a value of its type. */
export function recordsOf(layout: FieldSpec[], max = 6): fc.Arbitrary<JsonObject[]> {
  const record = fc.record(
    Object.fromEntries(layout.map((field) => [field.name, fc.option(fc.option(valueOf(field.type as StoredType), { nil: null }), { nil: undefined })]))
  );
  return fc.array(record, { minLength: 1, maxLength: max }).map((rows) =>
    rows.map((row, i) => {
      const out: JsonObject = { uuid: `r${String(i).padStart(2, "0")}` };
      for (const [key, value] of Object.entries(row)) if (value !== undefined) out[key] = value as JsonValue;
      return out;
    })
  );
}

/** An intent, turned into a valid step against whatever layout the steps before it left. */
export interface Intent {
  kind: "add" | "drop" | "rename" | "copy" | "retype" | "transform";
  pick: number;
  pick2: number;
  type: StoredType;
  fill: boolean;
  overwrite: boolean;
  seed: number;
}

export function intentArb(kinds: Intent["kind"][] = ["add", "drop", "rename", "copy", "retype"]): fc.Arbitrary<Intent> {
  return fc.record({
    kind: fc.constantFrom(...kinds),
    pick: fc.nat(),
    pick2: fc.nat(),
    type: fc.constantFrom(...TYPES),
    fill: fc.boolean(),
    overwrite: fc.boolean(),
    seed: fc.nat()
  });
}

export type Step = (m: MigrationBuilder) => void;

export interface Plan {
  steps: Step[];
  describe: string[];
  final: FieldSpec[];
  transforms: Record<string, RecordTransform>;
}

/** Plan the steps, following the layout as each one changes it. */
export function plan(initial: FieldSpec[], intents: Intent[]): Plan {
  const layout = new Map(initial.map((field) => [field.name, field.type as StoredType]));
  const steps: Step[] = [];
  const describe: string[] = [];
  const transforms: Record<string, RecordTransform> = {};
  for (const intent of intents) {
    const present = [...layout.keys()];
    const absent = NAMES.filter((name) => !layout.has(name));
    const pickPresent = (n: number) => present[n % present.length]!;
    switch (intent.kind) {
      case "add": {
        if (!absent.length) continue;
        const field = absent[intent.pick % absent.length]!;
        const fill = intent.fill ? fc.sample(valueOf(intent.type), { seed: intent.seed, numRuns: 1 })[0] : undefined;
        steps.push((m) => m.addField(MODEL, field, intent.type, fill === undefined ? undefined : { fill }));
        describe.push(`addField ${field}:${intent.type}${fill === undefined ? "" : ` fill=${JSON.stringify(fill)}`}`);
        layout.set(field, intent.type);
        break;
      }
      case "drop": {
        if (present.length <= 1) continue;
        const field = pickPresent(intent.pick);
        steps.push((m) => m.dropField(MODEL, field));
        describe.push(`dropField ${field}`);
        layout.delete(field);
        break;
      }
      case "rename": {
        if (!present.length || !absent.length) continue;
        const from = pickPresent(intent.pick);
        const to = absent[intent.pick2 % absent.length]!;
        const type = layout.get(from)!;
        steps.push((m) => m.renameField(MODEL, from, to, type));
        describe.push(`renameField ${from}→${to}:${type}`);
        layout.delete(from);
        layout.set(to, type);
        break;
      }
      case "copy": {
        if (present.length < 2) continue;
        const from = pickPresent(intent.pick);
        const to = pickPresent(intent.pick2 === intent.pick ? intent.pick + 1 : intent.pick2);
        if (from === to) continue;
        const type = layout.get(to)!;
        const fromType = layout.get(from)!;
        steps.push((m) => m.copyField(MODEL, from, to, type, { overwrite: intent.overwrite, fromType }));
        describe.push(`copyField ${from}→${to}:${type}${intent.overwrite ? " overwrite" : ""}`);
        break;
      }
      case "retype": {
        if (!present.length) continue;
        const field = pickPresent(intent.pick);
        const from = layout.get(field)!;
        if (from === intent.type || !isWidening(from, intent.type)) continue;
        steps.push((m) => m.retypeField(MODEL, field, from, intent.type));
        describe.push(`retypeField ${field} ${from}→${intent.type}`);
        layout.set(field, intent.type);
        break;
      }
      case "transform": {
        // ×10 on an integer field: deliberately not safe to apply twice.
        const integers = present.filter((name) => layout.get(name) === "integer");
        if (!integers.length) continue;
        const field = integers[intent.pick % integers.length]!;
        const id = `times10_${steps.length}`;
        transforms[id] = (row) => (typeof row[field] === "number" ? { ...row, [field]: (row[field] as number) * 10 } : row);
        steps.push((m) => m.transform(MODEL, id, [field], undefined, { phase: "expand" }));
        describe.push(`transform ${field} ×10`);
        break;
      }
    }
  }
  return { steps, describe, final: [...layout].map(([name, type]) => ({ name, type })), transforms };
}

export function migrationOf(planned: Plan): Migration {
  return { name: "0001_random", transforms: planned.transforms, up: (m) => planned.steps.forEach((step) => step(m)) };
}

// --- stores -------------------------------------------------------------------------------------

type Registering = Partial<{ registerModel(model: string, indexes: never[], fields: FieldSpec[]): unknown }>;

/** Register the starting layout and write the records. */
export async function seed(backend: Backend, initial: FieldSpec[], rows: JsonObject[]): Promise<void> {
  const registering = backend as Registering;
  if (registering.registerModel) await registering.registerModel(MODEL, [], initial);
  for (const row of rows) backend.save(MODEL, structuredClone(row), ctx);
  await backend.persist(ctx);
}

/**
 * The records as the application sees them under the final layout. Absent and null are one state
 * everywhere, and a field the final layout doesn't declare isn't something the application reads (SQL
 * keeps no column for it to compare).
 */
export async function readBack(backend: Backend, final: FieldSpec[]): Promise<JsonObject[]> {
  const registering = backend as Registering;
  if (registering.registerModel) await registering.registerModel(MODEL, [], final);
  const rows = await backend.query({ model: MODEL, where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctx);
  const names = new Set(final.map((field) => field.name));
  return rows
    .map((row) => {
      const out: JsonObject = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        if (key !== "uuid" && !names.has(key)) continue;
        out[key] = value;
      }
      return out;
    })
    .sort((x, y) => String(x.uuid).localeCompare(String(y.uuid)));
}

/**
 * MariaDB (a local stand-in; the supported target is MySQL 8) renders a DOUBLE with 15 significant
 * digits in the text protocol, so a float needing more doesn't survive a plain round trip there.
 */
export const exceeds15Digits = (rows: JsonObject[]): boolean =>
  rows.some((row) => Object.values(row).some((value) => typeof value === "number" && Number(value.toPrecision(15)) !== value));
