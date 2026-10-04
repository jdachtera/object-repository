/**
 * Exactly-once under failure: a migration interrupted anywhere, then run again, must leave exactly
 * what an uninterrupted run leaves — and two runners started together must not both apply it.
 *
 * Each case takes a random scenario (records, and steps including a non-idempotent ×10 transform),
 * crashes the first run at a random point — before or after the N-th write the store sees (a persist,
 * or for SQL a single statement, COMMIT included, so a lost acknowledgement is covered too) — then
 * restarts it on a fresh backend over the same storage. Stores that commit a page with its resume
 * marker atomically (all of these) must finish on their own, without asking the operator.
 *
 * `PROPERTY_RUNS` / `PROPERTY_SEED` as in `property.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import pg from "pg";
import { createPool, type Pool as MySqlPool } from "mysql2/promise";
import "fake-indexeddb/auto";
import { exclusiveLiveDbs, requireLiveDb } from "../testing/liveDb.testutil.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { MySqlBackend } from "../backends/sql/MySqlBackend.js";
import { MigrationLockedError } from "./journal.js";
import { MigrationInterruptedError } from "./errors.js";
import type { JsonObject } from "../core/types.js";
import type { Backend, FieldSpec } from "../core/Backend.js";
import {
  ALL_KINDS,
  MODEL,
  MODES,
  exceeds15Digits,
  intentArb,
  layoutArb,
  plan,
  readBack,
  recordsOf,
  scriptOf,
  seed,
  type Intent,
  type Mode,
  type Plan
} from "../testing/migrationScenarios.testutil.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const RUNS = Number(process.env.PROPERTY_RUNS ?? 25);
const SEED = process.env.PROPERTY_SEED === undefined ? undefined : Number(process.env.PROPERTY_SEED);
const BATCH = 2; // tiny pages, so a pass has many points to be interrupted at

// --- crash injection ----------------------------------------------------------------------------

class Crash extends Error {
  constructor() {
    super("injected crash");
    this.name = "Crash";
  }
}

/** Counts the writes a store sees, and throws once at the chosen one — before or after it lands. */
class Crasher {
  count = 0;
  /** What the crashed write carried, for a store that wants to know (see `NonAtomicStore`). */
  crashed: { pending: unknown[]; after: boolean } | null = null;
  constructor(
    private readonly at: number,
    private readonly after: boolean,
    private readonly inspect: () => unknown[] = () => []
  ) {}
  get fired(): boolean {
    return this.count >= this.at;
  }
  async around<T>(write: () => Promise<T>): Promise<T> {
    this.count += 1;
    const crashing = this.count === this.at;
    if (crashing) this.crashed = { pending: [...this.inspect()], after: this.after };
    if (crashing && !this.after) throw new Crash();
    const result = await write();
    if (crashing && this.after) throw new Crash();
    return result;
  }
}

/**
 * A store whose persist isn't atomic across models (Mongo writes collection by collection): the
 * runner writes a page's resume marker separately, so a crash can leave a page it can't vouch for.
 */
class NonAtomicStore extends InMemoryBackend {
  override readonly capabilities = { ...new InMemoryBackend().capabilities, transactions: false };
  /** Where a crash can fall between two models' writes; set by `crashing`. */
  between: (write: () => Promise<unknown>) => Promise<unknown> = (write) => write();

  pending(): unknown[] {
    return (this as unknown as { saveQueue: unknown[] }).saveQueue;
  }

  /** One model at a time, as Mongo writes one collection per `bulkWrite`. */
  override async persist(c: Parameters<Backend["persist"]>[0]): ReturnType<Backend["persist"]> {
    const queues = this as unknown as { saveQueue: Array<{ model: string }>; removeQueue: Array<{ model: string }> };
    const saves = queues.saveQueue;
    const removes = queues.removeQueue;
    const models = [...new Set([...saves, ...removes].map((change) => change.model))];
    const result = { saved: [] as unknown[], removed: [] as unknown[] };
    for (const model of models) {
      queues.saveQueue = saves.filter((change) => change.model === model);
      queues.removeQueue = removes.filter((change) => change.model === model);
      const part = (await this.between(() => super.persist(c))) as { saved: unknown[]; removed: unknown[] };
      result.saved.push(...part.saved);
      result.removed.push(...part.removed);
    }
    queues.saveQueue = [];
    queues.removeQueue = [];
    return result as never;
  }
}

