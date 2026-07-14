/**
 * Timezone-aware date parts. A `Date` near a local midnight buckets into different days depending on
 * the timezone; `year`/`dateToString(...)` with an IANA zone shift the boundary consistently on every
 * backend that runs the reference (in-memory, IndexedDB, and Postgres/MySQL — which reduce date parts
 * in memory). SQLite can't express an IANA offset and rejects it loudly.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { date, integer } from "../properties/factories.js";
import { dateToString, year, dayOfMonth, field } from "./values.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

describe("timezone-aware date parts", () => {
  it("buckets a near-midnight instant into different days by zone (in-memory reference)", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const events = orm.define({ name: "ev", properties: { ts: date(), n: integer() } });
    // 2024-01-01 23:30 UTC → still Jan 1 in UTC, but already Jan 2 in Berlin (UTC+1)
    events.save(events.createInstance({ ts: new Date("2024-01-01T23:30:00Z"), n: 1 }));
    await events.persist();

    const utc = await events.all().groupByExpr(dateToString(field("ts"), "%Y-%m-%d"), (a) => ({ c: a.count() }));
    const berlin = await events.all().groupByExpr(dateToString(field("ts"), "%Y-%m-%d", "Europe/Berlin"), (a) => ({ c: a.count() }));
    expect(utc[0]!.key).toBe("2024-01-01");
    expect(berlin[0]!.key).toBe("2024-01-02"); // the offset moved it to the next day
  });

  it("year()/dayOfMonth() honour the zone", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const m = orm.define({ name: "m", properties: { ts: date() } });
    // 2023-12-31 23:30 UTC → 2024-01-01 in Berlin
    m.save(m.createInstance({ ts: new Date("2023-12-31T23:30:00Z") }));
    await m.persist();
    const [g] = await m.all().groupByMany([year(field("ts"), "Europe/Berlin"), dayOfMonth(field("ts"), "Europe/Berlin")], (a) => ({ c: a.count() }));
    expect(g!.key).toEqual([2024, 1]); // Berlin already rolled into the new year
  });

  it("SQLite still pushes down a UTC date part but rejects a zoned one (loud, not silently wrong)", async () => {
    const orm = new RepositoryManager({ backend: new SQLiteBackend(new DatabaseSync(":memory:")) });
    const ev = orm.define({ name: "ev", properties: { ts: date() } });
    ev.save(ev.createInstance({ ts: new Date("2024-01-01T23:30:00Z") }));
    await ev.persist();
    // UTC date parts still push down on SQLite:
    const utc = await ev.all().groupByExpr(dateToString(field("ts"), "%Y-%m-%d"), (a) => ({ c: a.count() }));
    expect(utc[0]!.key).toBe("2024-01-01");
    // but a zoned one is refused loudly rather than silently wrong:
    await expect(ev.all().groupByExpr(dateToString(field("ts"), "%Y-%m-%d", "Europe/Berlin"), (a) => ({ c: a.count() }))).rejects.toThrow(/IANA|timezone/);
  });
});
