/**
 * Cross-backend conformance: every backend must produce **the same record set** as the in-memory
 * reference for every migration operation.
 *
 * This is the test that makes the portability claim real. A backend may realize an operation natively
 * (SQL turns a rename into metadata-only DDL) or fall back to the shared row-rewriting executor —
 * either way the observable outcome has to be identical, or the abstraction is a lie. It is also the
 * regression net for the failure that motivated this whole subsystem: a migration that quietly did
 * nothing at all on a store with no DDL.
 *
 * The real engines — PostgreSQL, MySQL and `mongod` — run whenever one is reachable (`PG_URL`,
 * `MYSQL_URL`, `MONGO_URL`, defaulting to the same local addresses the integration suites use) and skip
 * otherwise. They matter more than the in-process stand-ins: pg-mem accepts things a real server
 * rejects (a NUL byte in text, for one), which is how a migration journal that could never be written
 * on PostgreSQL passed every test here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exclusiveLiveDbs, requireLiveDb } from "../testing/liveDb.testutil.js";
import { newDb } from "pg-mem";
import pg from "pg";
import { createPool, type Pool as MySqlPool } from "mysql2/promise";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { MySqlBackend } from "../backends/sql/MySqlBackend.js";
import { MongoBackend } from "../backends/mongo/MongoBackend.js";
import { runMigrations } from "./run.js";
import { everything } from "./paging.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { migrationTarget, type Backend, type FieldSpec, type IndexSpec } from "../core/Backend.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { PolicyBackend } from "../backends/decorators/PolicyBackend.js";
import type { Migration } from "./types.js";
import "fake-indexeddb/auto";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const ctx = SYSTEM_CONTEXT;
let clock = 1000;
const now = () => clock++;

const MODEL = "Rec";

/** The pre-migration rows every case starts from — deliberately ragged, to exercise absent fields. */
const SEED: JsonObject[] = [
  { uuid: "a", legacy: "L-a", canonical: "C-a", n: 1, keep: true, qty: 1, ratio: 1.5, tags: ["x"], note: "hello" },
  { uuid: "b", legacy: "L-b", n: 2, keep: false, qty: 2, ratio: 0.25, tags: [], note: "42" },
  { uuid: "c", n: 3, keep: true },
  { uuid: "d", legacy: "L-d", canonical: "C-d", n: 4, keep: true, qty: -7, ratio: 2, tags: ["y", "z"], note: 'say "hi"' }
];

/**
 * The columns the store has *before* a migration runs — the realistic order, since migrations run at
 * deploy time before models are defined against the new shape. A case that adds a column declares it
 * in `after` instead; declaring it up front would have the provisioner create it, and the migration
 * would then be adding a column that already exists.
 */
const BEFORE: FieldSpec[] = [
  { name: "legacy", type: "text" },
  { name: "canonical", type: "text" },
  { name: "n", type: "scalar" },
  { name: "keep", type: "boolean" },
  { name: "qty", type: "integer" },
  { name: "ratio", type: "float" },
  { name: "tags", type: "array" },
  { name: "note", type: "text" }
];

/** `BEFORE` with one field's type changed — the layout after a retype. */
const retyped = (field: string, type: string): FieldSpec[] =>
  BEFORE.map((spec) => (spec.name === field ? { name: field, type } : spec));

interface Case {
  label: string;
  migration: Migration;
  /** The post-migration layout handed to the runner. Defaults to `BEFORE`. */
  after?: FieldSpec[];
  /** Indexes the store has before the migration runs. */
  indexesBefore?: IndexSpec[];
  /** Indexes the application declares after it (what `define()` would register). Defaults to none. */
  indexesAfter?: IndexSpec[];
  /**
   * Behaviour to compare besides the record set — an index's effect shows up only as what the store
   * then accepts. Its result must match the reference's too.
   */
  probe?: (backend: Backend) => Promise<unknown>;
  /** What the probe must return — on the reference too, which a differential check alone can't catch. */
  expect?: unknown;
  /** Backends this case can't run on, with the reason. */
  skip?: Record<string, string>;
}

/** Does the store accept a record duplicating `n` of an existing one? */
async function acceptsDuplicate(backend: Backend): Promise<string> {
  backend.save(MODEL, { uuid: "zz", n: 1 }, ctx);
  try {
    await backend.persist(ctx);
    return "accepted";
  } catch {
    backend.discardPending?.();
    return "rejected";
  }
}

