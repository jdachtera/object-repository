/**
 * Property-based conformance: random records, random migrations, every backend against the reference.
 *
 * `conformance.test.ts` pins the cases someone thought of. This generates the ones nobody did: records
 * with absent fields, stored nulls, awkward strings and floats an engine renders its own way, and
 * sequences of valid migration steps — fields added (with and without a fill), dropped, renamed,
 * copied between, retyped along the widening lattice — each step planned against the layout the steps
 * before it produced. Every backend must leave exactly the record set the in-memory reference does, or
 * refuse exactly when the reference refuses.
 *
 * A failure prints fast-check's seed and the shrunk counterexample; `PROPERTY_SEED` replays it and
 * `PROPERTY_RUNS` raises the run count (CI keeps the default, a soak run can go much higher).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { newDb } from "pg-mem";
import pg from "pg";
import { createPool, type Pool as MySqlPool } from "mysql2/promise";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import "fake-indexeddb/auto";
import { exclusiveLiveDbs, requireLiveDb } from "../testing/liveDb.testutil.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { MySqlBackend } from "../backends/sql/MySqlBackend.js";
import { MongoBackend } from "../backends/mongo/MongoBackend.js";
import { runMigrations } from "./run.js";
import { everything } from "./paging.js";
import { isWidening } from "./ops.js";
import { SYSTEM_CONTEXT, type JsonObject, type JsonValue } from "../core/types.js";
import type { Backend, FieldSpec } from "../core/Backend.js";
import type { MigrationBuilder, StoredType } from "./types.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const ctx = SYSTEM_CONTEXT;
const MODEL = "Prop";
const RUNS = Number(process.env.PROPERTY_RUNS ?? 25);
const SEED = process.env.PROPERTY_SEED === undefined ? undefined : Number(process.env.PROPERTY_SEED);

// --- values -------------------------------------------------------------------------------------

const TYPES: StoredType[] = ["text", "integer", "float", "boolean", "array", "scalar", "json"];

const awkwardText = fc.constantFrom("", "42", "-7", "1e15", "0.1", "abc", 'say "hi"', "null", "true", "[1]", "ünïcødé", " padded ");
// Engines store doubles exactly, but -0 is not worth chasing (JSON can't carry it).
const finiteDouble = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e18, max: 1e18 }).filter((n) => !Object.is(n, -0));

function valueOf(type: StoredType): fc.Arbitrary<JsonValue> {
  switch (type) {
    case "text":
      return fc.oneof(awkwardText, fc.string({ maxLength: 12 }).filter((s) => !s.includes("\u0000")));
    case "integer":
      return fc.integer({ min: -1_000_000, max: 1_000_000 });
    case "float":
      return fc.oneof(fc.constantFrom(1e15, 1e-7, 0.1, 1.5, -2.25, 3), finiteDouble);
    case "boolean":
      return fc.boolean();
    case "array":
      return fc.array(fc.oneof(awkwardText, fc.string({ maxLength: 6 }).filter((s) => !s.includes("\u0000"))), { maxLength: 3 });
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

const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** A starting layout: three to five fields of random types. */
const layoutArb: fc.Arbitrary<FieldSpec[]> = fc
  .uniqueArray(fc.constantFrom(...NAMES), { minLength: 3, maxLength: 5 })
  .chain((names) => fc.tuple(...names.map(() => fc.constantFrom(...TYPES))).map((types) => names.map((name, i) => ({ name, type: types[i]! }))));

/** A record of a layout: each field absent, null, or a value of its type. */
function recordsOf(layout: FieldSpec[]): fc.Arbitrary<JsonObject[]> {
  const record = fc.record(
    Object.fromEntries(layout.map((field) => [field.name, fc.option(fc.option(valueOf(field.type as StoredType), { nil: null }), { nil: undefined })]))
  );
  return fc.array(record, { minLength: 1, maxLength: 6 }).map((rows) =>
    rows.map((row, i) => {
      const out: JsonObject = { uuid: `r${i}` };
      for (const [key, value] of Object.entries(row)) if (value !== undefined) out[key] = value as JsonValue;
      return out;
    })
  );
}

/** An intent, turned into a valid step against whatever layout the steps before it left. */
interface Intent {
  kind: "add" | "drop" | "rename" | "copy" | "retype";
  pick: number;
  pick2: number;
  type: StoredType;
  fill: boolean;
  overwrite: boolean;
  seed: number;
}

const intentArb: fc.Arbitrary<Intent> = fc.record({
  kind: fc.constantFrom("add", "drop", "rename", "copy", "retype"),
  pick: fc.nat(),
  pick2: fc.nat(),
  type: fc.constantFrom(...TYPES),
  fill: fc.boolean(),
  overwrite: fc.boolean(),
  seed: fc.nat()
});

type Step = (m: MigrationBuilder) => void;

