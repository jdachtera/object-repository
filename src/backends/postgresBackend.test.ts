/**
 * Behavioral tests for `PostgresBackend`, run against `pg-mem` (an in-process Postgres emulator) via
 * its `pg` adapter — the same interface a real `pg` `Pool` exposes. This exercises the actual
 * generated SQL end to end: jsonb storage, `::numeric` casts, ranges, ordering, paging, COUNT, and
 * `GROUP BY` push-down, plus the in-memory scan fallback for an op the compiler doesn't emit.
 *
 * (pg-mem doesn't implement the jsonb array/type functions, so `exists`/`size`/`any` push-down isn't
 * exercised here — those run on the scan fallback, which the last test checks stays correct.)
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer, array, date } from "../properties/factories.js";
import { eq, gt, inList, notInList, between, and, size, field, mul, cond, switchExpr, cmp, year } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

function makeBackend() {
  const { Pool } = newDb().adapters.createPg();
  return new PostgresBackend(new Pool());
}

describe("PostgresBackend against pg-mem", () => {
  it("round-trips CRUD and pushes filters / sort / paging / count down to SQL", async () => {
    const orm = new RepositoryManager({ backend: makeBackend() });
    const users = orm.define({ name: "users_pg", properties: { name: text(), age: integer(), city: text() } });
    for (const [name, age, city] of [["Ann", 30, "eu"], ["Bo", 40, "us"], ["Cy", 20, "eu"]] as const) {
      users.save(users.createInstance({ name, age, city }));
    }
    await users.persist();

    expect(await users.all().count()).toBe(3);
    expect((await users.all().filter(gt("age", 25)).sort("age").list()).map((u) => u.name)).toEqual(["Ann", "Bo"]);
    expect((await users.all().filter(inList("city", ["eu"])).list()).map((u) => u.name).sort()).toEqual(["Ann", "Cy"]);
    expect((await users.all().filter(notInList("city", ["eu"])).list()).map((u) => u.name)).toEqual(["Bo"]);
    expect((await users.all().filter(between("age", 25, 45)).list()).map((u) => u.name).sort()).toEqual(["Ann", "Bo"]);
    expect((await users.all().filter(and(gt("age", 18), eq("city", "eu"))).list()).map((u) => u.name).sort()).toEqual(["Ann", "Cy"]);
    // computed expression pushes down: age * 2 > 70 → only Bo (80)
    expect((await users.all().filter(gt(mul(field("age"), 2), 70)).list()).map((u) => u.name)).toEqual(["Bo"]);
    // sort desc + paging
    expect((await users.all().sort("age", true).slice(0, 2).list()).map((u) => u.name)).toEqual(["Bo", "Ann"]);
    expect(await users.all().filter(gt("age", 25)).count()).toBe(2);

    // re-save updates the same row (upsert by uuid), count unchanged
    const ann = (await users.all().filter(eq("name", "Ann")).list())[0]!;
    ann.age = 31;
    users.save(ann);
    await users.persist();
    expect((await users.all().filter(eq("name", "Ann")).list())[0]!.age).toBe(31);
    expect(await users.all().count()).toBe(3);
  });

  it("pushes aggregate / groupBy down to a real GROUP BY", async () => {
    const orm = new RepositoryManager({ backend: makeBackend() });
    const sales = orm.define({ name: "sales_pg", properties: { region: text(), amount: integer() } });
    for (const [region, amount] of [["eu", 10], ["eu", 30], ["us", 100]] as const) {
      sales.save(sales.createInstance({ region, amount }));
    }
    await sales.persist();

    const totals = await sales.all().aggregate((a) => ({ n: a.count(), total: a.sum("amount"), avg: a.avg("amount") }));
    expect(totals.n).toBe(3);
    expect(totals.total).toBe(140);
    expect(totals.avg).toBeCloseTo(140 / 3, 6);

    const byRegion = (await sales.all().groupBy("region", (a) => ({ total: a.sum("amount") }))).sort((x, y) =>
      String(x.key).localeCompare(String(y.key))
    );
    expect(byRegion).toEqual([{ key: "eu", total: 40 }, { key: "us", total: 100 }]);
    // filtered aggregate: only amounts > 20
    expect((await sales.all().filter(gt("amount", 20)).aggregate((a) => ({ n: a.count() }))).n).toBe(2);
  });

  it("pushes cond / switch with string conditions down correctly (CASE WHEN over text)", async () => {
    const orm = new RepositoryManager({ backend: makeBackend() });
    const songs = orm.define({ name: "songs_pg", properties: { level: text(), plays: integer() } });
    for (const [level, plays] of [["beginner", 10], ["beginner", 5], ["advanced", 20]] as const) {
      songs.save(songs.createInstance({ level, plays }));
    }
    await songs.persist();

    const stats = await songs.all().aggregate((a) => ({
      beginners: a.sum(cond(cmp(field("level"), "=", "beginner"), 1, 0)),
      weighted: a.sum(
        switchExpr(
          [
            [cmp(field("level"), "=", "beginner"), 1],
            [cmp(field("level"), "=", "advanced"), 3]
          ],
          0
        )
      )
    }));
    expect(stats).toEqual({ beginners: 2, weighted: 1 + 1 + 3 });
  });

  it("falls back to the in-memory reference for ops it can't compile (size), still correct", async () => {
    const orm = new RepositoryManager({ backend: makeBackend() });
    const users = orm.define({ name: "sizetest_pg", properties: { name: text(), tags: array<string>() } });
    for (const [name, tags] of [["Ann", ["x", "y"]], ["Bo", []], ["Cy", ["z"]]] as const) {
      users.save(users.createInstance({ name, tags: [...tags] }));
    }
    await users.persist();
    expect((await users.all().filter(size("tags", 0)).list()).map((u) => u.name)).toEqual(["Bo"]);
    expect((await users.all().filter(size("tags", 2)).list()).map((u) => u.name)).toEqual(["Ann"]);
    // count also falls back (compileWhere returns null for size) — still correct
    expect(await users.all().filter(size("tags", 2)).count()).toBe(1);
  });

  it("covers queryUuids, remove, the change feed, and the aggregate scan-fallback", async () => {
    const backend = makeBackend();
    const orm = new RepositoryManager({ backend });
    const events = orm.define({ name: "feed_pg", properties: { region: text(), amount: integer(), ts: date() } });

    const seen: string[] = [];
    backend.changes((e) => e.kind === "saved" && seen.push(String(e.uuid)), SYSTEM_CONTEXT);

    const a = events.createInstance({ region: "eu", amount: 10, ts: new Date(Date.UTC(2023, 0, 1)) });
    const b = events.createInstance({ region: "us", amount: 20, ts: new Date(Date.UTC(2024, 0, 1)) });
    events.save(a);
    events.save(b);
    await events.persist();
    expect(seen).toContain(a.uuid); // change feed fired on persist

    // queryUuids (project-uuid path)
    expect((await events.all().listUuids()).sort()).toEqual([a.uuid, b.uuid].sort());

    // groupByExpr(year(ts)) can't compile (date part) → aggregate scan-fallback, still correct
    const byYear = (await events.all().groupByExpr(year(field("ts")), (agg) => ({ n: agg.count() }))).sort(
      (x, y) => Number(x.key) - Number(y.key)
    );
    expect(byYear).toEqual([{ key: 2023, n: 1 }, { key: 2024, n: 1 }]);

    // remove → DELETE
    events.remove(a);
    await events.persist();
    expect(await events.all().count()).toBe(1);
  });
});