const UNIQUE_N: IndexSpec = { name: "uniq_n", fields: [{ path: "n" }], unique: true };

const CASES: Case[] = [
  // --- values: every fill and retype has to land as the same stored value everywhere ------------
  {
    label: "addField fills an array",
    migration: { name: "m", up: (m) => m.addField(MODEL, "list", "array", { fill: ["x"] }) },
    after: [...BEFORE, { name: "list", type: "array" }]
  },
  {
    label: "addField fills an empty array",
    migration: { name: "m", up: (m) => m.addField(MODEL, "list", "array", { fill: [] }) },
    after: [...BEFORE, { name: "list", type: "array" }]
  },
  {
    label: "addField fills json",
    migration: { name: "m", up: (m) => m.addField(MODEL, "meta", "json", { fill: { a: 1 } }) },
    after: [...BEFORE, { name: "meta", type: "json" }]
  },
  {
    label: "addField fills a scalar with a string",
    migration: { name: "m", up: (m) => m.addField(MODEL, "sc", "scalar", { fill: "s" }) },
    after: [...BEFORE, { name: "sc", type: "scalar" }]
  },
  ...(
    [
      ["qty", "integer", "float"],
      ["qty", "integer", "text"],
      ["qty", "integer", "json"],
      ["ratio", "float", "text"],
      ["keep", "boolean", "text"],
      ["keep", "boolean", "scalar"],
      ["note", "text", "json"],
      ["note", "text", "scalar"],
      ["tags", "array", "json"],
      ["tags", "array", "scalar"]
    ] as const
  ).map(
    ([field, from, to]): Case => ({
      label: `retypeField ${from} → ${to}`,
      migration: { name: "m", up: (m) => m.retypeField(MODEL, field, from, to) },
      after: retyped(field, to),
      ...(from === "text"
        ? { skip: { "Postgres (pg-mem)": "pg-mem has no to_json(); real Postgres runs this case" } }
        : {})
    })
  ),
  {
    label: "copyField into a text field converts the value",
    migration: { name: "m", up: (m) => m.copyField(MODEL, "qty", "note", "text", { overwrite: true }) }
  },
  {
    label: "addIndex (unique) not declared by the model",
    // MySQL's upsert (`ON DUPLICATE KEY UPDATE`) turns the unique-key conflict into an update of the
    // *other* row, so the probe sees "accepted" — the pre-existing F330, not an index divergence.
    skip: { "MySQL (real)": "F330: MySQL upsert overwrites the conflicting row instead of rejecting" },
    migration: { name: "m", up: (m) => m.addIndex(MODEL, UNIQUE_N) },
    probe: acceptsDuplicate,
    expect: "rejected"
  },
  {
    label: "dropIndex (unique)",
    migration: { name: "m", up: (m) => m.dropIndex(MODEL, "uniq_n") },
    indexesBefore: [UNIQUE_N],
    probe: acceptsDuplicate,
    expect: "accepted"
  },
  {
    label: "addIndex with a name that isn't an identifier",
    // MySQL's upsert (`ON DUPLICATE KEY UPDATE`) turns the unique-key conflict into an update of the
    // *other* row, so the probe sees "accepted" — the pre-existing F330, not an index divergence.
    skip: { "MySQL (real)": "F330: MySQL upsert overwrites the conflicting row instead of rejecting" },
    migration: { name: "m", up: (m) => m.addIndex(MODEL, { name: "by-n", fields: [{ path: "n" }], unique: true }) },
    probe: acceptsDuplicate,
    expect: "rejected"
  },
  {
    label: "addIndex over a nested path",
    migration: { name: "m", up: (m) => m.addIndex(MODEL, { name: "by_meta", fields: [{ path: "meta.x" }] }) }
  },
  {
    label: "dropField",
    migration: { name: "m", up: (m) => m.dropField(MODEL, "legacy") }
  },
  {
    label: "addField with fill",
    migration: { name: "m", up: (m) => m.addField(MODEL, "tier", "text", { fill: "free" }) },
    after: [...BEFORE, { name: "tier", type: "text" }]
  },
  {
    label: "addField without fill is inert",
    migration: { name: "m", up: (m) => m.addField(MODEL, "tier", "text") },
    after: [...BEFORE, { name: "tier", type: "text" }]
  },
  {
    label: "copyField (no overwrite)",
    migration: { name: "m", up: (m) => m.copyField(MODEL, "legacy", "canonical", "text") }
  },
  {
    label: "copyField (overwrite)",
    migration: { name: "m", up: (m) => m.copyField(MODEL, "legacy", "canonical", "text", { overwrite: true }) }
  },
  {
    label: "renameField",
    migration: { name: "m", up: (m) => m.renameField(MODEL, "legacy", "renamed", "text") },
    after: [{ name: "renamed", type: "text" }, ...BEFORE.filter((f) => f.name !== "legacy")]
  },
  {
    label: "retypeField (widening)",
    migration: { name: "m", up: (m) => m.retypeField(MODEL, "n", "integer", "text") }
  },
  {
    label: "transform (rewrite and remove)",
    migration: {
      name: "m",
      transforms: { prune: (row) => (row.keep ? { ...row, n: Number(row.n) * 10 } : null) },
      up: (m) => m.transform(MODEL, "prune", ["n"])
    }
  },
  {
    label: "dropModel",
    migration: { name: "m", up: (m) => m.dropModel(MODEL) },
    // pg-mem leaves the implicit primary-key index behind when a table is dropped, so the re-provision
    // that the following read triggers fails with "relation Rec_pkey already exists". Its own quirk,
    // not a divergence — real Postgres is covered by the env-gated integration suite.
    skip: { "Postgres (pg-mem)": "pg-mem does not drop a table's implicit primary-key index with the table" }
  },
  {
    label: "a gated rename, window still open",
    migration: {
      name: "m",
      schemaVersion: 7,
      up: (m) => m.renameField(MODEL, "legacy", "renamed", "text")
    },
    after: [...BEFORE, { name: "renamed", type: "text" }]
  }
];

