import { describe, it, expect, vi } from "vitest";
import {
  MongoBackend,
  compileMongoFilter,
  type MongoCollection,
  type MongoDatabase,
  type MongoFilter,
  type MongoFindOptions
} from "./mongo/MongoBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { UniqueConstraintError } from "./util/unique.js";
import { text, integer, date, array } from "../properties/factories.js";
import { all, eq, neq, gt, or, and, not, inList, notInList, between, contains, exists, size, year, field, mul } from "../expressions/index.js";
import { gt as gtBuilder } from "../expressions/builders.js";
import { set as setOp, push as pushOp, addToSet as addToSetOp, pull as pullOp } from "../repository/patch.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { QueryPlan, ExpressionNode } from "../core/QueryPlan.js";

const ctx = SYSTEM_CONTEXT;

describe("Mongo filter compilation (no server)", () => {
  const cases: Array<[string, ExpressionNode, MongoFilter]> = [
    ["all", all().serialize(), {}],
    ["eq", eq("name", "Peter").serialize(), { name: "Peter" }],
    ["neq", neq("name", "Peter").serialize(), { name: { $ne: "Peter" } }],
    ["gt", gt("age", 30).serialize(), { age: { $gt: 30 } }],
    ["in", inList("city", ["B", "P"]).serialize(), { city: { $in: ["B", "P"] } }],
    ["nin", notInList("city", ["B", "P"]).serialize(), { city: { $nin: ["B", "P"] } }],
    ["between", between("age", 30, 40).serialize(), { age: { $gte: 30, $lte: 40 } }],
    ["contains", contains("langs", "de").serialize(), { langs: "de" }],
    ["exists", exists("publishAt").serialize(), { publishAt: { $exists: true } }],
    ["exists(false)", exists("deletedAt", false).serialize(), { deletedAt: { $exists: false } }],
    ["size", size("tags", 3).serialize(), { tags: { $size: 3 } }],
    ["and", and(eq("a", 1), gt("b", 2)).serialize(), { $and: [{ a: 1 }, { b: { $gt: 2 } }] }],
    ["or", or(eq("a", 1), eq("a", 2)).serialize(), { $or: [{ a: 1 }, { a: 2 }] }],
    ["not", not(eq("a", 1)).serialize(), { $nor: [{ a: 1 }] }]
  ];

  for (const [name, node, expected] of cases) {
    it(`compiles ${name}`, () => {
      expect(compileMongoFilter(node)).toEqual(expected);
    });
  }
});

// A faithful in-memory evaluator of the Mongo filters the compiler emits, so the backend can be
// round-trip tested without a server. Supports exactly the operators MongoVisitor produces.
function matchMongo(doc: Record<string, unknown>, filter: MongoFilter): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$and") {
      if (!(cond as MongoFilter[]).every((c) => matchMongo(doc, c))) return false;
    } else if (key === "$or") {
      if (!(cond as MongoFilter[]).some((c) => matchMongo(doc, c))) return false;
    } else if (key === "$nor") {
      if ((cond as MongoFilter[]).some((c) => matchMongo(doc, c))) return false;
    } else if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, val] of Object.entries(cond as Record<string, unknown>)) {
        if (!matchOp(doc[key], op, val)) return false;
      }
    } else {
      const actual = doc[key];
      if (Array.isArray(actual) ? !actual.includes(cond) : actual !== cond) return false;
    }
  }
  return true;
}

function matchOp(actual: unknown, op: string, val: unknown): boolean {
  switch (op) {
    case "$ne": return actual !== val;
    case "$gt": return (actual as number) > (val as number);
    case "$lt": return (actual as number) < (val as number);
    case "$gte": return (actual as number) >= (val as number);
    case "$lte": return (actual as number) <= (val as number);
    case "$in": return (val as unknown[]).includes(actual);
    case "$nin": return !(val as unknown[]).includes(actual);
    // For JSON docs `actual` is `undefined` only when the field is absent (a stored null is `null`),
    // so this mirrors Mongo's `$exists` (present-incl-null vs. missing).
    case "$exists": return (actual !== undefined) === (val as boolean);
    case "$size": return Array.isArray(actual) && actual.length === (val as number);
    default: return false;
  }
}

