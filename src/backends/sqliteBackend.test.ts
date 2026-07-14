import { describe, it, expect, vi } from "vitest";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer, date, relationToMany } from "../properties/factories.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all, eq, gt, or, between, contains, exists, size, mul, field, year, notInList } from "../expressions/index.js";
import type { QueryPlan, ExpressionNode } from "../core/QueryPlan.js";
import type { SortKey } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;

// Load `node:sqlite` via the runtime builtin lookup so the bundler/test runner doesn't try to
// resolve it statically (it's too new for Vite's builtin list).
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function makeBackend(): SQLiteBackend {
  return new SQLiteBackend(new DatabaseSync(":memory:"));
}

function plan(
  model: string,
  where: ExpressionNode = all().serialize(),
  order: SortKey[] = [],
  paging: { start: number; end?: number } = { start: 0 }
): QueryPlan {
  return { model, where, order, paging };
}

async function seed(backend: SQLiteBackend) {
  backend.registerModel("User", [{ name: "age", fields: [{ path: "age" }], unique: false }]);
  backend.save("User", { uuid: "u1", name: "Peter", age: 35, langs: ["de", "en"] }, ctx);
  backend.save("User", { uuid: "u2", name: "John", age: 40, langs: ["en"] }, ctx);
  backend.save("User", { uuid: "u3", name: "Jane", age: 25, langs: ["fr"] }, ctx);
  await backend.persist(ctx);
}

