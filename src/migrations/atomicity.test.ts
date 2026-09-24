/**
 * Runs are single-writer, atomic where the store allows, and resumable where it doesn't.
 *
 *  - The lease is one compare-and-set on every built-in store, so two runners can never both hold it,
 *    a runner can't free its successor's lease, and a runner that lost its lease stops.
 *  - On a transactional store a phase's writes and its journal rows commit together.
 *  - Elsewhere a record pass resumes from its last persisted page, so a non-idempotent transform is
 *    never applied twice, and a page that failed half-way is discarded rather than committed later.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import pg from "pg";
import { createPool, type Pool as MySqlPool } from "mysql2/promise";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { MySqlBackend } from "../backends/sql/MySqlBackend.js";
import { MongoBackend } from "../backends/mongo/MongoBackend.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { isLeasing, type Backend, type LeasingBackend } from "../core/Backend.js";
import { SYSTEM_CONTEXT, type JsonObject } from "../core/types.js";
import { runMigrations, rollbackMigrations } from "./run.js";
import { acquireLock, BackendJournal, LOCK_LEASE_MS, LOCK_RENEW_MS, MigrationLockedError, SCHEMA_STATE_MODEL } from "./journal.js";
import { everything } from "./paging.js";
import type { Migration } from "./types.js";
import { UniqueConstraintError } from "../backends/util/unique.js";
import { exclusiveLiveDbs, requireLiveDb } from "../testing/liveDb.testutil.js";

const ctx = SYSTEM_CONTEXT;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

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
    mongoDb = mongoClient.db("lease_conformance");
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
    await pool.query("SELECT 1");
    myPool = pool;
  } catch (error) {
    requireLiveDb(error);
  }
});
afterAll(async () => {
  await mongoClient?.close().catch(() => {});
  await mongoServer?.stop().catch(() => {});
  await pgPool?.end().catch(() => {});
  await myPool?.end().catch(() => {});
});

let seq = 0;
const LEASE_MODEL = "_lease_conformance";
const STATE_FIELDS = [
  { name: "owner", type: "text" },
  { name: "expiresAt", type: "integer" }
];

/** Each store, fresh, with the lease model registered. `undefined` when the engine isn't reachable. */
const STORES: Array<[string, () => Promise<(Backend & LeasingBackend) | undefined>]> = [
  ["InMemory", async () => new InMemoryBackend()],
  ["SQLite", async () => new SQLiteBackend(new DatabaseSync(":memory:"))],
  ["IndexedDB", async () => new IndexedDBBackend({ name: `lease-${seq++}` })],
  [
    "Postgres (pg-mem)",
    async () => {
      const { Pool } = newDb().adapters.createPg();
      return new PostgresBackend(new Pool());
    }
  ],
  [
    "Postgres (real)",
    async () => {
      if (!pgPool) return undefined;
      await pgPool.query(`DROP TABLE IF EXISTS "${LEASE_MODEL}"`);
      return new PostgresBackend(pgPool);
    }
  ],
  [
    "MySQL (real)",
    async () => {
      if (!myPool) return undefined;
      await myPool.query(`DROP TABLE IF EXISTS \`${LEASE_MODEL}\``);
      return new MySqlBackend(myPool);
    }
  ],
  [
    "Mongo",
    async () => {
      if (!mongoDb) return undefined;
      await mongoDb.collection(LEASE_MODEL).drop().catch(() => {});
      return new MongoBackend(mongoDb as never);
    }
  ]
];