// A faithful evaluator of the aggregation expressions MONGO_VALUES emits, so $group can be tested.
function evalExpr(doc: Record<string, unknown>, expr: unknown): unknown {
  if (expr === null) return null;
  if (typeof expr === "number" || typeof expr === "boolean") return expr;
  if (typeof expr === "string") return expr.startsWith("$") ? getPath(doc, expr.slice(1)) : expr;
  if (typeof expr === "object") {
    const e = expr as Record<string, unknown>;
    if ("$literal" in e) return e.$literal;
    const nums = (key: string) => (e[key] as unknown[]).map((x) => Number(evalExpr(doc, x)) || 0);
    if ("$add" in e) return nums("$add").reduce((a, b) => a + b, 0);
    if ("$subtract" in e) { const n = nums("$subtract"); return (n[0] ?? 0) - (n[1] ?? 0); }
    if ("$multiply" in e) return nums("$multiply").reduce((a, b) => a * b, 1);
    if ("$divide" in e) { const n = nums("$divide"); return (n[0] ?? 0) / (n[1] ?? 1); }
    if ("$mod" in e) { const n = nums("$mod"); return (n[0] ?? 0) % (n[1] ?? 1); }
    if ("$concat" in e) return (e.$concat as unknown[]).map((x) => String(evalExpr(doc, x))).join("");
    if ("$ifNull" in e) { const args = e.$ifNull as unknown[]; const v = evalExpr(doc, args[0]); return v ?? evalExpr(doc, args[1]); }
    if ("$toDate" in e) return new Date(Number(evalExpr(doc, e.$toDate)));
    if ("$year" in e) return asDate(evalExpr(doc, e.$year)).getUTCFullYear();
    if ("$month" in e) return asDate(evalExpr(doc, e.$month)).getUTCMonth() + 1;
    if ("$dayOfMonth" in e) return asDate(evalExpr(doc, e.$dayOfMonth)).getUTCDate();
    if ("$dayOfWeek" in e) return asDate(evalExpr(doc, e.$dayOfWeek)).getUTCDay() + 1;
    if ("$hour" in e) return asDate(evalExpr(doc, e.$hour)).getUTCHours();
    // a compound _id sub-document: { g0: "$x", g1: "$y" }
    return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, evalExpr(doc, v)]));
  }
  return undefined;
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => (cur as Record<string, unknown> | undefined)?.[key], doc);
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(Number(value));
}

function accumulate(acc: Record<string, unknown>, rows: Record<string, unknown>[]): unknown {
  const [op, arg] = Object.entries(acc)[0]!;
  if (op === "$sum") return rows.reduce((s, r) => { const v = evalExpr(r, arg); return s + (typeof v === "number" && Number.isFinite(v) ? v : 0); }, 0);
  const nums = rows.map((r) => evalExpr(r, arg)).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (op === "$avg") return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  if (op === "$min") return nums.length ? Math.min(...nums) : null;
  if (op === "$max") return nums.length ? Math.max(...nums) : null;
  return null;
}

