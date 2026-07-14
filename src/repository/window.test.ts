/**
 * Ranking window functions (`rowNumber`/`rank`/`denseRank`) over a partition — the portable
 * `$setWindowFields` / SQL `OVER (PARTITION BY … ORDER BY …)`. Verified identical on the in-memory
 * reference and pushed down to SQLite/columnar SQL. Closes the "rank within a partition" gap
 * (leaderboard rank, is-this-the-first-payment, top-N-per-group).
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { text, integer } from "../properties/factories.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// payments: two users, ordered by amount within each user
const DATA = [
  { user: "u1", amount: 100, uuid: "a" },
  { user: "u1", amount: 300, uuid: "b" },
  { user: "u1", amount: 300, uuid: "c" }, // tie with b at 300
  { user: "u2", amount: 50, uuid: "d" },
  { user: "u2", amount: 80, uuid: "e" }
];

const seed = (backend: Backend) => {
  const orm = new RepositoryManager({ backend });
  const pay = orm.define({ name: "pay", properties: { user: text(), amount: integer() } });
  for (const d of DATA) pay.save(pay.createInstance(d as never));
  return pay;
};

describe("windowed() ranking", () => {
  it("rowNumber / rank / denseRank per user, ordered by amount — identical InMemory vs SQLite", async () => {
    const run = async (backend: Backend) => {
      const pay = seed(backend);
      await pay.persist();
      const ranked = await pay
        .all()
        .sort("amount")
        .windowed({ partitionBy: "user" }, (w) => ({ n: w.rowNumber(), r: w.rank(), dr: w.denseRank() }));
      return Object.fromEntries(ranked.map((row) => [(row as { uuid: string }).uuid, [row.n, row.r, row.dr]]));
    };
    const mem = await run(new InMemoryBackend());
    const sql = await run(new SQLiteBackend(new DatabaseSync(":memory:")));
    expect(sql).toEqual(mem);
    // u1 by amount asc: a(100) b(300) c(300); ties b & c share rank 2, denseRank 2, rowNumber distinct
    expect(mem.a).toEqual([1, 1, 1]);
    expect(mem.b).toEqual([2, 2, 2]);
    expect(mem.c).toEqual([3, 2, 2]); // rowNumber 3, rank 2 (tie), denseRank 2
    // u2: d(50) e(80)
    expect(mem.d).toEqual([1, 1, 1]);
    expect(mem.e).toEqual([2, 2, 2]);
  });

  it("descending order + the 'is this the user's top payment?' use (rank === 1)", async () => {
    const pay = seed(new SQLiteBackend(new DatabaseSync(":memory:")));
    await pay.persist();
    const ranked = await pay.all().sort("amount", true).windowed({ partitionBy: "user" }, (w) => ({ r: w.rank() }));
    const top = ranked.filter((row) => row.r === 1).map((row) => (row as { uuid: string }).uuid).sort();
    // top per user by amount desc: u1 → b & c (both 300, tie), u2 → e (80)
    expect(top).toEqual(["b", "c", "e"]);
  });

  it("no partition = rank over the whole set", async () => {
    const pay = seed(new InMemoryBackend());
    await pay.persist();
    const ranked = await pay.all().sort("amount").windowed({}, (w) => ({ n: w.rowNumber() }));
    expect(ranked.map((r) => r.n).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
    expect(ranked.find((r) => (r as { uuid: string }).uuid === "d")!.n).toBe(1); // 50 is the global min
  });
});