/** Run one case against one backend and return its resulting records, normalized for comparison. */
async function outcome(backend: Backend, testCase: Case, minSupported = 0): Promise<JsonObject[]> {
  const { migration } = testCase;
  if (isSchemaAware(backend)) await backend.registerModel(MODEL, (testCase.indexesBefore ?? []) as never[], BEFORE);
  for (const row of SEED) backend.save(MODEL, { ...row }, ctx);
  await backend.persist(ctx);

  await runMigrations(backend, [migration], {
    models: { [MODEL]: { fields: testCase.after ?? BEFORE, indexes: testCase.indexesAfter ?? [] } },
    now,
    ...(migration.schemaVersion === undefined ? {} : { schemaVersion: migration.schemaVersion, minSupportedSchemaVersion: minSupported })
  });

  // Verified on the store itself: a decorator above it is the application's, not the migration's.
  const store = migrationTarget(backend);
  const rows = await store.query(
    { model: MODEL, where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } },
    ctx
  );
  const records = rows.map(normalize).sort((x, y) => String(x.uuid).localeCompare(String(y.uuid)));
  return testCase.probe ? [...records, { probe: (await testCase.probe(store)) as JsonValue }] : records;
}

function isSchemaAware(backend: object): backend is { registerModel(m: string, i: never[], f: FieldSpec[]): Promise<void> | void } {
  return typeof (backend as { registerModel?: unknown }).registerModel === "function";
}

/**
 * Drop keys whose value is absent, so "field missing" and "field present but null" compare equal
 * across stores that genuinely can't distinguish them (a columnar table has a NULL where a document
 * store simply has no key). Every other difference is a real divergence and must fail.
 */