/**
 * The operator's answer to `MigrationInterruptedError`, from what the crashed write carried: the page's
 * records (landed if the crash came after the write), an in-flight marker (the page not written yet),
 * or the marker that follows a page (the page already landed).
 */
function operatorAnswer(crasher: Crasher): "reapply" | "skip" {
  const crashed = crasher.crashed!;
  const records = crashed.pending as Array<{ model: string; record: { cursor?: string } }>;
  if (records.some((change) => change.model === MODEL)) return crashed.after ? "skip" : "reapply";
  if (records.some((change) => String(change.record.cursor ?? "").includes("inFlight"))) return "reapply";
  return "skip";
}

interface Store {
  name: string;
  /** Answers `MigrationInterruptedError` for a store that can raise it. */
  answer?: (crasher: Crasher) => "reapply" | "skip";
  /** Fresh storage for one case. */
  open(): Promise<Storage | null>;
}
interface Storage {
  /** A backend over this storage, its writes passed through `crasher` when given. */
  backend(crasher?: Crasher): Backend;
  close(): Promise<void>;
  /** The writes queued when a crash fires. */
  inspect?: () => unknown[];
}

/** Crash around `persist` on this very instance (a copy would split its state from the original's). */
function crashing(backend: Backend, crasher?: Crasher): Backend {
  if (backend instanceof NonAtomicStore) {
    // Crash between the models of one persist, not only around it.
    backend.between = crasher ? (write) => crasher.around(write) : (write) => write();
    return backend;
  }
  const own = backend as { persist: Backend["persist"] };
  delete (own as Partial<typeof own>).persist; // back to the prototype's
  if (crasher) {
    const persist = backend.persist.bind(backend);
    own.persist = (c) => crasher.around(() => persist(c));
  }
  return backend;
}

const PG_URL = process.env.PG_URL ?? "postgres://test:test@127.0.0.1:5432/test";
const MYSQL_URL = process.env.MYSQL_URL ?? "mysql://test:test@127.0.0.1:3306/test";
const TABLES = [MODEL, "_object_repository_migration_log", "_object_repository_schema_state"];

let releaseLiveDbs: () => Promise<void> = async () => {};
let pgPool: pg.Pool | undefined;
let myPool: MySqlPool | undefined;
let mariaDb = false;

beforeAll(async () => {
  releaseLiveDbs = await exclusiveLiveDbs(PG_URL, MYSQL_URL);
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
  await releaseLiveDbs();
});

