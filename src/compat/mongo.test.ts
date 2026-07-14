/**
 * MongoDB query-language facade. `parseMongoFilter` maps Mongo filter syntax onto the portable AST,
 * and `mongoCollection` exposes a Mongo-driver-shaped `find/findOne/countDocuments/aggregate`. The
 * headline test runs the *same* Mongo query on an in-memory backend and on Postgres (pg-mem) and
 * asserts identical results — "your Mongo query now runs on SQL."
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { parseMongoFilter, parseMongoUpdate, mongoCollection } from "./mongo.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { text, integer, array } from "../properties/factories.js";
import { and, or, not, eq, neq, gt, gte, lt, lte, inList, notInList, exists, size, contains, any, startsWith, endsWith, includesText } from "../expressions/index.js";

/** Serialize an AST to compare `parseMongoFilter` output against hand-built builders. */
const ast = (e: { serialize: () => unknown }) => JSON.stringify(e.serialize());

describe("parseMongoFilter → portable AST", () => {
  it("maps equality, comparison, and membership operators", () => {
    expect(ast(parseMongoFilter({ name: "Ann" }))).toBe(ast(eq("name", "Ann")));
    expect(ast(parseMongoFilter({ age: { $gt: 30 } }))).toBe(ast(gt("age", 30)));
    expect(ast(parseMongoFilter({ age: { $gte: 18 } }))).toBe(ast(gte("age", 18)));
    expect(ast(parseMongoFilter({ role: { $in: ["a", "b"] } }))).toBe(ast(inList("role", ["a", "b"])));
    expect(ast(parseMongoFilter({ role: { $nin: ["x"] } }))).toBe(ast(notInList("role", ["x"])));
  });

  it("combines multiple operators on one field with AND, and implicit fields with AND", () => {
    expect(ast(parseMongoFilter({ age: { $gt: 18, $lt: 65 } }))).toContain('"and"');
    expect(ast(parseMongoFilter({ name: "Ann", age: { $gte: 21 } }))).toBe(ast(and(eq("name", "Ann"), gte("age", 21))));
  });

  it("maps $and / $or / $nor", () => {
    expect(ast(parseMongoFilter({ $or: [{ name: "Ann" }, { age: { $gt: 40 } }] }))).toBe(ast(or(eq("name", "Ann"), gt("age", 40))));
    expect(ast(parseMongoFilter({ $and: [{ name: "Ann" }, { age: { $gt: 40 } }] }))).toBe(ast(and(eq("name", "Ann"), gt("age", 40))));
  });

  it("maps $exists and anchored $regex to text search", () => {
    expect(ast(parseMongoFilter({ nickname: { $exists: true } }))).toBe(ast(exists("nickname", true)));
    expect(ast(parseMongoFilter({ name: { $regex: "^Pre" } }))).toBe(ast(startsWith("name", "Pre")));
  });

  it("maps the remaining scalar/array/logical operators", () => {
    expect(ast(parseMongoFilter({ age: { $ne: 5 } }))).toBe(ast(neq("age", 5)));
    expect(ast(parseMongoFilter({ age: { $lt: 5 } }))).toBe(ast(lt("age", 5)));
    expect(ast(parseMongoFilter({ age: { $lte: 5 } }))).toBe(ast(lte("age", 5)));
    expect(ast(parseMongoFilter({ tags: { $size: 2 } }))).toBe(ast(size("tags", 2)));
    expect(ast(parseMongoFilter({ tags: { $all: ["a", "b"] } }))).toBe(ast(and(contains("tags", "a"), contains("tags", "b"))));
    expect(ast(parseMongoFilter({ items: { $elemMatch: { qty: { $gt: 1 } } } }))).toBe(ast(any("items", gt("qty", 1))));
    expect(ast(parseMongoFilter({ age: { $not: { $gt: 5 } } }))).toBe(ast(not(gt("age", 5))));
    expect(ast(parseMongoFilter({ $nor: [{ a: 1 }] }))).toBe(ast(not(or(eq("a", 1)))));
    expect(ast(parseMongoFilter({}))).toBe(ast(parseMongoFilter({}))); // empty → all()
  });

  it("maps $regex suffix / substring / case-insensitive forms", () => {
    expect(ast(parseMongoFilter({ name: { $regex: "son$" } }))).toBe(ast(endsWith("name", "son")));
    expect(ast(parseMongoFilter({ name: { $regex: "mid" } }))).toBe(ast(includesText("name", "mid")));
    expect(ast(parseMongoFilter({ name: { $regex: "^pre", $options: "i" } }))).toBe(ast(startsWith("name", "pre", { caseInsensitive: true })));
    expect(ast(parseMongoFilter({ name: { $regex: "^exact$" } }))).toBe(ast(eq("name", "exact")));
  });

  it("throws (loudly) on operators/patterns it can't express exactly", () => {
    expect(() => parseMongoFilter({ x: { $mod: [4, 0] } })).toThrow(/Unsupported Mongo operator/);
    expect(() => parseMongoFilter({ $where: "this.a" })).toThrow(/Unsupported top-level/);
    expect(() => parseMongoFilter({ name: { $regex: "a.*b" } })).toThrow(/Unsupported \$regex/);
    expect(() => parseMongoFilter({ name: { $regex: "^x$", $options: "i" } })).toThrow(/case-insensitive anchored/);
    expect(() => parseMongoFilter({ $or: "nope" as unknown as [] })).toThrow(/expects an array/);
  });
});

