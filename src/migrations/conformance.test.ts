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
 * Mongo runs against a real `mongod` when one is reachable and skips otherwise, matching the existing
 * integration suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { MongoBackend } from "../backends/mongo/MongoBackend.js";
import { runMigrations } from "./run.js";
import { everything } from "./paging.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Backend, FieldSpec } from "../core/Backend.js";
import type { JsonObject } from "../core/types.js";
import type { Migration } from "./types.js";
import "fake-indexeddb/auto";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const ctx = SYSTEM_CONTEXT;
let clock = 1000;
const now = () => clock++;

const MODEL = "Rec";

/** The pre-migration rows every case starts from — deliberately ragged, to exercise absent fields. */
const SEED: JsonObject[] = [
  { uuid: "a", legacy: "L-a", canonical: "C-a", n: 1, keep: true },
  { uuid: "b", legacy: "L-b", n: 2, keep: false },
  { uuid: "c", n: 3, keep: true },
  { uuid: "d", legacy: "L-d", canonical: "C-d", n: 4, keep: true }
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
  { name: "keep", type: "boolean" }
];

interface Case {
  label: string;
  migration: Migration;
  /** The post-migration layout handed to the runner. Defaults to `BEFORE`. */
  after?: FieldSpec[];
  /** Backends this case can't run on, with the reason. */
  skip?: Record<string, string>;
}

const CASES: Case[] = [
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
    skip: { Postgres: "pg-mem does not drop a table's implicit primary-key index with the table" }
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
  if (isSchemaAware(backend)) await backend.registerModel(MODEL, [], BEFORE);
  for (const row of SEED) backend.save(MODEL, { ...row }, ctx);
  await backend.persist(ctx);

  await runMigrations(backend, [migration], {
    models: { [MODEL]: { fields: testCase.after ?? BEFORE, indexes: [] } },
    now,
    ...(migration.schemaVersion === undefined ? {} : { schemaVersion: migration.schemaVersion, minSupportedSchemaVersion: minSupported })
  });

  const rows = await backend.query(
    { model: MODEL, where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } },
    ctx
  );
  return rows.map(normalize).sort((x, y) => String(x.uuid).localeCompare(String(y.uuid)));
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
  } catch {
    mongoDb = undefined; // unreachable here → that backend's cases skip
  }
}, 120_000);

afterAll(async () => {
  await mongoClient?.close().catch(() => {});
  await mongoServer?.stop().catch(() => {});
});

let dbSeq = 0;
const BACKENDS: Array<[string, () => Backend | null]> = [
  ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))],
  ["IndexedDB", () => new IndexedDBBackend({ name: `conformance-${dbSeq++}` })],
  ["Postgres", () => new PostgresBackend(new (newDb().adapters.createPg().Pool)())],
  ["Mongo", () => (mongoDb ? new MongoBackend(mongoDb as never) : null)]
];

describe("migration conformance across backends", () => {
  for (const testCase of CASES) {
    for (const [name, make] of BACKENDS) {
      it(`${name}: ${testCase.label} matches the in-memory reference`, async (context) => {
        if (testCase.skip?.[name]) return context.skip();
        const backend = make();
        if (!backend) return context.skip();
        if (name === "Mongo" && mongoDb) await mongoDb.dropDatabase();

        const reference = await outcome(new InMemoryBackend(), testCase);
        const actual = await outcome(backend, testCase);

        expect(actual, `${name} diverged from the reference on "${testCase.label}"`).toEqual(reference);
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