let idbSeq = 0;
const STORES: Store[] = [
  {
    name: "non-atomic (Mongo-like)",
    answer: operatorAnswer,
    open: async () => {
      const backend = new NonAtomicStore();
      return { backend: (crasher) => crashing(backend, crasher), close: async () => {}, inspect: () => backend.pending() };
    }
  },
  {
    name: "in-memory",
    open: async () => {
      // One instance throughout: its state is the storage.
      const backend = new InMemoryBackend();
      return { backend: (crasher) => crashing(backend, crasher), close: async () => {} };
    }
  },
  {
    name: "SQLite",
    open: async () => {
      const db = new DatabaseSync(":memory:");
      const backends: Backend[] = [];
      return {
        backend(crasher) {
          const backend = new SQLiteBackend(db);
          backends.push(backend);
          return crashing(backend, crasher);
        },
        close: async () => db.close()
      };
    }
  },
  {
    name: "IndexedDB",
    open: async () => {
      const name = `crash-${idbSeq++}`;
      const opened: IndexedDBBackend[] = [];
      return {
        backend(crasher) {
          for (const backend of opened.splice(0)) backend.close(); // the crashed process's connection is gone
          const backend = new IndexedDBBackend({ name });
          opened.push(backend);
          return crashing(backend, crasher);
        },
        close: async () => opened.forEach((backend) => backend.close())
      };
    }
  },
  {
    name: "Postgres (real)",
    open: async () => {
      if (!pgPool) return null;
      const pool = pgPool;
      await pool.query(`DROP TABLE IF EXISTS ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
      return {
        backend(crasher) {
          if (!crasher) return new PostgresBackend(pool);
          const run = (sql: string, params?: unknown[]) => crasher.around(() => pool.query(sql, params as unknown[]));
          return new PostgresBackend({
            query: run as never,
            connect: async () => {
              const client = await pool.connect();
              return {
                query: ((sql: string, params?: unknown[]) => crasher.around(() => client.query(sql, params as unknown[]))) as never,
                release: () => client.release()
              };
            }
          });
        },
        close: async () => {}
      };
    }
  },
  {
    name: "MySQL (real)",
    open: async () => {
      if (!myPool) return null;
      const pool = myPool;
      await pool.query(`DROP TABLE IF EXISTS ${TABLES.map((t) => `\`${t}\``).join(", ")}`);
      return {
        backend(crasher) {
          if (!crasher) return new MySqlBackend(pool);
          return new MySqlBackend({
            query: (sql: string, params: unknown[]) => crasher.around(() => pool.query(sql, params)),
            getConnection: async () => {
              const conn = await pool.getConnection();
              return {
                query: (sql: string, params: unknown[]) => crasher.around(() => conn.query(sql, params)),
                beginTransaction: () => crasher.around(() => conn.beginTransaction()),
                commit: () => crasher.around(() => conn.commit()),
                rollback: () => conn.rollback(),
                release: () => conn.release()
              };
            }
          } as never);
        },
        close: async () => {}
      };
    }
  }
];

// --- the properties -----------------------------------------------------------------------------

const scenarioArb = layoutArb.chain((initial) =>
  fc.record({
    initial: fc.constant(initial),
    rows: recordsOf(initial, 8),
    intents: fc.array(intentArb(ALL_KINDS), { minLength: 1, maxLength: 5 }),
    mode: fc.constantFrom(...MODES),
    crashAt: fc.nat(),
    after: fc.boolean()
  })
);

type Scenario = { initial: FieldSpec[]; rows: JsonObject[]; intents: Intent[]; mode: Mode };

/** What the scenario's deploys leave on the in-memory reference, or `null` if one is refused. */
async function reference({ initial, rows, mode }: Scenario, planned: Plan): Promise<JsonObject[] | null> {
  const backend = new InMemoryBackend();
  await seed(backend, initial, rows);
  const script = scriptOf(planned, mode);
  try {
    for (const deploy of script.deploys) await deploy(backend, { skipLock: true, batchSize: BATCH });
  } catch {
    return null; // refused: not what these properties are about
  }
  return readBack(backend, script.read);
}

/** How many writes the uninterrupted deploys make on `store`. */
async function writesOf(store: Store, { initial, rows, mode }: Scenario, planned: Plan): Promise<number> {
  const dry = (await store.open())!;
  const counter = new Crasher(Number.POSITIVE_INFINITY, false);
  try {
    await seed(dry.backend(), initial, rows);
    for (const deploy of scriptOf(planned, mode).deploys) await deploy(dry.backend(counter), { skipLock: true, batchSize: BATCH });
  } finally {
    await dry.close();
  }
  return counter.count;
}

/**
 * Crash at write `at` (before or after it lands), wherever in the deploys it falls; restart the deploy
 * it fell in, then run the rest; return what they left.
 */
async function crashThenRestart(store: Store, { initial, rows, mode }: Scenario, planned: Plan, at: number, after: boolean): Promise<JsonObject[]> {
  const storage = (await store.open())!;
  const script = scriptOf(planned, mode);
  try {
    await seed(storage.backend(), initial, rows);
    const crasher = new Crasher(at, after, storage.inspect);
    let next = 0;
    for (; next < script.deploys.length; next++) {
      try {
        await script.deploys[next]!(storage.backend(crasher), { skipLock: true, batchSize: BATCH });
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        break;
      }
    }
    // A restart: a fresh backend over the same storage, nothing in memory carried over. Only a store
    // that can't commit a page with its marker may ask the operator about one page.
    for (let index = next; index < script.deploys.length; index++) {
      const deploy = script.deploys[index]!;
      try {
        await deploy(storage.backend(), { skipLock: true, batchSize: BATCH });
      } catch (error) {
        if (!(error instanceof MigrationInterruptedError) || !store.answer || index !== next) throw error;
        await deploy(storage.backend(), { skipLock: true, batchSize: BATCH, interruptedPage: store.answer(crasher) });
      }
    }
    return await readBack(storage.backend(), script.read);
  } finally {
    await storage.close();
  }
}

const I = (kind: Intent["kind"], pick: number, pick2 = 0): Intent => ({ kind, pick, pick2, type: "text", fill: false, overwrite: false, seed: 0 });
/** Counterexamples these properties have found: crashed at every write, on every store. */
const REGRESSIONS: Scenario[] = [
  // MySQL committed a rename's DDL before the copy ahead of it was recorded as done: the resumed copy
  // found its target renamed away, read it as empty, and filled it again
  {
    initial: [{ name: "f", type: "scalar" }, { name: "h", type: "array" }, { name: "d", type: "integer" }],
    rows: [{ uuid: "r00", f: "", h: [] }],
    intents: [I("drop", 2), I("copy", 1), I("rename", 0)],
    mode: "plain"
  },
  // A failed run restored its registrations with the layout it was heading for, provisioning a rename's
  // target early; the retry found the column there and copied a scalar into a still-integer column
  {
    initial: [{ name: "b", type: "integer" }, { name: "g", type: "scalar" }, { name: "h", type: "array" }, { name: "f", type: "text" }],
    rows: [{ uuid: "r00", g: "" }],
    intents: [I("transform", 0), I("rename", 0), I("rename", 0)],
    mode: "plain"
  }
];

describe("a migration interrupted anywhere, then run again", () => {
  for (const store of STORES) {
    it(`${store.name} ends exactly where an uninterrupted run does`, async (context) => {
      const probe = await store.open();
      if (!probe) return context.skip();
      await probe.close();
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          const { initial, rows, intents, mode, crashAt, after } = scenario;
          const planned = plan(initial, intents);
          if (!planned.steps.length) return;
          fc.pre(!(store.name === "MySQL (real)" && mariaDb && exceeds15Digits(rows)));
          const expected = await reference(scenario, planned);
          fc.pre(expected !== null);
          // Count the writes the uninterrupted deploys make, so the crash always falls inside them.
          const count = await writesOf(store, scenario, planned);
          fc.pre(count > 0);
          const actual = await crashThenRestart(store, scenario, planned, 1 + (crashAt % count), after);
          const steps = [`(${mode})`, ...planned.describe];
          expect({ steps, crashAt, after, rows: actual }).toEqual({ steps, crashAt, after, rows: expected });
        }),
        { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) }
      );
    }, 900_000);

    it(`${store.name} survives a crash at every write of each known counterexample`, async (context) => {
      const probe = await store.open();
      if (!probe) return context.skip();
      await probe.close();
      for (const scenario of REGRESSIONS) {
        const planned = plan(scenario.initial, scenario.intents);
        const expected = await reference(scenario, planned);
        const count = await writesOf(store, scenario, planned);
        for (let at = 1; at <= count; at++) {
          for (const after of [false, true]) {
            const actual = await crashThenRestart(store, scenario, planned, at, after);
            expect({ steps: planned.describe, at, after, rows: actual }).toEqual({ steps: planned.describe, at, after, rows: expected });
          }
        }
      }
    }, 900_000);
  }
});

describe("two runners started together", () => {
  for (const store of STORES) {
    it(`${store.name} applies the migration once`, async (context) => {
      const probe = await store.open();
      if (!probe) return context.skip();
      await probe.close();
      await fc.assert(
        fc.asyncProperty(scenarioArb, async ({ initial, rows, intents }) => {
          const planned = plan(initial, intents);
          if (!planned.steps.length) return;
          fc.pre(!(store.name === "MySQL (real)" && mariaDb && exceeds15Digits(rows)));
          const expected = await reference({ initial, rows, intents, mode: "plain" }, planned);
          fc.pre(expected !== null);

          const storage = (await store.open())!;
          try {
            await seed(storage.backend(), initial, rows);
            // Both hold the lease protocol; one runs, the other is turned away or finds it done.
            const [deploy] = scriptOf(planned, "plain").deploys;
            const both = await Promise.allSettled([deploy!(storage.backend(), { batchSize: BATCH }), deploy!(storage.backend(), { batchSize: BATCH })]);
            for (const result of both) {
              if (result.status === "rejected") expect(result.reason).toBeInstanceOf(MigrationLockedError);
            }
            expect(both.some((result) => result.status === "fulfilled")).toBe(true);
            expect(await readBack(storage.backend(), planned.final)).toEqual(expected);
          } finally {
            await storage.close();
          }
        }),
        { numRuns: Math.max(5, Math.floor(RUNS / 2)), ...(SEED === undefined ? {} : { seed: SEED }) }
      );
    }, 900_000);
  }
});
