/**
 * Keyset (cursor) pagination — `collection.page({ limit, after })`. It seeks past the previous page
 * with a `WHERE (sortKeys, uuid) > cursor` predicate (uuid tiebreaker for a total order) instead of
 * `OFFSET`, so it pushes down like any filter. Verified for full coverage/no-dup/no-gap across ties,
 * descending + multi-key orders, codec'd fields, and — on pg-mem — that the seek is actually pushed
 * to SQL and matches the in-memory reference.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { text, integer, date } from "../properties/factories.js";
import type { QueryCollection } from "./QueryCollection.js";

/** Page all the way through, returning every item in traversal order. */
async function drain<T>(make: () => QueryCollection<T>, limit: number): Promise<T[]> {
  const all: T[] = [];
  let after: string | null | undefined = undefined;
  let guard = 0;
  for (;;) {
    if (++guard > 1000) throw new Error("pagination did not terminate");
    const page = await make().page({ limit, after });
    all.push(...page.items);
    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      break;
    }
    after = page.nextCursor;
  }
  return all;
}

const uuids = (rows: Array<{ uuid: string }>) => rows.map((r) => r.uuid);

describe("keyset pagination", () => {
  it("covers every row exactly once across pages, ordering ties by uuid", async () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });
    // deliberate ties on age so the uuid tiebreaker is exercised
    const ages = [30, 30, 25, 40, 30, 25, 18];
    for (let i = 0; i < ages.length; i++) users.save(users.createInstance({ uuid: `u${i}`, name: `n${i}`, age: ages[i] }));
    await users.persist();

    const seen = await drain(() => users.all().sort("age"), 2);
    expect(seen).toHaveLength(ages.length);
    expect(new Set(uuids(seen)).size).toBe(ages.length); // no duplicates, no gaps
    // strictly increasing by (age, uuid) — the total keyset order
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1]!;
      const b = seen[i]!;
      expect(a.age < b.age || (a.age === b.age && a.uuid < b.uuid)).toBe(true);
    }
  });

  it("paginates a descending order", async () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { age: integer() } });
    for (let i = 0; i < 6; i++) users.save(users.createInstance({ uuid: `u${i}`, age: i * 10 }));
    await users.persist();

    const seen = await drain(() => users.all().sort("age", true), 2);
    expect(seen.map((u) => u.age)).toEqual([50, 40, 30, 20, 10, 0]);
  });

  it("paginates a multi-key order (age asc, name desc)", async () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });
    const rows = [
      { uuid: "a", name: "Zoe", age: 30 },
      { uuid: "b", name: "Amy", age: 30 },
      { uuid: "c", name: "Bob", age: 25 }
    ];
    for (const r of rows) users.save(users.createInstance(r));
    await users.persist();

    const seen = await drain(() => users.all().sort("age").sort("name", true), 1);
    expect(seen.map((u) => `${u.age}:${u.name}`)).toEqual(["25:Bob", "30:Zoe", "30:Amy"]);
  });

  it("encodes a codec'd sort key (date) into the cursor", async () => {
    const orm = new RepositoryManager();
    const events = orm.define({ name: "Event", properties: { at: date(), label: text() } });
    const days = [3, 1, 2, 5, 4].map((d) => new Date(2020, 0, d));
    for (let i = 0; i < days.length; i++) events.save(events.createInstance({ uuid: `e${i}`, at: days[i], label: `l${i}` }));
    await events.persist();

    const seen = await drain(() => events.all().sort("at"), 2);
    expect(seen.map((e) => (e.at as Date).getDate())).toEqual([1, 2, 3, 4, 5]);
  });

  it("respects a filter and reports hasMore / nextCursor", async () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { age: integer() } });
    for (let i = 0; i < 5; i++) users.save(users.createInstance({ uuid: `u${i}`, age: i })); // ages 0..4
    await users.persist();

    const { gt } = await import("../expressions/index.js");
    const page1 = await users.all().filter(gt("age", 1)).sort("age").page({ limit: 2 }); // ages 2,3,4
    expect(page1.items.map((u) => u.age)).toEqual([2, 3]);
    expect(page1.hasMore).toBe(true);

    const page2 = await users.all().filter(gt("age", 1)).sort("age").page({ limit: 2, after: page1.nextCursor });
    expect(page2.items.map((u) => u.age)).toEqual([4]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("rejects a bad limit and a cursor from a different ordering", async () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });
    users.save(users.createInstance({ uuid: "u0", name: "a", age: 1 }));
    users.save(users.createInstance({ uuid: "u1", name: "b", age: 2 }));
    await users.persist();

    await expect(users.all().page({ limit: 0 })).rejects.toThrow(/positive integer/);
    const byAge = await users.all().sort("age").page({ limit: 1 });
    await expect(users.all().sort("name").page({ limit: 1, after: byAge.nextCursor })).rejects.toThrow(/ordering/);
  });
});

describe("keyset pagination pushes down to SQL", () => {
  class SpyPg {
    readonly sql: string[] = [];
    constructor(private readonly pool: { query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) {}
    query(sql: string, params: unknown[]) {
      this.sql.push(sql);
      return this.pool.query(sql, params);
    }
  }

  it("emits a keyset WHERE + LIMIT (no OFFSET) and matches the reference on pg-mem", async () => {
    const spy = new SpyPg(new (newDb().adapters.createPg().Pool)());
    const orm = new RepositoryManager({ backend: new PostgresBackend(spy) });
    const users = orm.define({ name: "kp_users", properties: { name: text(), age: integer() } });
    await orm.transaction(async () => {
      for (const [i, age] of [40, 20, 30, 20, 10].entries()) users.save(users.createInstance({ uuid: `u${i}`, name: `n${i}`, age }));
    });

    const page1 = await users.all().sort("age").page({ limit: 2 });
    expect(page1.items.map((u) => u.age)).toEqual([10, 20]);

    spy.sql.length = 0;
    const page2 = await users.all().sort("age").page({ limit: 2, after: page1.nextCursor });
    expect(page2.items.map((u) => u.age)).toEqual([20, 30]); // the second age-20 row, then 30

    const seek = spy.sql.find((s) => s.startsWith("SELECT"))!;
    expect(seek).toContain(`"age" >`); // the keyset predicate pushed down
    expect(seek).toContain("LIMIT 3"); // limit + 1
    expect(seek).not.toMatch(/OFFSET [1-9]/); // seeks via WHERE, never skips rows with a non-zero OFFSET
  });
});
