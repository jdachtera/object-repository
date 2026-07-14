import { describe, it, expect } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "./indexeddb/IndexedDBBackend.js";
import { compileMongoFilter } from "./mongo/MongoBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer, relationToMany } from "../properties/factories.js";
import { any, eq, neq, gt, div, mul, field } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Backend } from "../core/Backend.js";
import type { QueryPlan } from "../core/QueryPlan.js";

const ctx = SYSTEM_CONTEXT;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const orders = [
  { uuid: "o1", items: [{ sku: "X", qty: 1 }, { sku: "Y", qty: 5 }], langs: ["de", "en"] },
  { uuid: "o2", items: [{ sku: "Z", qty: 2 }], langs: ["fr"] },
  { uuid: "o3", items: [{ sku: "X", qty: 9 }], langs: ["en"] }
];

function plan(where: QueryPlan["where"]): QueryPlan {
  return { model: "Order", where, order: [], paging: { start: 0 } };
}

function runSuite(name: string, makeBackend: () => Backend) {
  describe(`array element matching on ${name}`, () => {
    it("matches objects in an embedded array (any + field predicate)", async () => {
      const backend = makeBackend();
      for (const order of orders) backend.save("Order", order, ctx);
      await backend.persist(ctx);

      const withX = await backend.query(plan(any("items", eq("sku", "X")).serialize()), ctx);
      expect(withX.map((o) => o.uuid).sort()).toEqual(["o1", "o3"]);

      const bigQty = await backend.query(plan(any("items", gt("qty", 4)).serialize()), ctx);
      expect(bigQty.map((o) => o.uuid).sort()).toEqual(["o1", "o3"]);
    });

    it("matches bare scalar elements via the `value` field", async () => {
      const backend = makeBackend();
      for (const order of orders) backend.save("Order", order, ctx);
      await backend.persist(ctx);
      const german = await backend.query(plan(any("langs", eq("value", "de")).serialize()), ctx);
      expect(german.map((o) => o.uuid)).toEqual(["o1"]);
    });
  });
}

let idbSeq = 0;
runSuite("InMemoryBackend", () => new InMemoryBackend());
runSuite("SQLiteBackend", () => new SQLiteBackend(new DatabaseSync(":memory:")));
runSuite(
  "IndexedDBBackend",
  () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `arraymatch-idb-${idbSeq++}` })
);

describe("array element matching — Mongo compilation", () => {
  it("compiles `any` to $elemMatch", () => {
    expect(compileMongoFilter(any("items", eq("sku", "X")).serialize())).toEqual({
      items: { $elemMatch: { sku: "X" } }
    });
    expect(compileMongoFilter(any("items", gt("qty", 4)).serialize())).toEqual({
      items: { $elemMatch: { qty: { $gt: 4 } } }
    });
  });

  it("wraps a bare scalar element predicate in an operator ($elemMatch needs an object)", () => {
    // `{langs: {$elemMatch: "de"}}` is rejected by Mongo; the scalar must become `{$eq: "de"}`.
    expect(compileMongoFilter(any("langs", eq("value", "de")).serialize())).toEqual({
      langs: { $elemMatch: { $eq: "de" } }
    });
    expect(compileMongoFilter(any("langs", gt("value", 5)).serialize())).toEqual({
      langs: { $elemMatch: { $gt: 5 } }
    });
  });
});

describe("Mongo compilation — cross-backend edge parity", () => {
  it("null equality targets the BSON null type only (never a missing field)", () => {
    expect(compileMongoFilter(eq("x", null).serialize())).toEqual({ x: { $type: "null" } });
    expect(compileMongoFilter(neq("x", null).serialize())).toEqual({ x: { $not: { $type: "null" } } });
  });

  it("division guards a zero divisor and coerces null operands (no aggregation abort)", () => {
    expect(compileMongoFilter(gt(div(field("a"), field("b")), 1).serialize())).toEqual({
      $expr: {
        $gt: [
          {
            $cond: [
              { $eq: [{ $ifNull: ["$b", 0] }, 0] },
              0,
              { $divide: [{ $ifNull: ["$a", 0] }, { $ifNull: ["$b", 0] }] }
            ]
          },
          { $literal: 1 }
        ]
      }
    });
  });
});

describe("aggregates over value expressions", () => {
  it("sums a computed value (revenue = price * qty)", async () => {
    const orm = new RepositoryManager();
    const lines = orm.define({ name: "Line", properties: { price: integer(), qty: integer(), label: text() } });
    lines.save(lines.createInstance({ price: 10, qty: 2, label: "a" })); // 20
    lines.save(lines.createInstance({ price: 5, qty: 4, label: "a" })); //  20
    lines.save(lines.createInstance({ price: 7, qty: 1, label: "b" })); //   7
    await lines.persist();

    const totals = await lines.all().aggregate((a) => ({
      revenue: a.sum(mul(field("price"), field("qty"))),
      maxLine: a.max(mul(field("price"), field("qty")))
    }));
    expect(totals.revenue).toBe(47);
    expect(totals.maxLine).toBe(20);

    const byLabel = await lines.all().groupBy("label", (a) => ({ revenue: a.sum(mul(field("price"), field("qty"))) }));
    expect(byLabel.find((g) => g.key === "a")!.revenue).toBe(40);
    expect(byLabel.find((g) => g.key === "b")!.revenue).toBe(7);
  });
});
