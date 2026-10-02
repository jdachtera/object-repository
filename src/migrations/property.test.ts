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
import type { JsonObject } from "../core/types.js";
import type { Backend, FieldSpec } from "../core/Backend.js";
import type { StoredType } from "./types.js";
import {
  MODEL,
  exceeds15Digits,
  intentArb,
  layoutArb,
  migrationOf,
  plan,
  readBack,
  recordsOf,
  seed,
  type Intent,
  type Plan
} from "../testing/migrationScenarios.testutil.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const RUNS = Number(process.env.PROPERTY_RUNS ?? 25);
const SEED = process.env.PROPERTY_SEED === undefined ? undefined : Number(process.env.PROPERTY_SEED);

type Outcome = { refused: string } | { rows: JsonObject[] };

async function outcome(backend: Backend, initial: FieldSpec[], rows: JsonObject[], planned: Plan): Promise<Outcome> {
  await seed(backend, initial, rows);
  try {
    await runMigrations(backend, [migrationOf(planned)], { models: { [MODEL]: { fields: planned.final, indexes: [] } }, skipLock: true });
  } catch (error) {
    return { refused: (error as Error).name };
  }
  return { rows: await readBack(backend, planned.final) };
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
  fc.record({
    initial: fc.constant(initial),
    rows: recordsOf(initial),
    intents: fc.array(intentArb(["add", "drop", "rename", "copy", "retype", "transform"]), { minLength: 1, maxLength: 5 })
  })
);

describe("random migrations over random records", () => {
  for (const [name, make] of BACKENDS) {
    it(`${name} matches the in-memory reference`, async (context) => {
      const probe = await make();
      if (!probe) return context.skip();
      await fc.assert(
        fc.asyncProperty(scenarioArb, async ({ initial, rows, intents }) => {
          const planned = plan(initial, intents);
          const description = planned.describe;
          if (!planned.steps.length) return;
          fc.pre(!(name === "MySQL (real)" && mariaDb && exceeds15Digits(rows)));
          const expected = await outcome(new InMemoryBackend(), initial, rows, planned);
          const backend = (await make())!;
          const actual = await outcome(backend, initial, rows, planned);
          (backend as Partial<{ close(): void }>).close?.();
          expect({ steps: description, ...actual }).toEqual({ steps: description, ...expected });
        }),
        { numRuns: RUNS + REGRESSIONS.length, ...(SEED === undefined ? {} : { seed: SEED }), examples: REGRESSIONS.map((scenario) => [scenario] as [Scenario]) }
      );
    }, 600_000);
  }
});