/** Plan the steps, following the layout as each one changes it. Returns the steps and the final layout. */
function plan(initial: FieldSpec[], intents: Intent[]): { steps: Step[]; describe: string[]; final: FieldSpec[] } {
  const layout = new Map(initial.map((field) => [field.name, field.type as StoredType]));
  const steps: Step[] = [];
  const describe: string[] = [];
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
    }
  }
  return { steps, describe, final: [...layout].map(([name, type]) => ({ name, type })) };
}

// --- running one case on one backend ------------------------------------------------------------

type Outcome = { refused: string } | { rows: JsonObject[] };

async function outcome(backend: Backend, initial: FieldSpec[], seed: JsonObject[], steps: Step[], final: FieldSpec[]): Promise<Outcome> {
  const aware = backend as Partial<{ registerModel(m: string, i: never[], f: FieldSpec[]): unknown }>;
  if (aware.registerModel) await aware.registerModel(MODEL, [], initial);
  for (const row of seed) backend.save(MODEL, structuredClone(row), ctx);
  await backend.persist(ctx);
  try {
    await runMigrations(backend, [{ name: "0001_random", up: (m) => steps.forEach((step) => step(m)) }], {
      models: { [MODEL]: { fields: final, indexes: [] } },
      skipLock: true
    });
  } catch (error) {
    return { refused: (error as Error).name };
  }
  // Read back under the final layout: what the application sees after the migration.
  if (aware.registerModel) await aware.registerModel(MODEL, [], final);
  const rows = await backend.query({ model: MODEL, where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctx);
  const names = new Set(final.map((field) => field.name));
  return {
    rows: rows
      .map((row) => {
        // Absent and null are one state everywhere; a field the final layout doesn't declare isn't
        // something the application reads (SQL keeps no column for it to compare).
        const out: JsonObject = {};
        for (const [key, value] of Object.entries(row)) {
          if (value === null || value === undefined) continue;
          if (key !== "uuid" && !names.has(key)) continue;
          out[key] = value;
        }
        return out;
      })
      .sort((x, y) => String(x.uuid).localeCompare(String(y.uuid)))
  };
}

// --- backends -----------------------------------------------------------------------------------

const PG_URL = process.env.PG_URL ?? "postgres://test:test@127.0.0.1:5432/test";
const MYSQL_URL = process.env.MYSQL_URL ?? "mysql://test:test@127.0.0.1:3306/test";
const TABLES = [MODEL, "_object_repository_migration_log", "_object_repository_schema_state"];

let releaseLiveDbs: () => Promise<void> = async () => {};
let pgPool: pg.Pool | undefined;
let myPool: MySqlPool | undefined;
let mongoServer: MongoMemoryServer | undefined;
let mongoClient: MongoClient | undefined;
let mongoDb: Db | undefined;
/**
 * MariaDB (a local stand-in; CI and the supported target are MySQL 8) renders a DOUBLE with 15
 * significant digits in the text protocol, so a float needing more doesn't survive a plain round trip
 * — no migration involved. Scenarios holding one are skipped there.
 */
let mariaDb = false;
const exceeds15Digits = (rows: JsonObject[]): boolean =>
  rows.some((row) => Object.values(row).some((value) => typeof value === "number" && Number(value.toPrecision(15)) !== value));

beforeAll(async () => {
  releaseLiveDbs = await exclusiveLiveDbs(PG_URL, MYSQL_URL);
  try {
    let url = process.env.MONGO_URL;
    if (!url) {
      mongoServer = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? "8.0.4" } });
      url = mongoServer.getUri();
    }
    mongoClient = new MongoClient(url);
    await mongoClient.connect();
    mongoDb = mongoClient.db("migration_property");
  } catch (error) {
    requireLiveDb(error);
  }
  try {
    const pool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
    await pool.query("SELECT 1");
    pgPool = pool;
  } catch (error) {
    requireLiveDb(error);
  }
  try {
    const pool = createPool({ uri: MYSQL_URL, connectTimeout: 2000 });
    const [[version]] = (await pool.query("SELECT VERSION() AS v")) as unknown as [[{ v: string }]];
    mariaDb = /mariadb/i.test(version.v);
    myPool = pool;
  } catch (error) {
    requireLiveDb(error);
  }
}, 700_000);

afterAll(async () => {
  await pgPool?.end().catch(() => {});
  await myPool?.end().catch(() => {});
  await mongoClient?.close().catch(() => {});
  await mongoServer?.stop().catch(() => {});
  await releaseLiveDbs();
});

