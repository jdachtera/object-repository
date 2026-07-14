/**
 * The typed filter surface (`where`) — the type-safe alternative to `filter(eq(...))`. Runtime tests
 * confirm it produces the same results; the `@ts-expect-error` assertions are compile-time tests that
 * `tsc` enforces — a wrong field name or value type is a build error, matching a zod-typed Mongo app.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { text, integer, boolean, embedded } from "../properties/factories.js";
import { inc } from "./patch.js";

const orm = () => {
  const m = new RepositoryManager({ backend: new InMemoryBackend() });
  return m.define({
    name: "user",
    properties: {
      name: text(),
      age: integer(),
      active: boolean(),
      sub: embedded<{ tier: string; details: { seats: number } }>()
    }
  });
};

describe("where() — typed filters", () => {
  it("filters by field, operator object, dotted path, and logical ops (runtime)", async () => {
    const users = orm();
    users.save(users.createInstance({ name: "ann", age: 30, active: true, sub: { tier: "gold", details: { seats: 5 } } }));
    users.save(users.createInstance({ name: "bo", age: 20, active: false, sub: { tier: "free", details: { seats: 1 } } }));
    users.save(users.createInstance({ name: "cy", age: 40, active: true, sub: { tier: "gold", details: { seats: 2 } } }));
    await users.persist();

    expect((await users.all().where({ active: true }).list()).map((u) => u.name).sort()).toEqual(["ann", "cy"]);
    expect((await users.all().where({ age: { $gte: 30 } }).list()).map((u) => u.name).sort()).toEqual(["ann", "cy"]);
    expect((await users.all().where({ "sub.tier": "gold" }).list()).map((u) => u.name).sort()).toEqual(["ann", "cy"]);
    expect((await users.all().where({ "sub.details.seats": { $gt: 3 } }).list()).map((u) => u.name)).toEqual(["ann"]);
    expect(
      (await users.all().where({ $or: [{ name: "bo" }, { age: { $gt: 35 } }] }).list()).map((u) => u.name).sort()
    ).toEqual(["bo", "cy"]);
  });

  it("type-checks field names and value types (compile-time)", () => {
    const users = orm();
    // valid — no error
    void users.all().where({ name: "x", age: { $lt: 18 }, "sub.tier": "gold", "sub.details.seats": 3 });

    // @ts-expect-error — unknown field name
    void users.all().where({ naem: "x" });
    // @ts-expect-error — wrong value type (age is a number)
    void users.all().where({ age: "old" });
    // @ts-expect-error — wrong operator value type
    void users.all().where({ age: { $gt: "old" } });
    // @ts-expect-error — wrong type at a dotted path (seats is a number)
    void users.all().where({ "sub.details.seats": "many" });
    // @ts-expect-error — unknown dotted path
    void users.all().where({ "sub.nope": "x" });
    // @ts-expect-error — sort key must be a real field
    void users.all().sort("naem");
    expect(true).toBe(true);
  });

  it("type-checks patch specs (compile-time)", () => {
    const users = orm();
    const id = "00000000-0000-0000-0000-000000000000" as const;
    // valid — a raw value, and a PatchOp
    void users.patch(id, { name: "x", age: inc(1) });

    // @ts-expect-error — unknown field name
    void users.patch(id, { naem: "x" });
    // @ts-expect-error — wrong value type (age is a number)
    void users.patch(id, { age: "old" });
    expect(true).toBe(true);
  });
});
