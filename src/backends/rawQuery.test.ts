/**
 * The raw-query escape hatch (`orm.raw` / `Backend.raw`) — for queries the compiler can't express.
 * SQL is exercised behaviorally on pg-mem (a self-join and a computed projection, neither of which
 * the plan compiler emits); the Mongo pipeline hatch and the decorator/plumbing paths are checked
 * against fakes.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { PolicyBackend } from "./decorators/PolicyBackend.js";
import { MongoBackend } from "./mongo/MongoBackend.js";
import type { MongoCollection, MongoDatabase } from "./mongo/MongoBackend.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { gt } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;

/** A fresh pg-mem-backed manager with a `raw_users` model seeded with a few rows. */
async function seededPgOrm(backend = new PostgresBackend(new (newDb().adapters.createPg().Pool)())) {
  const orm = new RepositoryManager({ backend });
  const users = orm.define({ name: "raw_users", properties: { name: text(), age: integer() } });
  await orm.transaction(async () => {
    users.save(users.createInstance({ name: "Ann", age: 30 }));
    users.save(users.createInstance({ name: "Bo", age: 30 }));
    users.save(users.createInstance({ name: "Cy", age: 40 }));
  });
  return { orm, users };
}

describe("raw SQL escape hatch", () => {
  it("runs a self-join the compiler can't express and returns driver rows", async () => {
    const { orm } = await seededPgOrm();
    // Same-age pairs — a self-join, which the plan compiler has no way to emit.
    const pairs = await orm.raw<{ a: string; b: string }>({
      sql: `SELECT a.name AS a, b.name AS b FROM "raw_users" a
            JOIN "raw_users" b ON a.age = b.age AND a.name < b.name
            ORDER BY a.name, b.name`
    });
    expect(pairs).toEqual([{ a: "Ann", b: "Bo" }]);
  });

  it("binds params in the dialect's own placeholder style ($1)", async () => {
    const { orm } = await seededPgOrm();
    const rows = await orm.raw<{ name: string; double_age: number }>({
      sql: `SELECT name, age * 2 AS double_age FROM "raw_users" WHERE age > $1 ORDER BY name`,
      params: [30]
    });
    expect(rows).toEqual([{ name: "Cy", double_age: 80 }]);
  });

  it("shares the transaction/connection plumbing — a raw INSERT is visible to the ORM", async () => {
    const { orm, users } = await seededPgOrm();
    await orm.raw({ sql: `INSERT INTO "raw_users" ("uuid", "name", "age") VALUES ($1, $2, $3)`, params: ["x1", "Di", 55] });
    expect(await users.all().filter(gt("age", 50)).count()).toBe(1);
  });
});

describe("orm.raw plumbing", () => {
  it("throws when the backend has no raw hatch (in-memory)", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    await expect(orm.raw({ sql: "SELECT 1" })).rejects.toThrow(/does not support raw queries/);
  });

  it("forwards through a PolicyBackend to the inner store", async () => {
    const inner = new PostgresBackend(new (newDb().adapters.createPg().Pool)());
    const orm = new RepositoryManager({ backend: new PolicyBackend(inner, {}) });
    const users = orm.define({ name: "raw_users", properties: { name: text(), age: integer() } });
    await orm.transaction(async () => users.save(users.createInstance({ name: "Ann", age: 30 })));

    const rows = await orm.raw<{ n: number }>({ sql: `SELECT COUNT(*)::int AS n FROM "raw_users"` });
    expect(rows[0]!.n).toBe(1);
  });

  it("a PolicyBackend over a non-raw store reports the missing hatch", async () => {
    const policy = new PolicyBackend(new InMemoryBackend(), {});
    await expect(policy.raw({ sql: "SELECT 1" }, ctx)).rejects.toThrow(/does not support raw queries/);
  });

  it("PolicyBackend.registerModel forwards fields, so the columnar table keeps its columns", async () => {
    // Regression: the decorator used to drop the `fields` arg, so a policy-wrapped SQL model built a
    // column-less table and any scalar-column filter blew up. Filtering on `age` proves the column exists.
    const inner = new PostgresBackend(new (newDb().adapters.createPg().Pool)());
    const orm = new RepositoryManager({ backend: new PolicyBackend(inner, {}) });
    const users = orm.define({ name: "policy_users", properties: { name: text(), age: integer() } });
    await orm.transaction(async () => {
      users.save(users.createInstance({ name: "Ann", age: 20 }));
      users.save(users.createInstance({ name: "Bo", age: 40 }));
    });
    expect(await users.all().filter(gt("age", 30)).count()).toBe(1);
  });
});

describe("raw Mongo pipeline escape hatch", () => {
  it("forwards a pipeline to db.collection(name).aggregate(...) and returns its docs", async () => {
    const captured: { name?: string; pipeline?: object[] } = {};
    const out = [{ _id: "eu", total: 42 }];
    const db: MongoDatabase = {
      collection(name: string) {
        captured.name = name;
        return {
          aggregate(pipeline: object[]) {
            captured.pipeline = pipeline;
            return { toArray: async () => out };
          }
        } as unknown as MongoCollection;
      }
    };
    const be = new MongoBackend(db);
    const pipeline = [{ $group: { _id: "$region", total: { $sum: "$amount" } } }];
    const rows = await be.raw({ collection: "sales", pipeline }, ctx);

    expect(captured.name).toBe("sales");
    expect(captured.pipeline).toBe(pipeline);
    expect(rows).toEqual(out);
  });
});