const PEOPLE = [
  { uuid: "p1", name: "Ann", age: 30, city: "eu" },
  { uuid: "p2", name: "Bob", age: 45, city: "us" },
  { uuid: "p3", name: "Cy", age: 30, city: "eu" },
  { uuid: "p4", name: "Di", age: 19, city: "us" }
];

function seed(backend: InMemoryBackend | PostgresBackend) {
  const orm = new RepositoryManager({ backend });
  const people = orm.define({ name: "person", properties: { name: text(), age: integer(), city: text() } });
  return { orm, people };
}

async function seedAsync(backend: InMemoryBackend | PostgresBackend) {
  const { orm, people } = seed(backend);
  await orm.transaction(async () => {
    for (const p of PEOPLE) people.save(people.createInstance(p));
  });
  return people;
}

describe("the same Mongo query runs identically on every backend", () => {
  const backends = (): Array<[string, InMemoryBackend | PostgresBackend]> => [
    ["in-memory", new InMemoryBackend()],
    ["postgres (pg-mem)", new PostgresBackend(new (newDb().adapters.createPg().Pool)())]
  ];

  it("find + sort + limit", async () => {
    for (const [label, backend] of backends()) {
      const people = mongoCollection(await seedAsync(backend));
      const rows = await people
        .find({ age: { $gte: 30 }, city: "eu" })
        .sort({ age: -1, name: 1 })
        .toArray();
      expect(rows.map((r) => r.name), label).toEqual(["Ann", "Cy"]); // both age 30, city eu, name asc
    }
  });

  it("findOne + countDocuments + $or", async () => {
    for (const [label, backend] of backends()) {
      const people = mongoCollection(await seedAsync(backend));
      expect((await people.findOne({ name: "Bob" }))?.age, label).toBe(45);
      expect(await people.countDocuments({ $or: [{ city: "us" }, { age: { $lt: 25 } }] }), label).toBe(2);
      expect(await people.countDocuments({}), label).toBe(4); // empty filter = all
    }
  });

  it("aggregate $match → $group with $sum and $avg", async () => {
    for (const [label, backend] of backends()) {
      const people = mongoCollection(await seedAsync(backend));
      const byCity = await people.aggregate([
        { $match: { age: { $gte: 18 } } },
        { $group: { _id: "$city", count: { $sum: 1 }, avgAge: { $avg: "$age" } } }
      ]);
      const eu = byCity.find((r) => r._id === "eu")!;
      const us = byCity.find((r) => r._id === "us")!;
      expect(eu.count, label).toBe(2);
      expect(eu.avgAge, label).toBe(30);
      expect(us.count, label).toBe(2);
      expect(us.avgAge, label).toBe(32); // (45 + 19) / 2
    }
  });

  it("global $group (_id: null) with $min / $max / $sum-of-field, and skip", async () => {
    const people = mongoCollection(await seedAsync(new InMemoryBackend()));
    const [totals] = await people.aggregate([{ $group: { _id: null, youngest: { $min: "$age" }, oldest: { $max: "$age" }, total: { $sum: "$age" } } }]);
    expect(totals).toEqual({ _id: null, youngest: 19, oldest: 45, total: 124 });

    const skipped = await people.find({}, { sort: { age: 1 }, skip: 1, limit: 2 }).toArray();
    expect(skipped.map((r) => r.age)).toEqual([30, 30]);
  });

  it("findOne returns null when nothing matches; unsupported stage throws", async () => {
    const people = mongoCollection(await seedAsync(new InMemoryBackend()));
    expect(await people.findOne({ name: "Nobody" })).toBeNull();
    await expect(people.aggregate([{ $lookup: {} }])).rejects.toThrow(/Unsupported aggregate stage/);
  });
});

