/**
 * `countDistinct` aggregator — the portable `$size` of `$addToSet` / SQL `COUNT(DISTINCT x)`. It closes
 * the single most-used analytics gap (unique-users-per-bucket). Verified identical on the in-memory
 * reference and pushed-down SQLite; NULL/absent values are skipped on every backend.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { text, integer } from "../properties/factories.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const DATA = [
  { day: "2024-01-01", userId: "u1" },
  { day: "2024-01-01", userId: "u1" }, // dup → 1 distinct
  { day: "2024-01-02", userId: "u1" },
  { day: "2024-01-02", userId: "u2" },
  { day: "2024-01-02", userId: "u2" }, // 2 distinct
  { day: "2024-01-03", userId: "u3" }
];

const seed = async (backend: Backend) => {
  const orm = new RepositoryManager({ backend });
  const events = orm.define({ name: "ev", properties: { day: text(), userId: text(), score: integer() } });
  for (const d of DATA) events.save(events.createInstance(d));
  await events.persist();
  return events;
};

describe("countDistinct", () => {
  it("counts distinct users per day, identical on InMemory and SQLite", async () => {
    const run = async (backend: Backend) => {
      const events = await seed(backend);
      const groups = await events.all().groupBy("day", (a) => ({ users: a.countDistinct("userId"), events: a.count() }));
      return Object.fromEntries(groups.map((g) => [g.key, [g.users, g.events]]));
    };
    const mem = await run(new InMemoryBackend());
    const sql = await run(new SQLiteBackend(new DatabaseSync(":memory:")));
    expect(sql).toEqual(mem);
    expect(mem).toEqual({
      "2024-01-01": [1, 2], // u1 twice → 1 distinct, 2 events
      "2024-01-02": [2, 3], // u1,u2,u2 → 2 distinct
      "2024-01-03": [1, 1]
    });
  });

  it("global distinct count (no group key)", async () => {
    const events = await seed(new SQLiteBackend(new DatabaseSync(":memory:")));
    const users = (await events.all().groupByMany([], (a) => ({ users: a.countDistinct("userId") })))[0]!.users;
    expect(users).toBe(3); // u1, u2, u3
  });

  it("skips null/absent values (like COUNT(DISTINCT))", async () => {
    const run = async (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const t = orm.define({ name: "t", properties: { tag: text() } });
      for (const r of [{ tag: "a" }, { tag: "a" }, { tag: "b" }, {}]) t.save(t.createInstance(r)); // one missing tag
      await t.persist();
      const n = (await t.all().groupByMany([], (a) => ({ n: a.countDistinct("tag") })))[0]!.n;
      return n;
    };
    expect(await run(new InMemoryBackend())).toBe(2); // a, b — the missing one doesn't count
    expect(await run(new SQLiteBackend(new DatabaseSync(":memory:")))).toBe(2);
  });
});