describe("SQLiteBackend", () => {
  it("persists and reads back records (JSON round-trip)", async () => {
    const backend = makeBackend();
    await seed(backend);
    const all = await backend.query(plan("User"), ctx);
    expect(all).toHaveLength(3);
    expect(all.find((u) => u.uuid === "u1")).toMatchObject({ name: "Peter", age: 35 });
  });

  it("compiles filters to SQL (compare / or / between)", async () => {
    const backend = makeBackend();
    await seed(backend);
    expect((await backend.query(plan("User", gt("age", 30).serialize()), ctx)).map((u) => u.uuid).sort()).toEqual(["u1", "u2"]);
    expect((await backend.query(plan("User", eq("name", "Jane").serialize()), ctx)).map((u) => u.uuid)).toEqual(["u3"]);
    expect((await backend.query(plan("User", or(eq("name", "John"), eq("name", "Peter")).serialize()), ctx))).toHaveLength(2);
    expect((await backend.query(plan("User", between("age", 24, 36).serialize()), ctx)).map((u) => u.uuid).sort()).toEqual(["u1", "u3"]);
  });

  it("compiles `notInList` ($nin), where a missing field matches", async () => {
    const backend = makeBackend();
    backend.save("U", { uuid: "a", role: "admin" }, ctx);
    backend.save("U", { uuid: "b", role: "user" }, ctx);
    backend.save("U", { uuid: "c" }, ctx); // role absent → matches NOT IN
    await backend.persist(ctx);
    const out = await backend.query(plan("U", notInList("role", ["admin"]).serialize()), ctx);
    expect(out.map((u) => u.uuid).sort()).toEqual(["b", "c"]);
  });

  it("compiles `contains` over a JSON array via json_each", async () => {
    const backend = makeBackend();
    await seed(backend);
    const german = await backend.query(plan("User", contains("langs", "de").serialize()), ctx);
    expect(german.map((u) => u.uuid)).toEqual(["u1"]);
  });

  it("compiles `exists` via json_type (present incl. null vs. absent)", async () => {
    const backend = makeBackend();
    backend.save("Doc", { uuid: "d1", publishAt: 100 }, ctx); // present
    backend.save("Doc", { uuid: "d2", publishAt: null }, ctx); // present, null
    backend.save("Doc", { uuid: "d3", title: "draft" }, ctx); // absent
    await backend.persist(ctx);

    const present = await backend.query(plan("Doc", exists("publishAt").serialize()), ctx);
    expect(present.map((d) => d.uuid).sort()).toEqual(["d1", "d2"]); // null counts as present
    const absent = await backend.query(plan("Doc", exists("publishAt", false).serialize()), ctx);
    expect(absent.map((d) => d.uuid)).toEqual(["d3"]);
  });

  it("compiles `size` via json_array_length (only real arrays of that length)", async () => {
    const backend = makeBackend();
    backend.save("Doc", { uuid: "d1", tags: ["a", "b"] }, ctx);
    backend.save("Doc", { uuid: "d2", tags: ["a"] }, ctx);
    backend.save("Doc", { uuid: "d3", tags: [] }, ctx);
    backend.save("Doc", { uuid: "d4", title: "no tags" }, ctx); // missing
    await backend.persist(ctx);

    expect((await backend.query(plan("Doc", size("tags", 2).serialize()), ctx)).map((d) => d.uuid)).toEqual(["d1"]);
    // size 0 matches the empty array but NOT the missing field
    expect((await backend.query(plan("Doc", size("tags", 0).serialize()), ctx)).map((d) => d.uuid)).toEqual(["d3"]);
  });

  it("pushes ORDER BY / LIMIT / OFFSET down to SQL", async () => {
    const backend = makeBackend();
    await seed(backend);
    const desc = await backend.query(plan("User", all().serialize(), [{ property: "age", descending: true }]), ctx);
    expect(desc.map((u) => u.name)).toEqual(["John", "Peter", "Jane"]);
    const page = await backend.query(plan("User", all().serialize(), [{ property: "age", descending: false }], { start: 1, end: 3 }), ctx);
    expect(page.map((u) => u.name)).toEqual(["Peter", "John"]);
  });

  it("counts via SQL COUNT(*), including filtered (full push-down)", async () => {
    const backend = makeBackend();
    await seed(backend);
    expect(await backend.count(plan("User"), ctx)).toBe(3);
    expect(await backend.count(plan("User", gt("age", 30).serialize()), ctx)).toBe(2);
    expect(await backend.count(plan("User", eq("name", "Jane").serialize()), ctx)).toBe(1);
  });

  it("pushes aggregate down to SQL GROUP BY (null/absent-aware, matching the reference)", async () => {
    const backend = makeBackend();
    backend.save("Score", { uuid: "s1", team: "a", pts: 10 }, ctx);
    backend.save("Score", { uuid: "s2", team: "a", pts: 30 }, ctx);
    backend.save("Score", { uuid: "s3", team: "b", pts: null }, ctx); // null value
    backend.save("Score", { uuid: "s4", team: "b" }, ctx); // value absent
    await backend.persist(ctx);

    const field = (path: string) => ({ type: "field" as const, path });
    const aggPlan = (groupBy: string[]) => ({
      model: "Score",
      where: all().serialize(),
      groupBy: groupBy.map(field),
      aggregates: [
        { name: "n", op: "count" as const },
        { name: "sum", op: "sum" as const, value: field("pts") },
        { name: "avg", op: "avg" as const, value: field("pts") },
        { name: "min", op: "min" as const, value: field("pts") },
        { name: "max", op: "max" as const, value: field("pts") }
      ]
    });

    // count is rows; sum/avg/min/max ignore the null + absent values (avg divides by 2, not 4).
    const global = await backend.aggregate(aggPlan([]), ctx);
    expect(global).toEqual([{ key: [], values: { n: 4, sum: 40, avg: 20, min: 10, max: 30 } }]);

    const byTeam = await backend.aggregate(aggPlan(["team"]), ctx);
    expect(byTeam.find((r) => r.key[0] === "a")!.values).toEqual({ n: 2, sum: 40, avg: 20, min: 10, max: 30 });
    // an all-null/absent group: count still 2, numeric reductions coalesce to 0 (the reference's empty case)
    expect(byTeam.find((r) => r.key[0] === "b")!.values).toEqual({ n: 2, sum: 0, avg: 0, min: 0, max: 0 });
  });

  it("pushes a computed aggregate down, binding value params before WHERE params", async () => {
    const backend = makeBackend();
    backend.save("Line", { uuid: "l1", price: 10, region: "eu" }, ctx);
    backend.save("Line", { uuid: "l2", price: 5, region: "eu" }, ctx);
    backend.save("Line", { uuid: "l3", price: 100, region: "us" }, ctx);
    await backend.persist(ctx);

    // SUM(price * 2) has a literal param (2) in the SELECT; the WHERE has a param ("eu") — the
    // SELECT param must bind first or the result is wrong. eu only: 10*2 + 5*2 = 30.
    const result = await backend.aggregate(
      {
        model: "Line",
        where: eq("region", "eu").serialize(),
        groupBy: [],
        aggregates: [{ name: "total", op: "sum" as const, value: mul(field("price"), 2).serialize() }]
      },
      ctx
    );
    expect(result).toEqual([{ key: [], values: { total: 30 } }]);
  });

  it("removes records and emits change events", async () => {
    const backend = makeBackend();
    const listener = vi.fn();
    backend.changes(listener, ctx);
    await seed(backend);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ uuid: "u1", kind: "saved" }));

    backend.remove("User", { uuid: "u2" }, ctx);
    await backend.persist(ctx);
    expect((await backend.query(plan("User"), ctx)).map((u) => u.uuid).sort()).toEqual(["u1", "u3"]);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ uuid: "u2", kind: "removed" }));
  });

  it("auto-assigns a uuid when missing", async () => {
    const backend = makeBackend();
    const record: { uuid?: string; name: string } = { name: "Nameless" };
    backend.save("User", record as never, ctx);
    await backend.persist(ctx);
    expect(record.uuid).toHaveLength(32);
  });
});

