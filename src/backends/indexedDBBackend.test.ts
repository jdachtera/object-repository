import { describe, it, expect, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDBBackend } from "./indexeddb/IndexedDBBackend.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all, eq, gt, or, between } from "../expressions/index.js";
import type { QueryPlan, ExpressionNode } from "../core/QueryPlan.js";
import type { SortKey } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;
let dbCounter = 0;

function makeBackend(): IndexedDBBackend {
  // A unique db name per backend keeps tests isolated within the shared fake-indexeddb factory.
  return new IndexedDBBackend({ name: `test-db-${dbCounter++}`, factory: new IDBFactory(), keyRange: IDBKeyRange });
}

function plan(
  model: string,
  where: ExpressionNode = all().serialize(),
  order: SortKey[] = [],
  paging: { start: number; end?: number } = { start: 0 }
): QueryPlan {
  return { model, where, order, paging };
}

async function seed(backend: IndexedDBBackend) {
  backend.registerModel("User", [{ name: "age", fields: [{ path: "age" }], unique: false }]);
  backend.save("User", { uuid: "u1", name: "Peter", age: 35 }, ctx);
  backend.save("User", { uuid: "u2", name: "John", age: 40 }, ctx);
  backend.save("User", { uuid: "u3", name: "Jane", age: 25 }, ctx);
  await backend.persist(ctx);
}

describe("IndexedDBBackend", () => {
  it("persists and reads back all records", async () => {
    const backend = makeBackend();
    await seed(backend);
    expect(await backend.query(plan("User"), ctx)).toHaveLength(3);
  });

  it("pushes a range filter down to an index", async () => {
    const backend = makeBackend();
    await seed(backend);
    const over30 = await backend.query(plan("User", gt("age", 30).serialize()), ctx);
    expect(over30.map((u) => u.uuid).sort()).toEqual(["u1", "u2"]);

    const inRange = await backend.query(plan("User", between("age", 30, 38).serialize()), ctx);
    expect(inRange.map((u) => u.uuid)).toEqual(["u1"]);
  });

  it("ranges over the primary key (uuid)", async () => {
    const backend = makeBackend();
    await seed(backend);
    const byUuid = await backend.query(plan("User", eq("uuid", "u2").serialize()), ctx);
    expect(byUuid.map((u) => u.name)).toEqual(["John"]);
  });

  it("falls back to a full scan for non-indexed and non-rangeable filters", async () => {
    const backend = makeBackend();
    await seed(backend);
    const byName = await backend.query(plan("User", eq("name", "Jane").serialize()), ctx);
    expect(byName.map((u) => u.uuid)).toEqual(["u3"]);

    const either = await backend.query(
      plan("User", or(eq("name", "John"), eq("name", "Peter")).serialize()),
      ctx
    );
    expect(either).toHaveLength(2);
  });

  it("orders and pages in memory after fetch", async () => {
    const backend = makeBackend();
    await seed(backend);
    const desc = await backend.query(plan("User", all().serialize(), [{ property: "age", descending: true }]), ctx);
    expect(desc.map((u) => u.name)).toEqual(["John", "Peter", "Jane"]);

    const youngest = await backend.query(
      plan("User", all().serialize(), [{ property: "age", descending: false }], { start: 0, end: 1 }),
      ctx
    );
    expect(youngest.map((u) => u.name)).toEqual(["Jane"]);
  });

  it("returns matching uuids and removes records", async () => {
    const backend = makeBackend();
    await seed(backend);
    expect((await backend.queryUuids(plan("User", gt("age", 30).serialize()), ctx)).sort()).toEqual(["u1", "u2"]);

    backend.remove("User", { uuid: "u2" }, ctx);
    await backend.persist(ctx);
    expect((await backend.query(plan("User"), ctx)).map((u) => u.uuid).sort()).toEqual(["u1", "u3"]);
  });

  it("auto-assigns a uuid and emits change events", async () => {
    const backend = makeBackend();
    const listener = vi.fn();
    backend.changes(listener, ctx);

    const record: { uuid?: string; name: string } = { name: "Nameless" };
    backend.save("User", record as never, ctx);
    await backend.persist(ctx);

    expect(record.uuid).toHaveLength(32);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ model: "User", kind: "saved" }));
  });

  it("counts natively — whole store, index range, and a precise fallback", async () => {
    const backend = makeBackend();
    await seed(backend);
    expect(await backend.count(plan("User"), ctx)).toBe(3); // store.count()
    expect(await backend.count(plan("User", gt("age", 30).serialize()), ctx)).toBe(2); // index range
    expect(await backend.count(plan("User", between("age", 24, 36).serialize()), ctx)).toBe(2);
    expect(await backend.count(plan("User", eq("name", "Jane").serialize()), ctx)).toBe(1); // fallback
  });

  it("reports compiling-backend capabilities", () => {
    const backend = makeBackend();
    expect(backend.capabilities.indexes).toBe(true);
    expect(backend.capabilities.ranges).toBe(true);
  });
});