function groupStage(docs: Record<string, unknown>[], group: Record<string, unknown>): Record<string, unknown>[] {
  const { _id, ...accs } = group;
  const buckets = new Map<string, { id: unknown; rows: Record<string, unknown>[] }>();
  for (const doc of docs) {
    const id = evalExpr(doc, _id);
    const key = JSON.stringify(id ?? null);
    const bucket = buckets.get(key) ?? { id, rows: [] };
    bucket.rows.push(doc);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(({ id, rows }) => ({
    _id: id,
    ...Object.fromEntries(Object.entries(accs).map(([name, acc]) => [name, accumulate(acc as Record<string, unknown>, rows)]))
  }));
}

function applyUpdate(doc: Record<string, unknown>, update: object): void {
  if (Array.isArray(update)) {
    // aggregation-pipeline update: each $set stage evaluates all fields against the stage's input doc
    for (const stage of update as Array<{ $set?: Record<string, unknown>; $unset?: string[] }>) {
      if (stage.$set) {
        const before = { ...doc };
        for (const [field, expr] of Object.entries(stage.$set)) doc[field] = evalExpr(before, expr);
      }
      if (stage.$unset) for (const field of stage.$unset) delete doc[field];
    }
    return;
  }
  const ops = update as {
    $set?: Record<string, unknown>;
    $unset?: Record<string, unknown>;
    $inc?: Record<string, number>;
    $mul?: Record<string, number>;
    $push?: Record<string, { $each: unknown[] }>;
    $addToSet?: Record<string, { $each: unknown[] }>;
    $pullAll?: Record<string, unknown[]>;
  };
  for (const [field, value] of Object.entries(ops.$set ?? {})) doc[field] = value;
  for (const field of Object.keys(ops.$unset ?? {})) delete doc[field];
  for (const [field, by] of Object.entries(ops.$inc ?? {})) doc[field] = Number(doc[field] ?? 0) + by;
  for (const [field, by] of Object.entries(ops.$mul ?? {})) doc[field] = Number(doc[field] ?? 0) * by;
  const arr = (field: string): unknown[] => (Array.isArray(doc[field]) ? (doc[field] as unknown[]) : []);
  for (const [field, spec] of Object.entries(ops.$push ?? {})) doc[field] = [...arr(field), ...spec.$each];
  for (const [field, spec] of Object.entries(ops.$addToSet ?? {})) {
    const next = arr(field);
    for (const v of spec.$each) if (!next.includes(v)) next.push(v);
    doc[field] = next;
  }
  for (const [field, values] of Object.entries(ops.$pullAll ?? {})) doc[field] = arr(field).filter((e) => !values.includes(e));
}

class FakeCollection implements MongoCollection {
  constructor(private docs: Record<string, unknown>[] = []) {}

  indexes: Array<{ keys: Record<string, unknown>; options?: object }> = [];
  async createIndex(keys: Record<string, unknown>, options?: object): Promise<unknown> {
    this.indexes.push({ keys, options });
    return "idx";
  }

  aggregate(pipeline: object[]) {
    let docs = this.docs.map((doc) => ({ ...doc }));
    for (const stage of pipeline as Array<{ $match?: MongoFilter; $group?: Record<string, unknown> }>) {
      if (stage.$match) { const match = stage.$match; docs = docs.filter((doc) => matchMongo(doc, match)); }
      else if (stage.$group) docs = groupStage(docs, stage.$group);
    }
    return { toArray: async () => docs };
  }

  find(filter: MongoFilter, options: MongoFindOptions = {}) {
    let result = this.docs.filter((doc) => matchMongo(doc, filter));
    if (options.sort) {
      const entries = Object.entries(options.sort);
      result = [...result].sort((a, b) => {
        for (const [field, dir] of entries) {
          const av = a[field] as number | string;
          const bv = b[field] as number | string;
          if (av < bv) return -dir;
          if (av > bv) return dir;
        }
        return 0;
      });
    }
    if (options.skip) result = result.slice(options.skip);
    if (options.limit !== undefined) result = result.slice(0, options.limit);
    return { toArray: async () => result.map((doc) => ({ ...doc })) };
  }

  async countDocuments(filter: MongoFilter): Promise<number> {
    return this.docs.filter((doc) => matchMongo(doc, filter)).length;
  }

  async updateOne(filter: MongoFilter, update: object, options: { upsert?: boolean } = {}): Promise<unknown> {
    const doc = this.docs.find((d) => matchMongo(d, filter));
    if (doc) {
      applyUpdate(doc, update);
      return { modifiedCount: 1 };
    }
    if (options.upsert) {
      // seed the new doc from the filter's equality fields, then $set + $setOnInsert
      const inserted: Record<string, unknown> = {};
      for (const [key, cond] of Object.entries(filter)) {
        if (cond === null || typeof cond !== "object") inserted[key] = cond;
      }
      const u = update as { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> };
      Object.assign(inserted, u.$set ?? {}, u.$setOnInsert ?? {});
      this.docs.push(inserted);
      return { upsertedId: inserted.uuid, modifiedCount: 0 };
    }
    return { modifiedCount: 0 };
  }

  async updateMany(filter: MongoFilter, update: object): Promise<unknown> {
    const matched = this.docs.filter((doc) => matchMongo(doc, filter));
    for (const doc of matched) applyUpdate(doc, update);
    return { modifiedCount: matched.length };
  }

  async bulkWrite(operations: object[]): Promise<unknown> {
    for (const op of operations as Array<Record<string, { filter: { uuid: unknown }; update?: object }>>) {
      if (op.updateOne) {
        const { filter, update } = op.updateOne;
        const idx = this.docs.findIndex((d) => d.uuid === filter.uuid);
        // Merge in place (like real Mongo's $set/$unset) rather than replacing the doc — a
        // dirty-field-scoped $set must leave untouched fields alone, not erase them.
        if (idx >= 0) applyUpdate(this.docs[idx]!, update!);
        else {
          const inserted: Record<string, unknown> = {};
          applyUpdate(inserted, update!);
          this.docs.push(inserted);
        }
      } else if (op.deleteOne) {
        const target = op.deleteOne.filter.uuid;
        this.docs = this.docs.filter((d) => d.uuid !== target);
      }
    }
    return {};
  }
}

class FakeDb implements MongoDatabase {
  private readonly collections = new Map<string, FakeCollection>();
  collection(name: string): FakeCollection {
    let c = this.collections.get(name);
    if (!c) {
      c = new FakeCollection();
      this.collections.set(name, c);
    }
    return c;
  }
}

function plan(model: string, where: ExpressionNode = all().serialize()): QueryPlan {
  return { model, where, order: [], paging: { start: 0 } };
}

describe("MongoBackend (round-trip against an in-memory Mongo evaluator)", () => {
  async function seed(backend: MongoBackend) {
    backend.save("User", { uuid: "u1", name: "Peter", age: 35 }, ctx);
    backend.save("User", { uuid: "u2", name: "John", age: 40 }, ctx);
    backend.save("User", { uuid: "u3", name: "Jane", age: 25 }, ctx);
    await backend.persist(ctx);
  }

  it("queries, filters, and counts through compiled Mongo filters", async () => {
    const backend = new MongoBackend(new FakeDb());
    await seed(backend);
    expect(await backend.query(plan("User"), ctx)).toHaveLength(3);
    expect((await backend.query(plan("User", gt("age", 30).serialize()), ctx)).map((u) => u.uuid).sort()).toEqual(["u1", "u2"]);
    expect(await backend.count(plan("User", gt("age", 30).serialize()), ctx)).toBe(2);
  });

  it("removes records and emits change events", async () => {
    const backend = new MongoBackend(new FakeDb());
    const listener = vi.fn();
    backend.changes(listener, ctx);
    await seed(backend);
    backend.remove("User", { uuid: "u2" }, ctx);
    await backend.persist(ctx);
    expect((await backend.query(plan("User"), ctx)).map((u) => u.uuid).sort()).toEqual(["u1", "u3"]);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ uuid: "u2", kind: "removed" }));
  });

  it("pre-write unique check (opt-in) rejects a duplicate before bulkWrite with UniqueConstraintError", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb(), undefined, { uniquePreCheck: true }) });
    const users = orm.define({ name: "UU", properties: { email: text({ unique: true }), name: text() } });
    users.save(users.createInstance({ email: "a@x.io", name: "A" }));
    await users.persist();

    users.save(users.createInstance({ email: "a@x.io", name: "B" })); // duplicate email
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await users.all().count()).toBe(1); // the conflicting write did not land

    // distinct value + same-uuid re-save are allowed; two absent (null) values are distinct
    const c = users.createInstance({ email: "c@x.io", name: "C" });
    users.save(c);
    await users.persist();
    c.name = "C2";
    users.save(c); // re-save same uuid
    users.save(users.createInstance({ name: "no-email-1" }));
    users.save(users.createInstance({ name: "no-email-2" })); // both email-absent → distinct
    await expect(users.persist()).resolves.toBeDefined();
    expect(await users.all().count()).toBe(4);

    // same-batch duplicate is caught in memory
    users.save(users.createInstance({ email: "z@x.io", name: "Z1" }));
    users.save(users.createInstance({ email: "z@x.io", name: "Z2" }));
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it("provisions declared indexes via createIndex (compound/unique/TTL/text/partial)", () => {
    const db = new FakeDb();
    const orm = new RepositoryManager({ backend: new MongoBackend(db) });
    orm.define({
      name: "Doc",
      properties: { a: text(), b: text(), title: text(), createdAt: date() },
      indexes: [
        { name: "ab", fields: ["a", { path: "b", descending: true }], unique: true },
        { name: "ttl", fields: ["createdAt"], ttlSeconds: 3600 },
        { name: "search", fields: ["title"], text: true },
        { name: "partial", fields: ["a"], where: exists("a") }
      ]
    });
    const created = (db.collection("Doc") as FakeCollection).indexes;
    const byName = (n: string) => created.find((i) => (i.options as { name?: string }).name === n)!;

    expect(byName("ab").keys).toEqual({ a: 1, b: -1 });
    expect((byName("ab").options as { unique?: boolean }).unique).toBe(true);
    expect((byName("ttl").options as { expireAfterSeconds?: number }).expireAfterSeconds).toBe(3600);
    expect(byName("search").keys).toEqual({ title: "text" });
    expect((byName("partial").options as { partialFilterExpression?: unknown }).partialFilterExpression).toEqual({
      a: { $exists: true }
    });
  });

  it("runs the full Repository stack over MongoBackend", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });
    users.save(users.createInstance({ name: "Peter", age: 35 }));
    users.save(users.createInstance({ name: "John", age: 40 }));
    await users.persist();

    expect(await users.all().count()).toBe(2); // countDocuments push-down
    const over38 = await users.all().filter(gtBuilder("age", 38)).list();
    expect(over38.map((u) => u.name)).toEqual(["John"]);
  });

  it("upsert pushes down to an atomic updateOne(upsert: true)", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const users = orm.define({ name: "User", properties: { email: text(), name: text(), logins: integer() } });

    // insert: $set + $setOnInsert combine into the new doc (with a generated uuid)
    const created = await users.upsert(eq("email", "a@x.com"), { set: { name: "Ann" }, setOnInsert: { email: "a@x.com", logins: 0 } });
    expect(created.name).toBe("Ann");
    expect(created.logins).toBe(0);
    expect(created.uuid).toHaveLength(32);
    expect(await users.all().count()).toBe(1);

    // update by the same key: $set applies, $setOnInsert ignored, same doc (atomic)
    const updated = await users.upsert(eq("email", "a@x.com"), { set: { name: "Annie" }, setOnInsert: { logins: 999 } });
    expect(updated.uuid).toBe(created.uuid);
    expect(updated.name).toBe("Annie");
    expect(updated.logins).toBe(0);
    expect(await users.all().count()).toBe(1);
  });

  it("save()-triggered write only $sets the changed fields, and $unsets a removed one (dirty-field tracking)", async () => {
    const ops: Array<Record<string, { update?: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> } }>> = [];
    class RecordingCollection extends FakeCollection {
      override async bulkWrite(operations: object[]) {
        ops.push(...(operations as (typeof ops)[number][]));
        return super.bulkWrite(operations);
      }
    }
    class RecordingDb implements MongoDatabase {
      private readonly collections = new Map<string, RecordingCollection>();
      collection(name: string): RecordingCollection {
        let c = this.collections.get(name);
        if (!c) {
          c = new RecordingCollection();
          this.collections.set(name, c);
        }
        return c;
      }
    }

    const db = new RecordingDb();
    const orm = new RepositoryManager({ backend: new MongoBackend(db) });
    const users = orm.define({ name: "User", properties: { name: text(), age: integer(), city: text() } });
    const ann = users.createInstance({ name: "Ann", age: 30, city: "eu" });
    users.save(ann);
    await users.persist();
    ops.length = 0;

    ann.age = 31; // only `age` changed
    users.save(ann);
    await users.persist();

    expect(ops).toHaveLength(1);
    const update = ops[0]!.updateOne!.update!;
    expect(update.$set).toEqual({ age: 31 });
    expect(update.$unset).toBeUndefined();
    // Re-read through a fresh repository sharing the same underlying fake store — a real fetch, not
    // the identity-map cache — to confirm the scoped $set didn't clobber the fields it left out.
    const reader = new RepositoryManager({ backend: new MongoBackend(db) }).define({
      name: "User",
      properties: { name: text(), age: integer(), city: text() }
    });
    expect(await reader.get(ann.uuid)).toMatchObject({ name: "Ann", age: 31, city: "eu" });

    delete (ann as { city?: string }).city;
    users.save(ann);
    await users.persist();
    const removalUpdate = ops.at(-1)!.updateOne!.update!;
    expect(removalUpdate.$unset).toEqual({ city: "" });
  });

  it("applies array patch ops via $push / $addToSet / $pullAll", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const users = orm.define({ name: "User", properties: { name: text(), tags: array<string>() } });
    const user = users.createInstance({ name: "x", tags: ["a"] });
    users.save(user);
    await users.persist();

    expect((await users.patch(user.uuid, { tags: pushOp("b", "c") }))!.tags).toEqual(["a", "b", "c"]);
    expect((await users.patch(user.uuid, { tags: addToSetOp("c", "d") }))!.tags).toEqual(["a", "b", "c", "d"]);
    expect((await users.patch(user.uuid, { tags: pullOp("a", "c") }))!.tags).toEqual(["b", "d"]);
  });

  it("patches a computed set via an aggregation-pipeline update", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const lines = orm.define({ name: "Line", properties: { price: integer(), qty: integer(), total: integer() } });
    const line = lines.createInstance({ price: 10, qty: 4, total: 0 });
    lines.save(line);
    await lines.persist();

    const updated = await lines.patch(line.uuid, { total: setOp(mul(field("price"), field("qty"))) });
    expect(updated!.total).toBe(40);
  });

  it("patchWhere pushes down to updateMany", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const items = orm.define({ name: "Item", properties: { stock: integer(), status: text() } });
    for (const [stock, status] of [[0, "ok"], [5, "ok"], [0, "ok"]] as const) {
      items.save(items.createInstance({ stock, status }));
    }
    await items.persist();

    const n = await items.patchWhere(gtBuilder("stock", 0), { stock: setOp(99) });
    expect(n).toBe(1);
    expect((await items.all().filter(gtBuilder("stock", 50)).list()).map((i) => i.stock)).toEqual([99]);
  });

  it("groups by multiple keys via a compound $group _id sub-document", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const sales = orm.define({ name: "Sale", properties: { region: text(), product: text(), amount: integer() } });
    for (const [region, product, amount] of [["eu", "a", 10], ["eu", "a", 5], ["us", "a", 100]] as const) {
      sales.save(sales.createInstance({ region, product, amount }));
    }
    await sales.persist();

    const groups = await sales.all().groupByMany([field("region"), field("product")], (a) => ({ n: a.count(), total: a.sum("amount") }));
    expect(groups.find((g) => g.key[0] === "eu" && g.key[1] === "a")).toEqual({ key: ["eu", "a"], n: 2, total: 15 });
    expect(groups.find((g) => g.key[0] === "us" && g.key[1] === "a")).toEqual({ key: ["us", "a"], n: 1, total: 100 });
  });

  it("pushes aggregate() / groupBy() down to a $group pipeline", async () => {
    const backend = new MongoBackend(new FakeDb());
    await seed(backend);

    // global aggregate
    const global = await backend.aggregate(
      { model: "User", where: all().serialize(), groupBy: [], aggregates: [
        { name: "n", op: "count" },
        { name: "avgAge", op: "avg", value: { type: "field", path: "age" } },
        { name: "oldest", op: "max", value: { type: "field", path: "age" } }
      ] },
      ctx
    );
    expect(global).toEqual([{ key: [], values: { n: 3, avgAge: (35 + 40 + 25) / 3, oldest: 40 } }]);

    // empty filter → no rows → empty result (the engine substitutes reference zeros above this layer)
    const empty = await backend.aggregate(
      { model: "User", where: gt("age", 100).serialize(), groupBy: [], aggregates: [{ name: "n", op: "count" }] },
      ctx
    );
    expect(empty).toEqual([]);
  });

  it("groups + aggregates through the full Repository stack (push-down)", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const people = orm.define({ name: "Person", properties: { city: text(), age: integer() } });
    for (const [city, age] of [["Berlin", 30], ["Berlin", 40], ["Paris", 20]] as const) {
      people.save(people.createInstance({ city, age }));
    }
    await people.persist();

    const stats = await people.all().aggregate((a) => ({ total: a.count(), avgAge: a.avg("age") }));
    expect(stats).toEqual({ total: 3, avgAge: 30 });

    const byCity = await people.all().groupBy("city", (a) => ({ n: a.count(), oldest: a.max("age") }));
    expect(byCity.find((g) => g.key === "Berlin")).toEqual({ key: "Berlin", n: 2, oldest: 40 });
    expect(byCity.find((g) => g.key === "Paris")).toEqual({ key: "Paris", n: 1, oldest: 20 });
  });

  it("groups by a computed expression (year) via $group _id { $year: { $toDate } }", async () => {
    const orm = new RepositoryManager({ backend: new MongoBackend(new FakeDb()) });
    const events = orm.define({ name: "Event", properties: { ts: date(), amount: integer() } });
    for (const [y, amount] of [[2023, 10], [2024, 20], [2024, 5]] as const) {
      events.save(events.createInstance({ ts: new Date(Date.UTC(y, 0, 1)), amount }));
    }
    await events.persist();

    const byYear = await events.all().groupByExpr(year(field("ts")), (a) => ({ n: a.count(), total: a.sum("amount") }));
    expect(byYear.find((g) => g.key === 2023)).toEqual({ key: 2023, n: 1, total: 10 });
    expect(byYear.find((g) => g.key === 2024)).toEqual({ key: 2024, n: 2, total: 25 });
  });
});