let dbSeq = 0;
const BACKENDS: Array<[string, () => Promise<Backend | null>]> = [
  ["SQLite", async () => new SQLiteBackend(new DatabaseSync(":memory:"))],
  ["IndexedDB", async () => new IndexedDBBackend({ name: `property-${dbSeq++}` })],
  [
    "Postgres (real)",
    async () => {
      if (!pgPool) return null;
      await pgPool.query(`DROP TABLE IF EXISTS ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
      return new PostgresBackend(pgPool);
    }
  ],
  [
    "MySQL (real)",
    async () => {
      if (!myPool) return null;
      await myPool.query(`DROP TABLE IF EXISTS ${TABLES.map((t) => `\`${t}\``).join(", ")}`);
      return new MySqlBackend(myPool);
    }
  ],
  [
    "Mongo",
    async () => {
      if (!mongoDb) return null;
      await mongoDb.dropDatabase();
      return new MongoBackend(mongoDb as never);
    }
  ]
];

// pg-mem is left out: it has no to_json() and a handful of DDL gaps the conformance suite already
// documents, and real Postgres covers the same lowering.
void newDb;

type Scenario = { initial: FieldSpec[]; rows: JsonObject[]; intents: Intent[] };
const I = (kind: Intent["kind"], pick: number, pick2: number, type: StoredType = "text", overwrite = false): Intent => ({
  kind,
  pick,
  pick2,
  type,
  fill: false,
  overwrite,
  seed: 0
});
/** Every counterexample these properties have found, shrunk: run first, on every run. */
const REGRESSIONS: Scenario[] = [
  // float → json: MySQL renders 1e15 its own way
  { initial: [{ name: "h", type: "text" }, { name: "b", type: "array" }, { name: "d", type: "float" }], rows: [{ uuid: "r0", d: 1e15 }, { uuid: "r1" }], intents: [I("retype", 1001519696, 0, "json")] },
  // a copy into a field a later step renames: registered as catalog text, the array reached Postgres raw
  {
    initial: [{ name: "a", type: "boolean" }, { name: "e", type: "array" }, { name: "d", type: "float" }, { name: "f", type: "float" }, { name: "g", type: "json" }],
    rows: [{ uuid: "r0", a: false }],
    intents: [I("copy", 0, 0), I("rename", 893812491, 0)]
  },
  // a copy from a scalar a later step renames: its JSON text read as plain text
  {
    initial: [{ name: "d", type: "text" }, { name: "a", type: "json" }, { name: "c", type: "scalar" }],
    rows: [{ uuid: "r0", c: "" }],
    intents: [I("rename", 0, 0), I("copy", 3747235, 829287287), I("drop", 0, 0), I("rename", 0, 0)]
  },
  // provisioning from the final layout created a rename's target early and left the old column behind
  {
    initial: [{ name: "f", type: "float" }, { name: "c", type: "text" }, { name: "g", type: "integer" }, { name: "b", type: "float" }, { name: "d", type: "json" }],
    rows: [{ uuid: "r0", d: '""' }],
    intents: [I("copy", 0, 0), I("rename", 0, 1317603791), I("rename", 0, 110450057), I("copy", 756109397, 570273119)]
  },
  {
    initial: [{ name: "e", type: "scalar" }, { name: "h", type: "integer" }, { name: "d", type: "text" }],
    rows: [{ uuid: "r0", e: false }, { uuid: "r1" }],
    intents: [I("copy", 925996, 0), I("rename", 561929507, 1648225493), I("rename", 0, 2072852413)]
  },
  // a copy from a field a later step drops: only `fromType` says what it holds
  {
    initial: [{ name: "b", type: "integer" }, { name: "a", type: "text" }, { name: "g", type: "scalar" }, { name: "f", type: "array" }],
    rows: [{ uuid: "r0", g: 0 }],
    intents: [I("rename", 0, 0), I("copy", 1782889749, 642242670), I("drop", 517760001, 0)]
  }
];

const scenarioArb = layoutArb.chain((initial) =>
  fc.record({ initial: fc.constant(initial), rows: recordsOf(initial), intents: fc.array(intentArb, { minLength: 1, maxLength: 5 }) })
);

describe("random migrations over random records", () => {
  for (const [name, make] of BACKENDS) {
    it(`${name} matches the in-memory reference`, async (context) => {
      const probe = await make();
      if (!probe) return context.skip();
      await fc.assert(
        fc.asyncProperty(scenarioArb, async ({ initial, rows, intents }) => {
          const { steps, describe: description, final } = plan(initial, intents);
          if (!steps.length) return;
          fc.pre(!(name === "MySQL (real)" && mariaDb && exceeds15Digits(rows)));
          const expected = await outcome(new InMemoryBackend(), initial, rows, steps, final);
          const backend = (await make())!;
          const actual = await outcome(backend, initial, rows, steps, final);
          (backend as Partial<{ close(): void }>).close?.();
          expect({ steps: description, ...actual }).toEqual({ steps: description, ...expected });
        }),
        { numRuns: RUNS + REGRESSIONS.length, ...(SEED === undefined ? {} : { seed: SEED }), examples: REGRESSIONS.map((scenario) => [scenario] as [Scenario]) }
      );
    }, 600_000);
  }
});