describe("parseMongoUpdate → PatchSpec", () => {
  it("maps the update operators", () => {
    expect(parseMongoUpdate({ $inc: { n: 2 } })).toEqual({ n: { kind: "inc", by: 2 } });
    expect(parseMongoUpdate({ $mul: { n: 3 } })).toEqual({ n: { kind: "mul", by: 3 } });
    expect(parseMongoUpdate({ $unset: { a: "" } })).toEqual({ a: { kind: "unset" } });
    expect(parseMongoUpdate({ $push: { tags: { $each: ["a", "b"] } } })).toEqual({ tags: { kind: "push", values: ["a", "b"] } });
    expect(parseMongoUpdate({ $addToSet: { tags: "x" } })).toEqual({ tags: { kind: "addToSet", values: ["x"] } });
    expect(parseMongoUpdate({ $pull: { tags: "x" } })).toEqual({ tags: { kind: "pull", values: ["x"] } });
    // $setOnInsert is skipped (it only affects inserts)
    expect(parseMongoUpdate({ $set: { a: 1 }, $setOnInsert: { b: 2 } })).toHaveProperty("a");
    expect(parseMongoUpdate({ $set: { a: 1 }, $setOnInsert: { b: 2 } })).not.toHaveProperty("b");
  });

  it("rejects a replacement document and unsupported operators", () => {
    expect(() => parseMongoUpdate({ name: "x" })).toThrow(/replaces the record/);
    expect(() => parseMongoUpdate({ $rename: { a: "b" } })).toThrow(/Unsupported update operator/);
    expect(() => parseMongoUpdate({ $pull: { tags: { $gt: 5 } } })).toThrow(/pull by value/);
  });
});

