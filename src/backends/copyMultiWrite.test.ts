/**
 * Migration primitives: `copyBackend` (bulk backend-to-backend backfill) and `multiWriteBackend`
 * (fan-out / dual-write). Together they model a zero-downtime store cutover — backfill history into a
 * new store, dual-write live traffic to keep it in lock-step, then flip the primary. Exercised across
 * a real backend pair (in-memory ⇄ SQLite) so the "any pair" claim isn't just in-memory-to-in-memory.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { copyBackend } from "./util/copy.js";
import { multiWriteBackend } from "./decorators/MultiWriteBackend.js";
import { text, integer } from "../properties/factories.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { eq, gt } from "../expressions/index.js";
import { inc } from "../repository/patch.js";
import type { Backend, RawQueryable } from "../core/Backend.js";
import type { JsonObject } from "../core/types.js";

/** A backend that behaves normally but rejects on `persist` — a stand-in for a lagging/down secondary. */
const failingPersist = (message: string): Backend => {
  const inner = new InMemoryBackend();
  return {
    capabilities: inner.capabilities,
    query: (p, c) => inner.query(p, c),
    queryUuids: (p, c) => inner.queryUuids(p, c),
    save: (m, r, c) => inner.save(m, r, c),
    remove: (m, r, c) => inner.remove(m, r, c),
    persist: () => Promise.reject(new Error(message)),
    changes: (l, c) => inner.changes(l, c)
  };
};

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const sqlite = (): Backend => new SQLiteBackend(new DatabaseSync(":memory:"));

const PEOPLE = { name: "Person", properties: { name: text(), age: integer() } };
type Person = { name: string; age: number };

/** Define `Person` over `backend` and return its repo (provisions schema-aware stores). */
const people = (backend: Backend) => new RepositoryManager({ backend }).define(PEOPLE);

const seed = async (backend: Backend, rows: Person[]) => {
  const repo = people(backend);
  for (const r of rows) repo.save(repo.createInstance(r));
  await repo.persist();
  return repo;
};

const ROWS: Person[] = Array.from({ length: 25 }, (_, i) => ({ name: `p${i}`, age: 20 + (i % 10) }));

describe("copyBackend (bulk backfill)", () => {
  it("copies every row from an in-memory source into a SQLite target, in batches", async () => {
    const source = new InMemoryBackend();
    await seed(source, ROWS);
    const target = sqlite();
    const targetRepo = people(target); // provision the table before backfill

    const batches: number[] = [];
    const report = await copyBackend(source, target, { models: ["Person"], batchSize: 10, onBatch: (p) => batches.push(p.batch) });

    expect(report).toEqual({ perModel: { Person: 25 }, total: 25 });
    expect(batches).toEqual([10, 10, 5]); // paged 10/10/5
    expect(await targetRepo.all().count()).toBe(25);
    // content matches, not just the count
    const original = (await people(source).all().sort("name").list()).map((p) => p.name);
    const copied = (await targetRepo.all().sort("name").list()).map((p) => p.name);
    expect(copied).toEqual(original);
  });

  it("honours a per-model filter and a transform (skip via null)", async () => {
    const source = new InMemoryBackend();
    await seed(source, ROWS);
    const target = new InMemoryBackend();
    people(target);

    const report = await copyBackend(source, target, {
      models: ["Person"],
      batchSize: 100,
      where: () => gt("age", 25).serialize(), // only ages 26..29
      transform: (record) => ((record as unknown as Person).age === 27 ? null : record) // drop the 27s
    });

    const ages = (await people(target).all().list()).map((p) => (p as Person).age);
    expect(ages.length).toBe(report.perModel.Person);
    expect(ages.every((a) => a > 25 && a !== 27)).toBe(true);
    expect(ages.length).toBeGreaterThan(0);
  });

  it("copies nothing (and reports zero) for an empty source", async () => {
    const target = new InMemoryBackend();
    people(target);
    const report = await copyBackend(new InMemoryBackend(), target, { models: ["Person"], batchSize: 5 });
    expect(report).toEqual({ perModel: { Person: 0 }, total: 0 });
  });
});