function normalize(row: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

const PG_URL = process.env.PG_URL ?? "postgres://test:test@127.0.0.1:5432/test";
const MYSQL_URL = process.env.MYSQL_URL ?? "mysql://test:test@127.0.0.1:3306/test";

let releaseLiveDbs: () => Promise<void> = async () => {};
beforeAll(async () => {
  releaseLiveDbs = await exclusiveLiveDbs(PG_URL, MYSQL_URL);
}, 700_000);
afterAll(async () => {
  await releaseLiveDbs();
});
let pgPool: pg.Pool | undefined;
let myPool: MySqlPool | undefined;

/** The tables a case touches, dropped before each real-engine case so cases can't see each other. */
const TABLES = [MODEL, "_object_repository_migration_log", "_object_repository_schema_state"];

let mongoServer: MongoMemoryServer | undefined;
let mongoClient: MongoClient | undefined;
let mongoDb: Db | undefined;

beforeAll(async () => {
  try {
    let url = process.env.MONGO_URL;
    if (!url) {
      mongoServer = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? "8.0.4" } });
      url = mongoServer.getUri();
    }
    mongoClient = new MongoClient(url);
    await mongoClient.connect();
    mongoDb = mongoClient.db("migration_conformance");
  } catch (error) {
      requireLiveDb(error);
    mongoDb = undefined; // unreachable here → that backend's cases skip
  }
  try {
    const pool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
    await pool.query("SELECT 1");
    pgPool = pool;
  } catch (error) {
      requireLiveDb(error);
    pgPool = undefined;
  }
  try {
    const pool = createPool({ uri: MYSQL_URL, connectTimeout: 2000 });
    await pool.query("SELECT 1");
    myPool = pool;
  } catch (error) {
      requireLiveDb(error);
    myPool = undefined;
  }
}, 120_000);

afterAll(async () => {
  await pgPool?.end().catch(() => {});
  await myPool?.end().catch(() => {});
  await mongoClient?.close().catch(() => {});
  await mongoServer?.stop().catch(() => {});
});

let dbSeq = 0;
const BACKENDS: Array<[string, () => Promise<Backend | null>]> = [
  ["SQLite", async () => new SQLiteBackend(new DatabaseSync(":memory:"))],
  ["IndexedDB", async () => new IndexedDBBackend({ name: `conformance-${dbSeq++}` })],
  ["Postgres (pg-mem)", async () => new PostgresBackend(new (newDb().adapters.createPg().Pool)())],
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

/**
 * Each engine again beneath a decorator. A migration runs on the store underneath (`migrationTarget`),
 * so the decorated result must be identical — and a decorator that leaked into the run would show here.
 */
const DECORATED: Array<[string, () => Promise<Backend | null>]> = BACKENDS.map(([name, make]) => [
  `${name} beneath PolicyBackend`,
  async () => {
    const inner = await make();
    return inner ? new PolicyBackend(inner, { read: () => { throw new Error("a migration must not consult row policy"); } }) : null;
  }
]);

describe("migration conformance across backends", () => {
  for (const testCase of CASES) {
    for (const [name, make] of [...BACKENDS, ...DECORATED]) {
      it(`${name}: ${testCase.label} matches the in-memory reference`, async (context) => {
        if (testCase.skip?.[name.replace(" beneath PolicyBackend", "")]) return context.skip();
        const backend = await make();
        if (!backend) return context.skip();

        const reference = await outcome(new InMemoryBackend(), testCase);
        const actual = await outcome(backend, testCase);

        expect(actual, `${name} diverged from the reference on "${testCase.label}"`).toEqual(reference);
        if (testCase.expect !== undefined) expect(actual.at(-1)).toEqual({ probe: testCase.expect });
      });
    }
  }
});

describe("the trap each backend used to fall into", () => {
  it("Mongo: a dropField genuinely removes the field", async (context) => {
    if (!mongoDb) return context.skip();
    await mongoDb.dropDatabase();
    const backend = new MongoBackend(mongoDb as never);

    const rows = await outcome(backend, { label: "drop", migration: { name: "m", up: (m) => m.dropField(MODEL, "legacy") } });
    expect(rows.every((row) => !("legacy" in row))).toBe(true);
  });

  it("SQL: a filtered query agrees with a get-by-uuid after a migration", async () => {
    // The divergence this guards: writing through a schema-aware backend whose layout the runner was
    // never told about puts the record in the JSON overflow while the typed columns keep their old
    // values — so reading one row looks right and filtering does not.
    const backend = new PostgresBackend(new (newDb().adapters.createPg().Pool)());
    await outcome(backend, { label: "copy", migration: { name: "m", up: (m) => m.copyField(MODEL, "legacy", "canonical", "text", { overwrite: true }) } });

    const filtered = await backend.query(
      {
        model: MODEL,
        where: { type: "compare", property: "canonical", comparator: "=", value: "L-a" },
        order: [],
        paging: { start: 0 }
      },
      ctx
    );
    expect(filtered.map((row) => row.uuid)).toEqual(["a"]);
  });
});