describe("Repository over SQLiteBackend", () => {
  function sqliteOrm() {
    return new RepositoryManager({ backend: makeBackend() });
  }

  it("runs the full typed stack with count push-down and aggregates", async () => {
    const orm = sqliteOrm();
    const people = orm.define({ name: "Person", properties: { name: text(), city: text({ index: true }), age: integer({ index: true }) } });
    for (const [name, city, age] of [["Ann", "Berlin", 30], ["Bo", "Berlin", 40], ["Cy", "Paris", 20]] as const) {
      people.save(people.createInstance({ name, city, age }));
    }
    await people.persist();

    expect(await people.all().count()).toBe(3); // SQL COUNT(*)
    expect(await people.all().filter(gt("age", 25)).count()).toBe(2);
    const byCity = await people.all().groupBy("city", (a) => ({ n: a.count() }));
    expect(byCity.find((g) => g.key === "Berlin")!.n).toBe(2);
  });

  it("groups by a computed expression (year bucket) pushed down to SQL", async () => {
    const orm = sqliteOrm();
    const events = orm.define({ name: "Event", properties: { ts: date(), amount: integer() } });
    for (const [y, amount] of [[2023, 10], [2024, 20], [2024, 5]] as const) {
      events.save(events.createInstance({ ts: new Date(Date.UTC(y, 0, 1)), amount }));
    }
    await events.persist();

    // grouped by strftime('%Y', ts/1000, 'unixepoch') GROUP BY 1 — same result as the in-memory path
    const byYear = await events.all().groupByExpr(year(field("ts")), (a) => ({ n: a.count(), total: a.sum("amount") }));
    expect(byYear.find((g) => g.key === 2023)).toEqual({ key: 2023, n: 1, total: 10 });
    expect(byYear.find((g) => g.key === 2024)).toEqual({ key: 2024, n: 2, total: 25 });
  });

  it("groups by multiple keys (compound) pushed down to SQL GROUP BY 1, 2", async () => {
    const orm = sqliteOrm();
    const sales = orm.define({ name: "Sale", properties: { region: text(), product: text(), amount: integer() } });
    for (const [region, product, amount] of [["eu", "a", 10], ["eu", "a", 5], ["eu", "b", 20], ["us", "a", 100]] as const) {
      sales.save(sales.createInstance({ region, product, amount }));
    }
    await sales.persist();

    const groups = await sales.all().groupByMany([field("region"), field("product")], (a) => ({ n: a.count(), total: a.sum("amount") }));
    const find = (region: string, product: string) => groups.find((g) => g.key[0] === region && g.key[1] === product);
    expect(find("eu", "a")).toEqual({ key: ["eu", "a"], n: 2, total: 15 });
    expect(find("eu", "b")).toEqual({ key: ["eu", "b"], n: 1, total: 20 });
    expect(find("us", "a")).toEqual({ key: ["us", "a"], n: 1, total: 100 });
  });

  it("enforces a declared compound unique index", async () => {
    const orm = sqliteOrm();
    const favs = orm.define({
      name: "Fav",
      properties: { userId: text(), songId: text() },
      indexes: [{ fields: ["userId", "songId"], unique: true }]
    });
    favs.save(favs.createInstance({ userId: "u1", songId: "s1" }));
    await favs.persist();

    // a different record with the same (userId, songId) violates the unique index
    favs.save(favs.createInstance({ userId: "u1", songId: "s1" }));
    await expect(favs.persist()).rejects.toThrow();

    // a distinct pair is fine
    favs.save(favs.createInstance({ userId: "u1", songId: "s2" }));
    await expect(favs.persist()).resolves.toBeDefined();
  });

  it("supports relations (decompose-and-stitch over SQL)", async () => {
    const orm = sqliteOrm();
    interface UserModel { uuid: string; name: string; events: EventModel[]; }
    interface EventModel { uuid: string; title: string; users: UserModel[]; }
    const users = orm.define({ name: "User", properties: { name: text(), events: relationToMany<EventModel>({ model: "Event", remoteProperty: "users" }) } });
    const events = orm.define({ name: "Event", properties: { title: text(), users: relationToMany<UserModel>({ model: "User", remoteProperty: "events" }) } });

    const e1 = events.createInstance({ title: "Launch" });
    const peter = users.createInstance({ name: "Peter", events: [e1] });
    users.save(peter);
    await users.persist();

    const [loadedEvent] = await events.all().list();
    expect(loadedEvent!.users.map((u) => u.name)).toEqual(["Peter"]);
  });
});
