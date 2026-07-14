import { describe, it, expect } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "./indexeddb/IndexedDBBackend.js";
import { compileMongoFilter } from "./mongo/MongoBackend.js";
import { gt, eq, mul, field, year, dateToString, cond, switchExpr, cmp, lit } from "../expressions/index.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";
import type { Backend } from "../core/Backend.js";

const ctx = SYSTEM_CONTEXT;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

let idbSeq = 0;
const makeIdb = () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `computed-idb-${idbSeq++}` });

// price * qty > 100 — a computed filter that must give the same answer on every backend.
const computed = gt(mul(field("price"), field("qty")), 100);
function plan(): QueryPlan {
  return { model: "Order", where: computed.serialize(), order: [], paging: { start: 0 } };
}

const orders = [
  { uuid: "o1", price: 40, qty: 3 }, // 120 -> matches
  { uuid: "o2", price: 10, qty: 3 }, // 30  -> no
  { uuid: "o3", price: 25, qty: 5 } // 125 -> matches
];

describe("computed filters run identically across backends (§11)", () => {
  it("in-memory backend evaluates the expression (scan fallback)", async () => {
    const backend = new InMemoryBackend();
    for (const order of orders) backend.save("Order", order, ctx);
    await backend.persist(ctx);
    const result = await backend.query(plan(), ctx);
    expect(result.map((o) => o.uuid).sort()).toEqual(["o1", "o3"]);
  });

  it("SQLite backend compiles the expression to SQL arithmetic", async () => {
    const backend = new SQLiteBackend(new DatabaseSync(":memory:"));
    for (const order of orders) backend.save("Order", order, ctx);
    await backend.persist(ctx);
    const result = await backend.query(plan(), ctx);
    expect(result.map((o) => o.uuid).sort()).toEqual(["o1", "o3"]);
  });

  it("IndexedDB backend evaluates the expression (scan fallback)", async () => {
    const backend = makeIdb();
    for (const order of orders) backend.save("Order", order, ctx);
    await backend.persist(ctx);
    const result = await backend.query(plan(), ctx);
    expect(result.map((o) => o.uuid).sort()).toEqual(["o1", "o3"]);
  });

  it("Mongo backend compiles the expression to a $expr / $multiply filter", () => {
    // Operands are `$ifNull`-coerced to 0 so a null/missing field matches the in-memory reference
    // (which coerces via `num()`) instead of Mongo's null-propagation.
    expect(compileMongoFilter(computed.serialize())).toEqual({
      $expr: {
        $gt: [{ $multiply: [{ $ifNull: ["$price", 0] }, { $ifNull: ["$qty", 0] }] }, { $literal: 100 }]
      }
    });
  });
});

// A date-part filter that must give the same answer in memory and pushed down to SQL.
describe("date-part value ops run identically across backends (§11)", () => {
  // events stored with epoch-ms timestamps
  const events = [
    { uuid: "e1", ts: Date.UTC(2023, 11, 31, 23, 0, 0) }, // 2023
    { uuid: "e2", ts: Date.UTC(2024, 0, 1, 0, 0, 0) }, // 2024
    { uuid: "e3", ts: Date.UTC(2024, 6, 15, 12, 0, 0) } // 2024
  ];
  const in2024 = eq(year(field("ts")), 2024);
  const yearPlan: QueryPlan = { model: "Event", where: in2024.serialize(), order: [], paging: { start: 0 } };

  it("in-memory, SQLite and IndexedDB agree on YEAR(ts) = 2024", async () => {
    for (const backend of [new InMemoryBackend(), new SQLiteBackend(new DatabaseSync(":memory:")), makeIdb()]) {
      for (const event of events) backend.save("Event", event, ctx);
      await backend.persist(ctx);
      expect((await backend.query(yearPlan, ctx)).map((e) => e.uuid).sort()).toEqual(["e2", "e3"]);
    }
  });

  it("Mongo compiles YEAR(ts) via $toDate", () => {
    expect(compileMongoFilter(in2024.serialize())).toEqual({
      $expr: { $eq: [{ $year: { $toDate: "$ts" } }, { $literal: 2024 }] }
    });
  });

  it("in-memory, SQLite and IndexedDB agree on dateToString(ts) = '2024-01'", async () => {
    const monthFilter = eq(dateToString(field("ts"), "%Y-%m"), "2024-01");
    const p: QueryPlan = { model: "Event", where: monthFilter.serialize(), order: [], paging: { start: 0 } };
    for (const backend of [new InMemoryBackend(), new SQLiteBackend(new DatabaseSync(":memory:")), makeIdb()]) {
      for (const event of events) backend.save("Event", event, ctx);
      await backend.persist(ctx);
      expect((await backend.query(p, ctx)).map((e) => e.uuid)).toEqual(["e2"]); // only the Jan-2024 row
    }
  });

  it("Mongo compiles dateToString via $dateToString over $toDate", () => {
    expect(compileMongoFilter(eq(dateToString(field("ts"), "%Y-%m"), "x").serialize())).toEqual({
      $expr: { $eq: [{ $dateToString: { format: "%Y-%m", date: { $toDate: "$ts" } } }, { $literal: "x" }] }
    });
  });
});

describe("cond/switch run identically across backends (§11)", () => {
  async function seed(backend: Backend) {
    const orm = new RepositoryManager({ backend });
    const songs = orm.define({ name: "Song", properties: { level: text(), plays: integer() } });
    for (const [level, plays] of [["beginner", 10], ["beginner", 5], ["advanced", 20]] as const) {
      songs.save(songs.createInstance({ level, plays }));
    }
    await songs.persist();
    return songs;
  }

  it("sum(cond(...)) and switch weighting agree (in-memory reduce vs SQL CASE WHEN vs IndexedDB scan)", async () => {
    for (const backend of [new InMemoryBackend(), new SQLiteBackend(new DatabaseSync(":memory:")), makeIdb()]) {
      const songs = await seed(backend);
      const stats = await songs.all().aggregate((a) => ({
        beginners: a.sum(cond(cmp(field("level"), "=", "beginner"), 1, 0)),
        weighted: a.sum(
          switchExpr(
            [
              [cmp(field("level"), "=", "beginner"), 1],
              [cmp(field("level"), "=", "advanced"), 3]
            ],
            0
          )
        )
      }));
      expect(stats).toEqual({ beginners: 2, weighted: 1 + 1 + 3 });
    }
  });

  it("Mongo compiles cond inside $expr ($cond over $eq)", () => {
    const filter = eq(cond(cmp(field("level"), "=", "beginner"), lit(1), lit(0)), 1);
    expect(compileMongoFilter(filter.serialize())).toEqual({
      $expr: {
        $eq: [
          { $cond: [{ $eq: ["$level", { $literal: "beginner" }] }, { $literal: 1 }, { $literal: 0 }] },
          { $literal: 1 }
        ]
      }
    });
  });
});
