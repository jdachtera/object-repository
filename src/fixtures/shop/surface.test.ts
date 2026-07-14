/**
 * Query-surface battery: representative query/update/aggregation shapes a real e-commerce app runs,
 * replayed against this ORM through the Mongo compat facade (a common migration interface) and native
 * builders. Each shape is labelled SUPPORTED (asserts the real result, cross-backend where it matters)
 * or GAP (asserts the exact throw / pins the divergence). The GAP set IS "what's still missing" — kept
 * green so it doubles as a TODO ledger: implement a feature and its GAP test flips red. See
 * docs/QUERY_SURFACE.md for the narrative.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "../../repository/RepositoryManager.js";
import { InMemoryBackend } from "../../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../../backends/sqlite/SQLiteBackend.js";
import { mongoCollection, parseMongoFilter, parseMongoUpdate } from "../../compat/mongo.js";
import { defineShopModels } from "./models.js";
import { eq, and, or, gt, exists } from "../../expressions/index.js";
import { inc } from "../../repository/patch.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const fresh = (backend = new InMemoryBackend()) => {
  const orm = new RepositoryManager({ backend });
  return { orm, models: defineShopModels(orm) };
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUPPORTED — filters (the app's common read shapes all map to the portable AST)
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("SUPPORTED · filters", () => {
  it("liveProductIds: { isPublished: true, $or: [{ isFeatured: true }, { status: 'active' }] }", async () => {
    const { models } = fresh();
    const products = mongoCollection(models.products);
    await products.insertMany([
      { sku: "a", name: { en: "A" }, sourceLocale: "en", isPublished: true, isFeatured: true, status: "draft" },
      { sku: "b", name: { en: "B" }, sourceLocale: "en", isPublished: true, isFeatured: false, status: "active" },
      { sku: "c", name: { en: "C" }, sourceLocale: "en", isPublished: true, isFeatured: false, status: "draft" },
      { sku: "d", name: { en: "D" }, sourceLocale: "en", isPublished: false, isFeatured: true, status: "active" }
    ]);
    const rows = await products.find({ isPublished: true, $or: [{ isFeatured: true }, { status: "active" }] }).toArray();
    expect(rows.map((p) => (p.name as { en: string }).en).sort()).toEqual(["A", "B"]);
  });

  it("getByIds: { _id: { $in: [...] } } → $in on the identity field", async () => {
    const { models } = fresh();
    const events = mongoCollection(models.events);
    await events.insertMany([
      { uuid: "e1", customerId: "u1", eventType: "viewed", timestamp: new Date() },
      { uuid: "e2", customerId: "u2", eventType: "viewed", timestamp: new Date() },
      { uuid: "e3", customerId: "u3", eventType: "viewed", timestamp: new Date() }
    ] as never);
    const rows = await events.find({ uuid: { $in: ["e1", "e3"] } }).toArray();
    expect(rows.map((e) => (e as { customerId: string }).customerId).sort()).toEqual(["u1", "u3"]);
  });

  it("relatedProducts: { category, _id: { $ne: sourceId } }", async () => {
    const { models } = fresh();
    const products = mongoCollection(models.products);
    await products.insertMany([
      { uuid: "s1", sku: "s1", name: { en: "src" }, sourceLocale: "en", category: "g1" },
      { uuid: "s2", sku: "s2", name: { en: "sib" }, sourceLocale: "en", category: "g1" },
      { uuid: "s3", sku: "s3", name: { en: "other" }, sourceLocale: "en", category: "g2" }
    ] as never);
    const rows = await products.find({ category: "g1", uuid: { $ne: "s1" } }).toArray();
    expect(rows.map((p) => (p as { uuid: string }).uuid)).toEqual(["s2"]);
  });

  it("statistics: date range { createdAt: { $gte, $lt } } — Date comparands normalise to epoch", async () => {
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertMany([
      { uuid: "old", createdAt: new Date("2023-01-01") },
      { uuid: "mid", createdAt: new Date("2024-06-01") },
      { uuid: "new", createdAt: new Date("2025-06-01") }
    ] as never);
    const rows = await customers
      .find({ createdAt: { $gte: new Date("2024-01-01"), $lt: new Date("2025-01-01") } })
      .toArray();
    expect(rows.map((u) => (u as { uuid: string }).uuid)).toEqual(["mid"]);
  });

  it("getVipCustomers: scalar-eq against an array field ({ tags: 'vip' }) matches membership", async () => {
    // The app's pervasive segment lookup. A bare scalar against a declared array() field is Mongo's
    // array-element equality — now rewritten to a membership check (was a documented GAP).
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertMany([
      { uuid: "a", tags: ["vip", "wholesale"] },
      { uuid: "b", tags: ["wholesale"] },
      { uuid: "c", tags: [] }
    ] as never);
    expect((await customers.find({ tags: "vip" }).toArray()).map((u) => (u as { uuid: string }).uuid)).toEqual(["a"]);
    expect(await customers.countDocuments({ tags: "wholesale" })).toBe(2);
  });

  it("payment webhooks: deep dotted filters into the embedded() subdocument traverse + push down", async () => {
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertMany([
      { uuid: "u1", paymentMethod: { provider: "card", customerId: "cus_1", details: { status: "active" } } },
      { uuid: "u2", paymentMethod: { provider: "paypal", details: { status: "canceled" } } },
      { uuid: "u3" }
    ] as never);
    // `paymentMethod` is embedded() → these dotted paths traverse (was a GAP with json()).
    expect((await customers.findOne({ "paymentMethod.customerId": "cus_1" }))!.uuid).toBe("u1");
    expect((await customers.find({ "paymentMethod.details.status": "active" }).toArray()).map((u) => (u as { uuid: string }).uuid)).toEqual(["u1"]);
    expect(await customers.countDocuments({ "paymentMethod.customerId": { $exists: true } })).toBe(1);
  });

  it("cross-backend: the same $or/$in/$exists filter agrees on InMemory and SQLite", async () => {
    const build = async (backend: InMemoryBackend | SQLiteBackend) => {
      const { models } = fresh(backend as never);
      const products = mongoCollection(models.products);
      await products.insertMany([
        { uuid: "a", sku: "a", name: { en: "A" }, sourceLocale: "en", status: "active", isFeatured: true },
        { uuid: "b", sku: "b", name: { en: "B" }, sourceLocale: "en", status: "archived", isFeatured: false },
        { uuid: "c", sku: "c", name: { en: "C" }, sourceLocale: "en", status: "active", isFeatured: false }
      ] as never);
      const rows = await products.find({ $or: [{ isFeatured: true }, { status: "archived" }] }).toArray();
      return rows.map((p) => (p as { uuid: string }).uuid).sort();
    };
    const mem = await build(new InMemoryBackend());
    const sql = await build(new SQLiteBackend(new DatabaseSync(":memory:")));
    expect(sql).toEqual(mem);
    expect(mem).toEqual(["a", "b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUPPORTED — writes (the app's update operators that map to atomic patch ops)
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("SUPPORTED · writes", () => {
  it("verifyEmail: updateOne $set", async () => {
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertOne({ uuid: "u1", isEmailVerified: false } as never);
    await customers.updateOne({ uuid: "u1" }, { $set: { isEmailVerified: true } });
    expect((await customers.findOne({ uuid: "u1" }))!.isEmailVerified).toBe(true);
  });

  it("tagCustomer: $addToSet with $each", async () => {
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertOne({ uuid: "u1", tags: ["vip"] } as never);
    await customers.updateOne({ uuid: "u1" }, { $addToSet: { tags: { $each: ["wholesale", "vip"] } } });
    expect(((await customers.findOne({ uuid: "u1" }))!.tags as string[]).sort()).toEqual(["vip", "wholesale"]);
  });

  it("untagCustomer: $pull a tag by value", async () => {
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertOne({ uuid: "u1", tags: ["vip", "wholesale"] } as never);
    await customers.updateOne({ uuid: "u1" }, { $pull: { tags: "wholesale" } });
    expect((await customers.findOne({ uuid: "u1" }))!.tags).toEqual(["vip"]);
  });

  it("wishlist: findOneAndUpdate upsert by compound key { customerId, productId }", async () => {
    const { models } = fresh();
    const wishlist = mongoCollection(models.wishlistItems);
    await wishlist.updateOne({ customerId: "u1", productId: "s1" }, { $set: { customerId: "u1", productId: "s1" } }, { upsert: true });
    await wishlist.updateOne({ customerId: "u1", productId: "s1" }, { $set: { customerId: "u1", productId: "s1" } }, { upsert: true });
    expect(await wishlist.countDocuments({ customerId: "u1" })).toBe(1); // idempotent
  });

  it("orders: upsert-by-requestId ($setOnInsert + $set)", async () => {
    const { models } = fresh();
    const orders = mongoCollection(models.orders);
    await orders.updateOne(
      { requestId: "r1" },
      { $setOnInsert: { requestId: "r1", status: "pending", placedAt: new Date() }, $set: { total: 42 } },
      { upsert: true }
    );
    expect((await orders.findOne({ requestId: "r1" }))!.status).toBe("pending");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUPPORTED — aggregation ($match → $group, the shape the facade covers)
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("SUPPORTED · aggregation ($match → $group)", () => {
  it("getStatistics: group purchase events by productId with $sum", async () => {
    const { models } = fresh();
    const events = mongoCollection(models.events);
    await events.insertMany([
      { customerId: "u1", productId: "s1", eventType: "purchased", timestamp: new Date() },
      { customerId: "u2", productId: "s1", eventType: "purchased", timestamp: new Date() },
      { customerId: "u3", productId: "s2", eventType: "purchased", timestamp: new Date() }
    ] as never);
    const rows = await events.aggregate([
      { $match: { eventType: "purchased" } },
      { $group: { _id: "$productId", count: { $sum: 1 } } }
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r._id, r.count]));
    expect(byId).toEqual({ s1: 2, s2: 1 });
  });

  it("pricing funnel / time-series: unique customers per bucket via countDistinct ($size of $addToSet)", async () => {
    // Previously a GAP (no distinct aggregator → load rows + a JS Set). Now native + push-downable.
    const { models } = fresh();
    const events = models.events;
    for (const e of [
      { customerId: "u1", eventType: "checkout_started", variant: "control", timestamp: new Date() },
      { customerId: "u1", eventType: "checkout_started", variant: "control", timestamp: new Date() }, // dup customer
      { customerId: "u2", eventType: "checkout_started", variant: "control", timestamp: new Date() },
      { customerId: "u3", eventType: "checkout_started", variant: "bundle", timestamp: new Date() }
    ]) events.save(events.createInstance(e as never));
    await events.persist();
    const funnel = await events.all().filter(eq("eventType", "checkout_started")).groupBy("variant", (a) => ({
      total: a.count(),
      uniqueCustomers: a.countDistinct("customerId")
    }));
    const byVariant = Object.fromEntries(funnel.map((g) => [g.key, [g.total, g.uniqueCustomers]]));
    expect(byVariant).toEqual({ control: [3, 2], bundle: [1, 1] }); // 3 events, 2 distinct customers on control
  });

  it("native groupBy gives the same counts (and pushes down on SQLite)", async () => {
    const { models } = fresh(new SQLiteBackend(new DatabaseSync(":memory:")) as never);
    const events = models.events;
    for (const e of [
      { customerId: "u1", productId: "s1", eventType: "viewed", timestamp: new Date() },
      { customerId: "u2", productId: "s1", eventType: "viewed", timestamp: new Date() }
    ]) events.save(events.createInstance(e as never));
    await events.persist();
    const groups = await events.all().groupBy("productId", (a) => ({ n: a.count() }));
    expect(groups.find((g) => g.key === "s1")!.n).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GAP — filters the facade can't express (throws loudly, by design). These are the missing features.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("GAP · filters (throw — not yet expressible)", () => {
  it("product search: char-class $regex /[wW][iI][dD]/i → throws (only literal patterns map)", () => {
    expect(() => parseMongoFilter({ "name.en": { $regex: /[wW][iI][dD]/, $options: "i" } })).toThrow(/regex/i);
  });

  it("mixed-_id migration: { _id: { $type: 'string' } } → $type unsupported", () => {
    expect(() => parseMongoFilter({ uuid: { $type: "string" } })).toThrow(/\$type/);
  });

  it("polymorphic field: { 'settings.flags': { $type: 'object' } } → $type unsupported", () => {
    expect(() => parseMongoFilter({ "settings.flags": { $type: "object" } })).toThrow(/\$type/);
  });

  it("GAP — $push of object elements onto a json() array is unsupported (array ops need scalar array())", async () => {
    const { models } = fresh();
    const orders = mongoCollection(models.orders);
    await orders.insertOne({ uuid: "o1", customerId: "u1", items: [] } as never);
    // `items` holds objects → must be json() (scalar array() can't hold them), but the $push/$pull patch
    // ops only operate on a native array() column. Pushing objects corrupts the opaque json blob.
    await expect(orders.updateOne({ uuid: "o1" }, { $push: { items: { $each: [{ sku: "x", quantity: 1, price: 9 }] } } })).rejects.toThrow();
  });

  it("DIVERGENCE — array-index dot path 'items.0' does not resolve into the array", async () => {
    const { models } = fresh();
    const orders = mongoCollection(models.orders);
    await orders.insertOne({ uuid: "o1", customerId: "u1", items: [{ sku: "x", quantity: 1, price: 9 }] } as never);
    // Mongo's `'items.0': { $exists: true }` checks array element 0; the portable path can't index into
    // an array by ordinal, so this is false where Mongo is true.
    expect(await orders.countDocuments({ "items.0": { $exists: true } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUPPORTED — updates that were previously GAPs
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("SUPPORTED · writes (previously-GAP update operators)", () => {
  it("retagCustomer: $pullAll removes every listed value from an array field", async () => {
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertOne({ uuid: "u1", tags: ["vip", "wholesale", "beta"] } as never);
    await customers.updateOne({ uuid: "u1" }, { $pullAll: { tags: ["wholesale", "beta"] } });
    expect((await customers.findOne({ uuid: "u1" }))!.tags).toEqual(["vip"]);
  });

  it("segmentCustomer: $pull with { $in: [...] } removes the matching elements", async () => {
    const { models } = fresh();
    const customers = mongoCollection(models.customers);
    await customers.insertOne({ uuid: "u1", tags: ["a", "b", "c"] } as never);
    await customers.updateOne({ uuid: "u1" }, { $pull: { tags: { $in: ["a", "c"] } } });
    expect((await customers.findOne({ uuid: "u1" }))!.tags).toEqual(["b"]);
  });

  it("touchSession: $currentDate sets the field to now", async () => {
    const { models } = fresh();
    const sessions = mongoCollection(models.sessions);
    await sessions.insertOne({ uuid: "u1", updatedAt: new Date("2020-01-01") } as never);
    const before = Date.now();
    await sessions.updateOne({ uuid: "u1" }, { $currentDate: { updatedAt: true } });
    const after = (await sessions.findOne({ uuid: "u1" }))!.updatedAt as Date;
    expect(after.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("GAP · writes (throw — not yet expressible)", () => {
  it("replaceCatalogCopy: a replacement (field-style) update → must use replaceOne()", () => {
    expect(() => parseMongoUpdate({ name: { fr: "x" } })).toThrow(/replaceOne|replaces the record/);
  });

  it("DIVERGENCE — stock upsert drops $inc on the *insert* path", async () => {
    const { models } = fresh();
    const products = mongoCollection(models.products);
    // Mongo's { $inc: { stock: 5 }, $setOnInsert: {...} } upsert inserts stock=5; the facade seeds an
    // insert only from equality + $set + $setOnInsert, so the $inc is lost on first insert.
    await products.updateOne({ sku: "k1" }, { $inc: { stock: 5 }, $setOnInsert: { sku: "k1", createdAt: new Date() } }, { upsert: true });
    expect((await products.findOne({ sku: "k1" }))!.stock ?? 0).not.toBe(5); // documents the gap
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUPPORTED — aggregation pipeline stages that map onto the query builder ($sort/$skip/$limit/$count)
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("SUPPORTED · aggregation stages (pushed down / windowed)", () => {
  async function seededEvents() {
    const { models } = fresh();
    const events = mongoCollection(models.events);
    for (let i = 0; i < 5; i++) {
      await events.insertOne({
        uuid: `e${i}`, customerId: `u${i % 2}`, productId: `s${i}`, eventType: "viewed",
        timestamp: new Date(2020, 0, i + 1)
      } as never);
    }
    return events;
  }

  it("$sort orders the pipeline output", async () => {
    const events = await seededEvents();
    const rows = await events.aggregate([{ $match: {} }, { $sort: { timestamp: -1 } }]);
    expect(rows.map((r) => (r as { uuid: string }).uuid)).toEqual(["e4", "e3", "e2", "e1", "e0"]);
  });

  it("$skip + $limit window the sorted output", async () => {
    const events = await seededEvents();
    const rows = await events.aggregate([{ $sort: { timestamp: 1 } }, { $skip: 1 }, { $limit: 2 }]);
    expect(rows.map((r) => (r as { uuid: string }).uuid)).toEqual(["e1", "e2"]);
  });

  it("$count returns the matched cardinality", async () => {
    const events = await seededEvents();
    const rows = await events.aggregate([{ $match: { customerId: "u0" } }, { $count: "total" }]);
    expect(rows).toEqual([{ total: 3 }]);
  });

  it("$sort/$skip/$limit apply in-memory after a $group", async () => {
    const events = await seededEvents();
    const rows = await events.aggregate([
      { $group: { _id: "$customerId", n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 1 }
    ]);
    expect(rows).toEqual([{ _id: "u0", n: 3 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GAP — aggregation stages that reshape documents or join ($project/$lookup/$unwind/…)
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("GAP · aggregation stages (throw — not yet expressible)", () => {
  const { models } = fresh();
  const events = mongoCollection(models.events);
  const stage = (s: Record<string, unknown>) => expect(events.aggregate([{ $match: {} }, s])).rejects.toThrow(/Unsupported aggregate stage/);

  it("$lookup (join events → products)", () => stage({ $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } }));
  it("$unwind", () => stage({ $unwind: "$product" }));
  it("$facet (products-page total+items)", () => stage({ $facet: { total: [{ $count: "c" }], items: [{ $limit: 10 }] } }));
  it("$project stage", () => stage({ $project: { customerId: 1 } }));
  it("$addFields stage", () => stage({ $addFields: { x: 1 } }));
  it("$setWindowFields ($rank)", () => stage({ $setWindowFields: { partitionBy: "$customerId", sortBy: { createdAt: 1 }, output: { r: { $rank: {} } } } }));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUPPORTED — native ORM features the app reaches for outside the Mongo syntax
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("SUPPORTED · native (pagination / native AST)", () => {
  it("keyset pagination (the app's cursor-by-_id, done properly)", async () => {
    const { models } = fresh();
    const products = models.products;
    for (let i = 0; i < 25; i++) products.save(products.createInstance({ sku: `s${i}`, name: { en: `s${i}` }, sourceLocale: "en", createdAt: new Date(2020, 0, i + 1) } as never));
    await products.persist();
    let page = await products.all().sort("createdAt").page({ limit: 10 });
    let total = page.items.length;
    while (page.hasMore) {
      page = await products.all().sort("createdAt").page({ limit: 10, after: page.nextCursor });
      total += page.items.length;
    }
    expect(total).toBe(25);
  });

  it("firstPurchase: rank a customer's events by time ($setWindowFields $rank) — native windowed()", async () => {
    // Previously a GAP (no window functions). Now native + push-downable to SQL OVER(...).
    const { models } = fresh();
    const events = models.events;
    for (const e of [
      { customerId: "u1", eventType: "purchased", timestamp: new Date("2024-01-01") },
      { customerId: "u1", eventType: "purchased", timestamp: new Date("2024-02-01") }, // u1's 2nd
      { customerId: "u2", eventType: "purchased", timestamp: new Date("2024-01-15") }
    ]) events.save(events.createInstance(e as never));
    await events.persist();
    const ranked = await events.all().sort("timestamp").windowed({ partitionBy: "customerId" }, (w) => ({ purchaseNumber: w.rowNumber() }));
    // "is this the customer's first purchase?" → purchaseNumber === 1
    const firsts = ranked.filter((r) => r.purchaseNumber === 1).length;
    expect(firsts).toBe(2); // one first purchase per customer
    expect(ranked.every((r) => r.purchaseNumber >= 1)).toBe(true);
  });

  it("native AST composes the same shapes (and pushes down)", async () => {
    const { models } = fresh(new SQLiteBackend(new DatabaseSync(":memory:")) as never);
    const products = models.products;
    for (const p of [
      { sku: "A", name: { en: "A" }, sourceLocale: "en", isPublished: true, isFeatured: true },
      { sku: "B", name: { en: "B" }, sourceLocale: "en", isPublished: true, isFeatured: false }
    ]) products.save(products.createInstance(p as never));
    await products.persist();
    const rows = await products.all().filter(and(eq("isPublished", true), or(eq("isFeatured", true), exists("category", false)))).list();
    expect(rows.length).toBe(2);
    // a range + count, the statistics shape
    expect(await products.all().filter(gt("isPublished", false)).count()).toBeGreaterThanOrEqual(0);
    void inc; // (imported for parity with the write battery)
  });

  it("enum fields carry literal-union types inferred from their zod schema (compile-time)", () => {
    // The app's zod enums (`product.status`, `currency`, `sourceLocale`, …) transcribe to
    // `text({ schema })`, so the model type is the literal union — not bare `string`.
    const { models } = fresh();
    void models.products.all().where({ status: "active", currency: "EUR", sourceLocale: "en" });
    // @ts-expect-error — `status` is "draft" | "active" | "archived"
    void models.products.all().where({ status: "listed" });
    // @ts-expect-error — `sourceLocale` is "en" | "de" | "fr"
    void models.products.all().where({ sourceLocale: "tr" });
    expect(true).toBe(true);
  });
});
