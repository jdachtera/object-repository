/**
 * `embedded()` — a nested subdocument stored natively (not stringified like `json()`), so its fields
 * are queryable by a dotted path (`eq("subscription.customerId", id)`). The app's pervasive
 * subscription/notification pattern. Verified across InMemory (reference), SQLite (json_extract into
 * the blob), and — vs `json()` — that a declared json() column stays opaque.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { text, embedded, json } from "../properties/factories.js";
import { eq, exists, inList } from "../expressions/index.js";
import { ValidationError } from "../properties/schema.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// A real *discriminated union* — `embedded<T>` is unconstrained on `T` (only its stored form must be
// JSON), so the per-`provider` detail shapes survive, exactly like a zod-typed collection.
type Sub =
  | { provider: "stripe"; customerId?: string; details?: { status: string; price: number } }
  | { provider: "apple"; customerId?: string; details?: { status: string; price: number } };

const seed = (backend: Backend) => {
  const orm = new RepositoryManager({ backend });
  return orm.define({
    name: "u",
    properties: { name: text(), subscription: embedded<Sub>() }
  });
};

describe("embedded() — queryable nested subdocuments", () => {
  it("filters and sorts by a dotted path, identical on InMemory and SQLite", async () => {
    const run = async (backend: Backend) => {
      const users = seed(backend);
      users.save(users.createInstance({ name: "a", subscription: { provider: "stripe", customerId: "cus_1", details: { status: "active", price: 10 } } }));
      users.save(users.createInstance({ name: "b", subscription: { provider: "apple", details: { status: "canceled", price: 5 } } }));
      users.save(users.createInstance({ name: "c" })); // no subscription
      await users.persist();
      return {
        byCustomer: (await users.all().filter(eq("subscription.customerId", "cus_1")).list()).map((u) => u.name),
        active: (await users.all().filter(eq("subscription.details.status", "active")).list()).map((u) => u.name),
        hasSub: await users.all().filter(exists("subscription.provider")).count(),
        providerIn: (await users.all().filter(inList("subscription.provider", ["apple", "google"])).list()).map((u) => u.name)
      };
    };
    const mem = await run(new InMemoryBackend());
    const sql = await run(new SQLiteBackend(new DatabaseSync(":memory:")));
    expect(sql).toEqual(mem);
    expect(mem).toEqual({ byCustomer: ["a"], active: ["a"], hasSub: 2, providerIn: ["b"] });
  });

  it("round-trips the whole subdocument", async () => {
    const users = seed(new SQLiteBackend(new DatabaseSync(":memory:")));
    const u = users.createInstance({ name: "a", subscription: { provider: "stripe", customerId: "x", details: { status: "active", price: 42 } } });
    users.save(u);
    await users.persist();
    const back = (await users.get(u.uuid))!;
    expect(back.subscription).toEqual({ provider: "stripe", customerId: "x", details: { status: "active", price: 42 } });
  });

  it("preserves the discriminated union at compile time (typed filters)", () => {
    const users = seed(new InMemoryBackend());
    // the discriminant is a literal union, not `string`
    void users.all().where({ "subscription.provider": "stripe" });
    // @ts-expect-error — provider must be a known literal
    void users.all().where({ "subscription.provider": "paypal" });
    expect(true).toBe(true);
  });

  it("schema-driven: infers the type from a zod validator AND validates every write", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const sub = z.discriminatedUnion("provider", [
      z.object({ provider: z.literal("stripe"), customerId: z.string(), details: z.object({ status: z.string() }) }),
      z.object({ provider: z.literal("apple"), details: z.object({ status: z.string(), orderId: z.string().optional() }) })
    ]);
    const users = orm.define({ name: "s", properties: { name: text(), subscription: embedded(sub) } });

    // (1) the type is inferred from the schema — the discriminant is a literal union, not `string`
    void users.all().where({ "subscription.provider": "stripe" });
    // @ts-expect-error — inferred: provider must be a known literal
    void users.all().where({ "subscription.provider": "paypal" });

    // (2) a valid subdocument round-trips
    const u = users.createInstance({ name: "a", subscription: { provider: "stripe", customerId: "cus_1", details: { status: "active" } } });
    users.save(u);
    await users.persist();
    expect((await users.get(u.uuid))!.subscription).toEqual({ provider: "stripe", customerId: "cus_1", details: { status: "active" } });

    // (3) an invalid subdocument is rejected at write time (the manual embedded<T>() form can't do this)
    expect(() =>
      users.createInstance({ name: "b", subscription: { provider: "stripe", details: { status: "active" } } as never })
    ).toThrow(ValidationError); // stripe requires customerId
    expect(() =>
      users.createInstance({ name: "c", subscription: { provider: "venmo", details: { status: "x" } } as never })
    ).toThrow(ValidationError); // unknown provider
  });

  it("contrast: a json() column stays opaque to dotted paths (the reason embedded() exists)", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const users = orm.define({ name: "j", properties: { name: text(), sub: json<Sub>() } });
    users.save(users.createInstance({ name: "a", sub: { provider: "stripe", customerId: "cus_1" } }));
    await users.persist();
    expect(await users.all().filter(eq("sub.customerId", "cus_1")).count()).toBe(0); // opaque — no match
    expect((await users.get((await users.all().list())[0]!.uuid))!.sub.customerId).toBe("cus_1"); // but the value is intact
  });
});