describe("multiWriteBackend (dual-write)", () => {
  it("applies every write to primary and secondary; reads come from the primary", async () => {
    const primary = new InMemoryBackend();
    const secondary = sqlite();
    const repo = people(multiWriteBackend({ primary, secondaries: [secondary] }));

    const ada = repo.createInstance({ name: "Ada", age: 36 });
    repo.save(ada);
    await repo.persist();

    // both stores have it, keyed identically
    expect((await people(primary).get(ada.uuid))!.name).toBe("Ada");
    expect((await people(secondary).get(ada.uuid))!.name).toBe("Ada");

    // a remove fans out too
    repo.remove(ada);
    await repo.persist();
    expect(await people(primary).all().count()).toBe(0);
    expect(await people(secondary).all().count()).toBe(0);
  });

  it("assigns one uuid shared across all stores when the caller omits it", async () => {
    const primary = new InMemoryBackend();
    const secondary = new InMemoryBackend();
    const be = multiWriteBackend({ primary, secondaries: [secondary] });

    const record: JsonObject = { name: "NoId", age: 1 };
    be.save("Person", record, SYSTEM_CONTEXT);
    expect(typeof record.uuid).toBe("string");
    await be.persist(SYSTEM_CONTEXT);

    const uuid = String(record.uuid);
    const inPrimary = await primary.query({ model: "Person", where: eq("uuid", uuid).serialize(), order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
    const inSecondary = await secondary.query({ model: "Person", where: eq("uuid", uuid).serialize(), order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
    expect(inPrimary).toHaveLength(1);
    expect(inSecondary).toHaveLength(1); // same uuid landed in both
  });

  it("fans a server-side patch to every store when all support it", async () => {
    const primary = sqlite();
    const secondary = sqlite();
    const repo = people(multiWriteBackend({ primary, secondaries: [secondary] }));
    const p = repo.createInstance({ name: "Zoe", age: 40 });
    repo.save(p);
    await repo.persist();

    await repo.patch(p.uuid, { age: inc(1) }); // server-side increment, fanned to both
    expect((await people(primary).get(p.uuid))!.age).toBe(41);
    expect((await people(secondary).get(p.uuid))!.age).toBe(41);
  });

  it("mirrors the primary's capabilities but never advertises cross-store transactions", () => {
    const primary = sqlite(); // sqlite has transactions
    const be = multiWriteBackend({ primary, secondaries: [new InMemoryBackend()] });
    expect(be.capabilities.transactions).toBe(false);
    expect(be.capabilities.sortPushdown).toBe(primary.capabilities.sortPushdown);
    expect(typeof (be as { transaction?: unknown }).transaction).toBe("undefined"); // no 2PC method
  });

  it("strict (default): a failing secondary rejects the persist", async () => {
    const primary = new InMemoryBackend();
    const boom = failingPersist("secondary down");
    const repo = people(multiWriteBackend({ primary, secondaries: [boom] }));
    repo.save(repo.createInstance({ name: "X", age: 1 }));
    await expect(repo.persist()).rejects.toThrow("secondary down");
    // primary still committed (no cross-store 2PC) — the documented consistency model
    expect(await people(primary).all().count()).toBe(1);
  });

  it("custom onSecondaryError: tolerate a lagging secondary, keep serving from primary", async () => {
    const primary = new InMemoryBackend();
    const errors: string[] = [];
    const boom = failingPersist("lag");
    const repo = people(
      multiWriteBackend({ primary, secondaries: [boom], onSecondaryError: (e) => errors.push((e as Error).message) })
    );
    repo.save(repo.createInstance({ name: "Y", age: 2 }));
    await expect(repo.persist()).resolves.toBeDefined(); // does not reject
    expect(errors).toEqual(["lag"]);
    expect(await people(primary).all().count()).toBe(1);
  });
});

describe("multiWriteBackend capability delegation", () => {
  it("reads (count / aggregate) resolve on the primary", async () => {
    const primary = sqlite();
    const be = multiWriteBackend({ primary, secondaries: [sqlite()] });
    const repo = people(be);
    for (const r of [{ name: "a", age: 30 }, { name: "b", age: 30 }, { name: "c", age: 40 }]) repo.save(repo.createInstance(r));
    await repo.persist();

    expect(await repo.all().count()).toBe(3); // multiWrite.count → primary
    const byAge = await repo.all().groupBy("age", (a) => ({ n: a.count() })); // multiWrite.aggregate → primary
    expect(byAge.find((g) => g.key === 30)!.n).toBe(2);
  });

  it("exposes raw only when the primary supports it, and delegates to it", async () => {
    // in-memory/sqlite primaries aren't raw-queryable, so the other tests cover the "no raw" branch;
    // here a raw-capable primary is delegated to (and secondaries never see the opaque query).
    const inner = new InMemoryBackend();
    const rawPrimary: Backend & RawQueryable = {
      capabilities: inner.capabilities,
      query: (p, c) => inner.query(p, c),
      queryUuids: (p, c) => inner.queryUuids(p, c),
      save: (m, r, c) => inner.save(m, r, c),
      remove: (m, r, c) => inner.remove(m, r, c),
      persist: (c) => inner.persist(c),
      changes: (l, c) => inner.changes(l, c),
      raw: async (query) => [{ echoed: (query as { v: number }).v }]
    };
    const be = multiWriteBackend({ primary: rawPrimary, secondaries: [new InMemoryBackend()] });
    expect(typeof (be as Partial<RawQueryable>).raw).toBe("function");
    const rows = await (be as unknown as RawQueryable).raw({ v: 7 }, SYSTEM_CONTEXT);
    expect(rows[0]).toEqual({ echoed: 7 });
  });

  it("patchWhere fans the multi-patch to every store (queryUuids + patchMany)", async () => {
    const primary = sqlite();
    const secondary = sqlite();
    const repo = people(multiWriteBackend({ primary, secondaries: [secondary] }));
    for (const r of [{ name: "a", age: 30 }, { name: "b", age: 30 }, { name: "c", age: 40 }]) repo.save(repo.createInstance(r));
    await repo.persist();

    const matched = await repo.patchWhere(eq("age", 30), { age: inc(100) });
    expect(matched).toBe(2); // primary's matched count is authoritative
    expect((await people(primary).all().filter(gt("age", 100)).list()).length).toBe(2);
    expect((await people(secondary).all().filter(gt("age", 100)).list()).length).toBe(2); // fanned
  });

  it("upsert fans to every store", async () => {
    const primary = sqlite();
    const secondary = sqlite();
    const repo = people(multiWriteBackend({ primary, secondaries: [secondary] }));

    await repo.upsert(eq("name", "Ada"), { set: { age: 41 }, setOnInsert: { name: "Ada", age: 41 } }); // insert
    await repo.upsert(eq("name", "Ada"), { set: { age: 42 }, setOnInsert: { name: "Ada", age: 42 } }); // update
    expect((await people(primary).all().filter(eq("name", "Ada")).list())[0]!.age).toBe(42);
    expect((await people(secondary).all().filter(eq("name", "Ada")).list())[0]!.age).toBe(42); // fanned
  });

  it("queryUuids and discardPending fan/delegate correctly", async () => {
    const primary = new InMemoryBackend();
    const secondary = new InMemoryBackend();
    const be = multiWriteBackend({ primary, secondaries: [secondary] });

    be.save("Person", { name: "buffered", age: 1 }, SYSTEM_CONTEXT);
    be.discardPending!(); // drop the buffered unit of work in every store
    await be.persist(SYSTEM_CONTEXT);
    expect(await primary.query({ model: "Person", where: eq("name", "buffered").serialize(), order: [], paging: { start: 0 } }, SYSTEM_CONTEXT)).toHaveLength(0);
    expect(await secondary.query({ model: "Person", where: eq("name", "buffered").serialize(), order: [], paging: { start: 0 } }, SYSTEM_CONTEXT)).toHaveLength(0);

    be.save("Person", { uuid: "u1", name: "kept", age: 1 }, SYSTEM_CONTEXT);
    await be.persist(SYSTEM_CONTEXT);
    expect(await be.queryUuids({ model: "Person", where: eq("name", "kept").serialize(), order: [], paging: { start: 0 } }, SYSTEM_CONTEXT)).toEqual(["u1"]);
  });
});

describe("copy + dual-write together (a cutover rehearsal)", () => {
  it("backfills, then dual-writes so the new store ends fully consistent", async () => {
    const oldStore = new InMemoryBackend();
    await seed(oldStore, ROWS); // 25 rows of history

    const newStore = sqlite();
    people(newStore); // provision

    // 1. backfill history
    await copyBackend(oldStore, newStore, { models: ["Person"], batchSize: 8 });
    expect(await people(newStore).all().count()).toBe(25);

    // 2. dual-write live traffic (old still primary/serving)
    const live = people(multiWriteBackend({ primary: oldStore, secondaries: [newStore] }));
    live.save(live.createInstance({ name: "fresh", age: 99 }));
    await live.persist();

    // 3. the new store has history + the live write, ready to become primary
    expect(await people(oldStore).all().count()).toBe(26);
    expect(await people(newStore).all().count()).toBe(26);
    expect((await people(newStore).all().filter(eq("name", "fresh")).list())[0]!.age).toBe(99);
  });
});