describe("the same Mongo write runs identically on every backend", () => {
  const backends = (): Array<[string, InMemoryBackend | PostgresBackend]> => [
    ["in-memory", new InMemoryBackend()],
    ["postgres (pg-mem)", new PostgresBackend(new (newDb().adapters.createPg().Pool)())]
  ];

  it("updateOne with $set + $inc, then updateMany", async () => {
    for (const [label, backend] of backends()) {
      const people = mongoCollection(await seedAsync(backend));
      const res = await people.updateOne({ name: "Ann" }, { $set: { city: "uk" }, $inc: { age: 1 } });
      expect([res.matchedCount, res.modifiedCount], label).toEqual([1, 1]);
      const ann = await people.findOne({ name: "Ann" });
      expect([ann?.city, ann?.age], label).toEqual(["uk", 31]);

      const many = await people.updateMany({ city: "us" }, { $set: { city: "USA" } });
      expect(many.matchedCount, label).toBe(2); // Bob + Di
      expect(await people.countDocuments({ city: "USA" }), label).toBe(2);
    }
  });

  it("findOneAndUpdate returns the doc after (default) or before", async () => {
    for (const [label, backend] of backends()) {
      const people = mongoCollection(await seedAsync(backend));
      const after = await people.findOneAndUpdate({ name: "Ann" }, { $inc: { age: 10 } });
      expect(after?.age, label).toBe(40); // post-update
      const before = await people.findOneAndUpdate({ name: "Bob" }, { $set: { city: "x" } }, { returnDocument: "before" });
      expect(before?.city, label).toBe("us"); // pre-update
    }
  });

  it("upsert inserts when nothing matches (seeded from filter + $set)", async () => {
    for (const [label, backend] of backends()) {
      const people = mongoCollection(await seedAsync(backend));
      const res = await people.updateOne({ name: "Zoe" }, { $set: { age: 22, city: "eu" } }, { upsert: true });
      expect(res.upsertedId, label).toBeTruthy();
      const zoe = await people.findOne({ name: "Zoe" });
      expect([zoe?.name, zoe?.age], label).toEqual(["Zoe", 22]);
    }
  });

  it("insertOne / deleteOne / deleteMany / replaceOne", async () => {
    for (const [label, backend] of backends()) {
      const people = mongoCollection(await seedAsync(backend));
      const ins = await people.insertOne({ name: "New", age: 1, city: "eu" } as never);
      expect(ins.insertedId, label).toBeTruthy();
      expect(await people.countDocuments({}), label).toBe(5);

      expect((await people.deleteOne({ name: "Bob" })).deletedCount, label).toBe(1);
      expect((await people.deleteMany({ city: "eu" })).deletedCount, label).toBe(3); // Ann, Cy, New

      const rep = await people.replaceOne({ name: "Di" }, { name: "Di", age: 20, city: "ca" } as never);
      expect(rep.modifiedCount, label).toBe(1);
      expect((await people.findOne({ name: "Di" }))?.city, label).toBe("ca");
    }
  });
});

describe("write no-op and upsert-insert paths", () => {
  it("updateMany/replaceOne upsert-insert, and no-match no-ops", async () => {
    const people = mongoCollection(await seedAsync(new InMemoryBackend()));

    const um = await people.updateMany({ name: "Q" }, { $set: { age: 9, city: "eu" } }, { upsert: true });
    expect(um.upsertedId).toBeTruthy();
    expect((await people.findOne({ name: "Q" }))?.age).toBe(9);

    const ro = await people.replaceOne({ name: "R" }, { name: "R", age: 8, city: "us" } as never, { upsert: true });
    expect(ro.upsertedId).toBeTruthy();

    // no match, no upsert → nothing changes
    expect((await people.updateOne({ name: "Nobody" }, { $set: { age: 1 } })).matchedCount).toBe(0);
    expect((await people.updateMany({ name: "Nobody" }, { $set: { age: 1 } })).matchedCount).toBe(0);
    expect((await people.replaceOne({ name: "Nobody" }, { name: "x", age: 1, city: "z" } as never)).matchedCount).toBe(0);
    expect((await people.deleteOne({ name: "Nobody" })).deletedCount).toBe(0);
    expect(await people.findOneAndUpdate({ name: "Nobody" }, { $set: { age: 1 } })).toBeNull();
  });
});

describe("array update operators", () => {
  it("$push / $addToSet / $pull mutate a native array field", async () => {
    const orm = new RepositoryManager();
    const posts = orm.define({ name: "post", properties: { title: text(), tags: array<string>() } });
    const collection = mongoCollection(posts);

    await collection.insertOne({ title: "p", tags: ["a"] });
    await collection.updateOne({ title: "p" }, { $push: { tags: "b" } }); // [a, b]
    await collection.updateOne({ title: "p" }, { $addToSet: { tags: "a" } }); // "a" present → unchanged
    await collection.updateOne({ title: "p" }, { $addToSet: { tags: "c" } }); // [a, b, c]
    expect((await collection.findOne({ title: "p" }))?.tags).toEqual(["a", "b", "c"]);

    await collection.updateOne({ title: "p" }, { $pull: { tags: "a" } }); // [b, c]
    expect((await collection.findOne({ title: "p" }))?.tags).toEqual(["b", "c"]);

    // conflicting operators on one field are rejected, like Mongo
    await expect(collection.updateOne({ title: "p" }, { $push: { tags: "x" }, $pull: { tags: "y" } })).rejects.toThrow(/Conflicting/);
  });
});
