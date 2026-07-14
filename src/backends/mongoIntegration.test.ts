/**
 * Live MongoDB integration — validates the real `MongoBackend` against an actual `mongod`, which the
 * fake-evaluator unit tests can't (real `$group`/`$dateToString`/`$nin` semantics, the real driver's
 * `ObjectId`, real `createIndex`/unique enforcement, atomic `upsert`).
 *
 * Connection: `MONGO_URL` if set, else an in-memory `mongod` (downloaded on first run). If neither is
 * reachable here (sandbox/offline), the whole suite skips — it never breaks the build.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoBackend, objectIdIdentity, type MongoDatabase, type MongoIdentity } from "./mongo/MongoBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer, array, date } from "../properties/factories.js";
import { eq, gt, exists, size, inList, mul, field, year, startsWith } from "../expressions/index.js";
import { inc, push, pull, set } from "../repository/patch.js";

let server: MongoMemoryServer | undefined;
let client: MongoClient | undefined;
let db: Db | undefined;

beforeAll(async () => {
  try {
    let url = process.env.MONGO_URL;
    if (!url) {
      // Pin a real release (the auto-detected latest can 404 on the CDN for newer distros).
      server = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? "8.0.4" } });
      url = server.getUri();
    }
    client = new MongoClient(url);
    await client.connect();
    db = client.db("orm_integration");
  } catch {
    db = undefined; // no server reachable → skip the suite
  }
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  await server?.stop().catch(() => {});
});

function orm(identity?: MongoIdentity) {
  return new RepositoryManager({
    backend: new MongoBackend(db as unknown as MongoDatabase, identity),
    ...(identity ? { generateId: () => new ObjectId().toString() } : {})
  });
}

describe("MongoBackend against a real mongod", () => {
  it("round-trips CRUD and a representative filter set", async (ctx) => {
    if (!db) return ctx.skip();
    const users = orm().define({ name: "users_a", properties: { name: text(), age: integer(), tags: array<string>() } });
    for (const [name, age, tags] of [["Ann", 30, ["x"]], ["Bo", 40, ["y", "z"]], ["Cy", 20, []]] as const) {
      users.save(users.createInstance({ name, age, tags: [...tags] }));
    }
    await users.persist();

    expect(await users.all().count()).toBe(3);
    expect((await users.all().filter(gt("age", 25)).list()).map((u) => u.name).sort()).toEqual(["Ann", "Bo"]);
    expect((await users.all().filter(inList("name", ["Ann", "Cy"])).list()).length).toBe(2);
    expect((await users.all().filter(size("tags", 0)).list()).map((u) => u.name)).toEqual(["Cy"]);
    expect((await users.all().filter(startsWith("name", "A")).list()).map((u) => u.name)).toEqual(["Ann"]);
    // computed filter: age * 2 > 70 → only Bo (80)
    expect((await users.all().filter(gt(mul(field("age"), 2), 70)).list()).map((u) => u.name)).toEqual(["Bo"]);
  });

  it("pushes aggregate / groupBy down to a real $group", async (ctx) => {
    if (!db) return ctx.skip();
    const sales = orm().define({ name: "sales_a", properties: { region: text(), amount: integer() } });
    for (const [region, amount] of [["eu", 10], ["eu", 30], ["us", 100]] as const) {
      sales.save(sales.createInstance({ region, amount }));
    }
    await sales.persist();

    expect(await sales.all().aggregate((a) => ({ n: a.count(), total: a.sum("amount") }))).toEqual({ n: 3, total: 140 });
    const byRegion = await sales.all().groupBy("region", (a) => ({ total: a.sum("amount") }));
    expect(byRegion.find((g) => g.key === "eu")!.total).toBe(40);
  });

  it("groups by a computed date expression (real $year over $toDate)", async (ctx) => {
    if (!db) return ctx.skip();
    const events = orm().define({ name: "events_a", properties: { ts: date(), amount: integer() } });
    for (const [y, amount] of [[2023, 10], [2024, 20], [2024, 5]] as const) {
      events.save(events.createInstance({ ts: new Date(Date.UTC(y, 0, 1)), amount }));
    }
    await events.persist();
    const byYear = await events.all().groupByExpr(year(field("ts")), (a) => ({ total: a.sum("amount") }));
    expect(byYear.find((g) => g.key === 2024)!.total).toBe(25);
  });

  it("applies patch ops natively (inc, array push/pull) and atomic upsert", async (ctx) => {
    if (!db) return ctx.skip();
    const repo = orm().define({ name: "acct_a", properties: { email: text(), n: integer(), tags: array<string>() } });
    const a = repo.createInstance({ email: "a@x.com", n: 0, tags: ["a"] });
    repo.save(a);
    await repo.persist();

    expect((await repo.patch(a.uuid, { n: inc(5), tags: push("b", "c") }))!.tags).toEqual(["a", "b", "c"]);
    expect((await repo.patch(a.uuid, { tags: pull("a") }))!.n).toBe(5);

    // atomic upsert by key: insert then update the same doc
    const created = await repo.upsert(eq("email", "z@x.com"), { set: { n: 1 }, setOnInsert: { email: "z@x.com", tags: [] } });
    const updated = await repo.upsert(eq("email", "z@x.com"), { set: { n: 2 } });
    expect(updated.uuid).toBe(created.uuid);
    expect(updated.n).toBe(2);
    expect(await repo.all().count()).toBe(2);
  });

  it("adopts ObjectId _id and FK fields via the real driver", async (ctx) => {
    if (!db) return ctx.skip();
    const manager = orm(objectIdIdentity(ObjectId as never, { fav_a: ["userId"] }));
    const users = manager.define({ name: "user_a", properties: { email: text() } });
    const favs = manager.define({ name: "fav_a", properties: { userId: text(), label: text() } });

    const user = users.createInstance({ email: "a@x.com" });
    users.save(user);
    await users.persist();
    expect(user.uuid).toMatch(/^[0-9a-f]{24}$/); // a real ObjectId hex

    favs.save(favs.createInstance({ userId: user.uuid, label: "liked" }));
    await favs.persist();

    // stored as ObjectId; queryable by the hex; reads back as hex
    const rawUser = await db.collection("user_a").findOne({});
    expect(rawUser!._id).toBeInstanceOf(ObjectId);
    const rawFav = await db.collection("fav_a").findOne({});
    expect(rawFav!.userId).toBeInstanceOf(ObjectId);
    const [fav] = await favs.all().filter(eq("userId", user.uuid)).list();
    expect(fav!.userId).toBe(user.uuid);
  });

  it("creates declared indexes (unique enforced, TTL/text/partial accepted)", async (ctx) => {
    if (!db) return ctx.skip();
    orm().define({
      name: "doc_a",
      properties: { a: text(), b: text(), title: text(), createdAt: date() },
      indexes: [
        { name: "ab", fields: ["a", "b"], unique: true },
        { name: "ttl", fields: ["createdAt"], ttlSeconds: 3600 },
        { name: "search", fields: ["title"], text: true },
        { name: "partial", fields: ["a"], where: exists("a") }
      ]
    });

    // poll until the fire-and-forget createIndex calls land
    const collection = db.collection("doc_a");
    let names: string[] = [];
    for (let i = 0; i < 40 && !["ab", "ttl", "search", "partial"].every((n) => names.includes(n)); i++) {
      names = (await collection.listIndexes().toArray()).map((ix) => ix.name as string);
      if (!["ab", "ttl", "search", "partial"].every((n) => names.includes(n))) await new Promise((r) => setTimeout(r, 50));
    }
    expect(names).toEqual(expect.arrayContaining(["ab", "ttl", "search", "partial"]));

    const indexes = await collection.listIndexes().toArray();
    expect(indexes.find((ix) => ix.name === "ab")!.unique).toBe(true);
    expect(indexes.find((ix) => ix.name === "ttl")!.expireAfterSeconds).toBe(3600);
    expect(indexes.find((ix) => ix.name === "search")!.key).toMatchObject({ _fts: "text" });
    expect(indexes.find((ix) => ix.name === "partial")!.partialFilterExpression).toEqual({ a: { $exists: true } });
  });
});
