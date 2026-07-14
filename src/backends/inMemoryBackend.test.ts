import { describe, it, expect, vi } from "vitest";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all, eq, or, gt } from "../expressions/index.js";
import type { QueryPlan } from "../core/QueryPlan.js";
import type { ExpressionNode } from "../core/QueryPlan.js";
import type { SortKey } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;

function plan(
  model: string,
  where: ExpressionNode = all().serialize(),
  order: SortKey[] = [],
  paging: { start: number; end?: number } = { start: 0 }
): QueryPlan {
  return { model, where, order, paging };
}

async function seedUsers(backend: InMemoryBackend) {
  backend.save("User", { uuid: "u1", name: "Peter", age: 35 }, ctx);
  backend.save("User", { uuid: "u2", name: "John", age: 40 }, ctx);
  backend.save("User", { uuid: "u3", name: "Jane", age: 25 }, ctx);
  await backend.persist(ctx);
}

describe("InMemoryBackend", () => {
  it("saves and queries all records of a model", async () => {
    const backend = new InMemoryBackend();
    await seedUsers(backend);
    const results = await backend.query(plan("User"), ctx);
    expect(results).toHaveLength(3);
  });

  it("isolates records by model", async () => {
    const backend = new InMemoryBackend();
    await seedUsers(backend);
    backend.save("Event", { uuid: "e1", title: "Launch" }, ctx);
    await backend.persist(ctx);
    expect(await backend.query(plan("User"), ctx)).toHaveLength(3);
    expect(await backend.query(plan("Event"), ctx)).toHaveLength(1);
  });

  it("filters with a serialized expression", async () => {
    const backend = new InMemoryBackend();
    await seedUsers(backend);
    const peter = await backend.query(plan("User", eq("name", "Peter").serialize()), ctx);
    expect(peter.map((u) => u.uuid)).toEqual(["u1"]);

    const young = await backend.query(plan("User", or(eq("name", "Jane"), eq("name", "Peter")).serialize()), ctx);
    expect(young).toHaveLength(2);
  });

  it("orders and pages results", async () => {
    const backend = new InMemoryBackend();
    await seedUsers(backend);
    const byAgeDesc = await backend.query(
      plan("User", all().serialize(), [{ property: "age", descending: true }]),
      ctx
    );
    expect(byAgeDesc.map((u) => u.name)).toEqual(["John", "Peter", "Jane"]);

    const firstTwo = await backend.query(
      plan("User", all().serialize(), [{ property: "age", descending: false }], { start: 0, end: 2 }),
      ctx
    );
    expect(firstTwo.map((u) => u.name)).toEqual(["Jane", "Peter"]);
  });

  it("returns matching uuids via queryUuids", async () => {
    const backend = new InMemoryBackend();
    await seedUsers(backend);
    const uuids = await backend.queryUuids(plan("User", gt("age", 30).serialize()), ctx);
    expect(uuids.sort()).toEqual(["u1", "u2"]);
  });

  it("removes records", async () => {
    const backend = new InMemoryBackend();
    await seedUsers(backend);
    backend.remove("User", { uuid: "u2", name: "John", age: 40 }, ctx);
    await backend.persist(ctx);
    const remaining = await backend.query(plan("User"), ctx);
    expect(remaining.map((u) => u.uuid).sort()).toEqual(["u1", "u3"]);
  });

  it("auto-assigns a 32-char uuid when missing", async () => {
    const backend = new InMemoryBackend();
    const record: { uuid?: string; name: string } = { name: "Nameless" };
    backend.save("User", record as never, ctx);
    await backend.persist(ctx);
    expect(typeof record.uuid).toBe("string");
    expect(record.uuid).toHaveLength(32);
  });

  it("emits change events on persist", async () => {
    const backend = new InMemoryBackend();
    const listener = vi.fn();
    backend.changes(listener, ctx);

    backend.save("User", { uuid: "u1", name: "Peter" }, ctx);
    await backend.persist(ctx);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ model: "User", uuid: "u1", kind: "saved" })
    );

    listener.mockClear();
    backend.remove("User", { uuid: "u1", name: "Peter" }, ctx);
    await backend.persist(ctx);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ model: "User", uuid: "u1", kind: "removed" })
    );
  });

  it("does not let queried records mutate the store", async () => {
    const backend = new InMemoryBackend();
    await seedUsers(backend);
    const [first] = await backend.query(plan("User", eq("uuid", "u1").serialize()), ctx);
    first!.name = "MUTATED";
    const [again] = await backend.query(plan("User", eq("uuid", "u1").serialize()), ctx);
    expect(again!.name).toBe("Peter");
  });

  it("reports scan-only capabilities", () => {
    const backend = new InMemoryBackend();
    expect(backend.capabilities.indexes).toBe(false);
    expect(backend.capabilities.changeFeed).toBe(true);
  });
});