describe.each(STORES)("the lease on %s", (_name, make) => {
  async function store(context: { skip(): void }): Promise<Backend & LeasingBackend> {
    const backend = await make();
    if (!backend) {
      context.skip();
      throw new Error("unreachable");
    }
    expect(isLeasing(backend)).toBe(true);
    await (backend as unknown as { registerModel(m: string, i: never[], f: typeof STATE_FIELDS): Promise<void> }).registerModel(
      LEASE_MODEL,
      [],
      STATE_FIELDS
    );
    return backend;
  }

  it("admits exactly one holder, even when both claim at once", async (context) => {
    const backend = await store(context);
    const claims = await Promise.all(
      ["a", "b", "c", "d"].map((owner) => backend.acquireLease(LEASE_MODEL, "k", owner, 1000, LOCK_LEASE_MS, ctx))
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("renews for its holder, refuses others until it expires, then passes on", async (context) => {
    const backend = await store(context);
    expect(await backend.acquireLease(LEASE_MODEL, "k", "a", 1000, 100, ctx)).toBe(true);
    expect(await backend.acquireLease(LEASE_MODEL, "k", "a", 1050, 100, ctx)).toBe(true); // renew → 1150
    expect(await backend.acquireLease(LEASE_MODEL, "k", "b", 1100, 100, ctx)).toBe(false);
    expect(await backend.acquireLease(LEASE_MODEL, "k", "b", 1150, 100, ctx)).toBe(true); // expired
    expect(await backend.acquireLease(LEASE_MODEL, "k", "a", 1160, 100, ctx)).toBe(false); // lost it
  });

  it("never frees a successor's lease", async (context) => {
    const backend = await store(context);
    await backend.acquireLease(LEASE_MODEL, "k", "a", 1000, 100, ctx);
    await backend.acquireLease(LEASE_MODEL, "k", "b", 2000, 100, ctx); // a's lease expired; b took it
    await backend.releaseLease(LEASE_MODEL, "k", "a", ctx); // a, late, tries to release
    expect(await backend.acquireLease(LEASE_MODEL, "k", "c", 2050, 100, ctx)).toBe(false);
    await backend.releaseLease(LEASE_MODEL, "k", "b", ctx);
    expect(await backend.acquireLease(LEASE_MODEL, "k", "c", 2050, 100, ctx)).toBe(true);
  });
});

async function seeded(prices: number[]): Promise<InMemoryBackend> {
  const backend = new InMemoryBackend();
  prices.forEach((price, i) => backend.save("Item", { uuid: `i${i}`, price }, ctx));
  await backend.persist(ctx);
  return backend;
}

const prices = async (backend: Backend): Promise<number[]> =>
  (
    await backend.query({ model: "Item", where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctx)
  ).map((row) => Number(row.price));

const models = { Item: { fields: [], indexes: [] } };

/** `price * 100` — the canonical transform that must never run twice on a row. */
function cents(failOn?: string): Migration {
  return {
    name: "0030_cents",
    transforms: {
      cents: (row: JsonObject) => {
        if (row.uuid === failOn) throw new Error(`boom on ${failOn}`);
        return { ...row, price: Number(row.price) * 100 };
      }
    },
    up: (m) => m.transform("Item", "cents", ["price"])
  };
}

describe("an interrupted record pass", () => {
  it("resumes from its last persisted page instead of re-applying a transform", async () => {
    const backend = await seeded([1, 2, 3, 4, 5]);
    await expect(runMigrations(backend, [cents("i3")], { models, batchSize: 2 })).rejects.toThrow("boom on i3");
    // Pages [i0,i1] were persisted; the failing page [i2,i3] was discarded whole.
    expect(await prices(backend)).toEqual([100, 200, 3, 4, 5]);

    const report = await runMigrations(backend, [cents()], { models, batchSize: 2 });
    expect(report.applied).toEqual(["0030_cents"]);
    expect(await prices(backend)).toEqual([100, 200, 300, 400, 500]);
  });

  it("doesn't let a later persist commit the half-written page", async () => {
    const backend = await seeded([1, 2, 3]);
    await expect(runMigrations(backend, [cents("i1")], { models, batchSize: 10 })).rejects.toThrow();
    await backend.persist(ctx); // the application's next unit of work
    expect(await prices(backend)).toEqual([1, 2, 3]);
  });
});

describe("the runner's lease", () => {
  it("stops a runner whose lease was taken before it reaches a contract", async () => {
    const backend = new InMemoryBackend();
    backend.save("User", { uuid: "u1", name: "Ann" }, ctx);
    await backend.persist(ctx);
    let clock = 0;
    const now = () => clock;
    const migration: Migration = {
      name: "0031_drop",
      transforms: {
        stall: (row: JsonObject) => {
          // Stalls past its lease; meanwhile a successor takes over.
          clock += LOCK_LEASE_MS + 1;
          void backend.acquireLease(SCHEMA_STATE_MODEL, "__lock__", "successor", clock, LOCK_LEASE_MS, ctx);
          return row;
        }
      },
      up: (m) => {
        m.transform("User", "stall", [], undefined, { phase: "expand" });
        m.dropField("User", "name");
      }
    };
    await expect(runMigrations(backend, [migration], { models: { User: { fields: [], indexes: [] } }, now })).rejects.toThrow(
      MigrationLockedError
    );
    const [user] = await backend.query({ model: "User", where: everything(), order: [], paging: { start: 0 } }, ctx);
    expect(user!.name).toBe("Ann");
  });

  it("is renewed while a long pass runs, so a live runner keeps it", async () => {
    const backend = await seeded([1, 2, 3, 4]);
    let clock = 0;
    const slow: Migration = {
      ...cents(),
      transforms: {
        cents: (row: JsonObject) => {
          clock += LOCK_RENEW_MS; // each row takes a minute: the pass outlives the 5-minute lease
          return { ...row, price: Number(row.price) * 100 };
        }
      }
    };
    await runMigrations(backend, [slow], { models, batchSize: 1, now: () => clock });
    expect(await prices(backend)).toEqual([100, 200, 300, 400]);
  });

  it("is taken by a rollback too", async () => {
    const backend = await seeded([1]);
    const reversible: Migration = { ...cents(), down: (m) => m.addField("Item", "x", "text") };
    await runMigrations(backend, [reversible], { models });
    await acquireLock(backend, ctx, Date.now, "deploy");
    await expect(rollbackMigrations(backend, [reversible], 1, { models })).rejects.toThrow(MigrationLockedError);
  });

  it("isn't released by a failing run's release masking the real error", async () => {
    const backend = await seeded([1]);
    backend.releaseLease = async () => {
      throw new Error("release failed");
    };
    await expect(runMigrations(backend, [cents("i0")], { models })).rejects.toThrow("boom on i0");
  });
});

describe("a phase on a transactional store", () => {
  const pgBackend = () => {
    const { Pool } = newDb().adapters.createPg();
    return new PostgresBackend(new Pool());
  };
  const personModels = {
    Person: {
      fields: [
        { name: "name", type: "text" as const },
        { name: "tier", type: "text" as const }
      ],
      indexes: []
    }
  };

  it("commits its DDL and its journal rows together, so a failure leaves neither", async () => {
    const backend = pgBackend();
    await backend.registerModel("Person", [], [{ name: "name", type: "text" }]);
    backend.save("Person", { uuid: "p1", name: "Ann" }, ctx);
    await backend.persist(ctx);

    const broken: Migration = {
      name: "0032_tier",
      transforms: {
        explode: () => {
          throw new Error("backfill failed");
        }
      },
      up: (m) => {
        m.addField("Person", "tier", "text", { fill: "free" });
        m.transform("Person", "explode", ["tier"], undefined, { phase: "expand" });
      }
    };
    await expect(runMigrations(backend, [broken], { models: personModels })).rejects.toThrow("backfill failed");
    expect(await new BackendJournal(backend, ctx).load()).toEqual([]);

    // Fixed and re-run: no "column already exists", because the first attempt left no column behind.
    const fixed: Migration = { name: "0032_tier", up: (m) => m.addField("Person", "tier", "text", { fill: "free" }) };
    const report = await runMigrations(backend, [fixed], { models: personModels });
    expect(report.applied).toEqual(["0032_tier"]);
    const [person] = await backend.query({ model: "Person", where: everything(), order: [], paging: { start: 0 } }, ctx);
    expect(person).toMatchObject({ name: "Ann", tier: "free" });
  });

  it("rolls back the DDL itself on a real server (pg-mem doesn't roll back DDL)", async (context) => {
    if (!pgPool) return context.skip();
    for (const table of ["Person", "_object_repository_migration_log", "_object_repository_schema_state"]) {
      await pgPool.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    const backend = new PostgresBackend(pgPool);
    await backend.registerModel("Person", [], [{ name: "name", type: "text" }]);
    backend.save("Person", { uuid: "p1", name: "Ann" }, ctx);
    await backend.persist(ctx);

    const broken: Migration = {
      name: "0032_tier",
      transforms: {
        explode: () => {
          throw new Error("backfill failed");
        }
      },
      up: (m) => {
        m.addField("Person", "tier", "text", { fill: "free" });
        m.transform("Person", "explode", ["tier"], undefined, { phase: "expand" });
      }
    };
    await expect(runMigrations(backend, [broken], { models: personModels })).rejects.toThrow("backfill failed");
    const columns = await pgPool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Person'`);
    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).not.toContain("tier");
    expect(await new BackendJournal(backend, ctx).load()).toEqual([]);
  });

  it("restores a committed phase's registration when a later phase fails", async () => {
    const { Pool } = newDb().adapters.createPg();
    const backend = new PostgresBackend(new Pool(), undefined, { uniquePreCheck: true });
    const userModels = {
      User: { fields: [{ name: "email", type: "text" as const }], indexes: [{ name: "email", fields: [{ path: "email" }], unique: true }] }
    };
    await backend.registerModel("User", userModels.User.indexes, userModels.User.fields);
    backend.save("User", { uuid: "u1", email: "a@x" }, ctx);
    await backend.persist(ctx);

    const touch: Migration = {
      name: "0036_touch",
      transforms: { touch: (row: JsonObject) => row }, // a record pass: registers User without its unique index
      up: (m) => m.transform("User", "touch", ["email"])
    };
    const broken: Migration = {
      name: "0037_broken",
      transforms: {
        explode: () => {
          throw new Error("backfill failed");
        }
      },
      up: (m) => m.transform("User", "explode", ["email"])
    };
    await expect(runMigrations(backend, [touch, broken], { models: userModels })).rejects.toThrow("backfill failed");

    // The pre-check still knows the unique key the first, committed phase registered User without.
    backend.save("User", { uuid: "u2", email: "a@x" }, ctx);
    await expect(backend.persist(ctx)).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it("doesn't re-provision a column a contract dropped earlier in the same run", async () => {
    const backend = pgBackend();
    await backend.registerModel("Person", [], personModels.Person.fields);
    backend.save("Person", { uuid: "p1", name: "Ann", tier: "gold" }, ctx);
    await backend.persist(ctx);

    const migration: Migration = {
      name: "0034_drop_tier",
      transforms: { touch: (row: JsonObject) => ({ ...row, name: String(row.name).toUpperCase() }) },
      up: (m) => {
        m.dropField("Person", "tier"); // lowered: ALTER TABLE … DROP COLUMN
        m.transform("Person", "touch", ["name"]); // generic: re-registers the model's layout
      }
    };
    await runMigrations(backend, [migration], { models: personModels }); // the layout still lists `tier`
    const columns = await backend.raw(
      { sql: `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, params: ["Person"] },
      ctx
    );
    expect(columns.map((row) => row.column_name)).not.toContain("tier");
  });

  it("keeps the known columns when a replayed createModel finds the table already there", async (context) => {
    if (!pgPool) return context.skip(); // pg-mem can't plan CREATE TABLE IF NOT EXISTS over an existing table
    for (const table of ["Person", "_object_repository_migration_log", "_object_repository_schema_state"]) {
      await pgPool.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    const backend = new PostgresBackend(pgPool);
    await backend.registerModel("Person", [], personModels.Person.fields);
    backend.save("Person", { uuid: "p1", name: "Ann", tier: "gold" }, ctx);
    await backend.persist(ctx);

    await runMigrations(backend, [{ name: "0035_replay", up: (m) => m.createModel("Person", [{ name: "name", type: "text" }]) }], {
      models: personModels,
      skipLock: true
    });
    const [person] = await backend.query({ model: "Person", where: everything(), order: [], paging: { start: 0 } }, ctx);
    expect(person).toMatchObject({ name: "Ann", tier: "gold" }); // `tier` didn't vanish from reads
  });

  it("adds a field that define() already provisioned", async () => {
    const backend = pgBackend();
    await backend.registerModel("Person", [], personModels.Person.fields); // auto-provisioned, tier included
    backend.save("Person", { uuid: "p1", name: "Ann" }, ctx);
    await backend.persist(ctx);

    const report = await runMigrations(
      backend,
      [{ name: "0033_tier", up: (m) => m.addField("Person", "tier", "text", { fill: "free" }) }],
      { models: personModels }
    );
    expect(report.applied).toEqual(["0033_tier"]);
    const [person] = await backend.query({ model: "Person", where: everything(), order: [], paging: { start: 0 } }, ctx);
    expect(person).toMatchObject({ tier: "free" });
  });
});
