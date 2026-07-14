/**
 * The observability decorator `observe(backend, options)`: reports timing/outcome for every async
 * operation, fires a slow-query hook past a threshold, and — crucially — mirrors the inner backend's
 * capabilities exactly, so wrapping never downgrades push-down. Timing is made deterministic with an
 * injected clock.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { observe } from "./decorators/ObservabilityBackend.js";
import type { OperationEvent } from "./decorators/ObservabilityBackend.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { isCounting, isAggregating, isTransactional, isRawQueryable, isSchemaAware, isPatching } from "../core/Backend.js";
import { isMigratable } from "./sql/migrate.js";
import { text, integer } from "../properties/factories.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Context } from "../core/types.js";
import type {
  Backend,
  CountingBackend,
  AggregatingBackend,
  PatchingBackend,
  MultiPatchingBackend,
  UpsertingBackend,
  RawQueryable
} from "../core/Backend.js";
import type { MigratableBackend } from "./sql/migrate.js";
import type { AggregatePlan, QueryPlan } from "../core/QueryPlan.js";

const ctx = SYSTEM_CONTEXT;
/** A clock that advances a fixed step per read, so each operation's measured duration is exactly `step`. */
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};
const allOf = (model: string): QueryPlan => ({ model, where: { type: "all" }, order: [], paging: { start: 0 } });

describe("observe: capability preservation", () => {
  it("does not add capabilities the in-memory backend lacks", () => {
    const obs = observe(new InMemoryBackend());
    expect(isSchemaAware(obs)).toBe(true); // in-memory is now schema-aware (unique enforcement)
    expect(isCounting(obs)).toBe(false);
    expect(isAggregating(obs)).toBe(false);
    expect(isTransactional(obs)).toBe(false); // no `transaction` method (the capabilities flag is separate)
    expect(isMigratable(obs)).toBe(false);
    expect(isRawQueryable(obs)).toBe(false);
    expect(isPatching(obs)).toBe(false);
  });

  it("preserves the SQL backend's capabilities so push-down is not lost", () => {
    const pg = new PostgresBackend(new (newDb().adapters.createPg().Pool)());
    const obs = observe(pg);
    expect(isCounting(obs)).toBe(true);
    expect(isAggregating(obs)).toBe(true);
    expect(isTransactional(obs)).toBe(true);
    expect(isMigratable(obs)).toBe(true);
    expect(isRawQueryable(obs)).toBe(true);
    expect(obs.capabilities).toBe(pg.capabilities); // the capabilities descriptor is forwarded as-is
  });
});

describe("observe: operation events", () => {
  it("reports a query with model, ok, row count, and the measured duration", async () => {
    const events: OperationEvent[] = [];
    const inner = new InMemoryBackend();
    inner.save("M", { uuid: "a" }, ctx);
    await inner.persist(ctx);
    const obs = observe(inner, { now: clock(7), onOperation: (e) => events.push(e) });

    const rows = await obs.query(allOf("M"), ctx);
    expect(rows).toHaveLength(1);
    expect(events).toEqual([{ operation: "query", model: "M", durationMs: 7, ok: true, rows: 1, error: undefined }]);
  });

  it("reports persist with the changed-record count", async () => {
    const events: OperationEvent[] = [];
    const obs = observe(new InMemoryBackend(), { now: clock(3), onOperation: (e) => events.push(e) });
    obs.save("M", { uuid: "a" }, ctx);
    obs.save("M", { uuid: "b" }, ctx);
    await obs.persist(ctx);
    expect(events).toEqual([{ operation: "persist", model: undefined, durationMs: 3, ok: true, rows: 2, error: undefined }]);
  });

  it("fires onSlowQuery only at or beyond the threshold", async () => {
    const slow: OperationEvent[] = [];
    const inner = new InMemoryBackend();
    const atThreshold = observe(inner, { now: clock(10), slowThresholdMs: 10, onSlowQuery: (e) => slow.push(e) });
    await atThreshold.query(allOf("M"), ctx);
    expect(slow).toHaveLength(1); // 10ms >= 10ms

    slow.length = 0;
    const underThreshold = observe(inner, { now: clock(10), slowThresholdMs: 11, onSlowQuery: (e) => slow.push(e) });
    await underThreshold.query(allOf("M"), ctx);
    expect(slow).toHaveLength(0); // 10ms < 11ms
  });

  it("reports a failed operation (ok:false + error) and re-throws", async () => {
    const events: OperationEvent[] = [];
    const boom: Backend = {
      capabilities: { indexes: false, ranges: false, sortPushdown: false, joins: false, transactions: false, changeFeed: true },
      query: async () => {
        throw new Error("boom");
      },
      queryUuids: async () => [],
      save: () => {},
      remove: () => {},
      persist: async () => ({ saved: [], removed: [] }),
      changes: () => () => {}
    };
    const obs = observe(boom, { now: clock(4), onOperation: (e) => events.push(e) });

    await expect(obs.query(allOf("M"), ctx)).rejects.toThrow("boom");
    expect(events[0]!.ok).toBe(false);
    expect(events[0]!.operation).toBe("query");
    expect(events[0]!.durationMs).toBe(4);
    expect(events[0]!.error).toBeInstanceOf(Error);
  });
});

describe("observe: instruments every capability", () => {
  it("times each optional operation and derives a sensible row count", async () => {
    let discarded = false;
    const full = {
      capabilities: { indexes: true, ranges: true, sortPushdown: true, joins: false, transactions: true, changeFeed: true },
      registerModel: () => {},
      query: async () => [{ uuid: "a" }],
      queryUuids: async () => ["a"],
      save: () => {},
      remove: () => {},
      persist: async () => ({ saved: [], removed: [] }),
      discardPending: () => {
        discarded = true;
      },
      changes: () => () => {},
      count: async () => 5,
      aggregate: async () => [{ key: [], values: {} }],
      patch: async () => {},
      patchMany: async () => 3,
      upsert: async () => {},
      raw: async () => [{}, {}],
      transaction: async (fn: (tx: Backend) => Promise<unknown>) => fn(full as unknown as Backend),
      migrate: async () => ({ applied: ["m1"], skipped: [] }),
      rollback: async () => ({ applied: ["m1"], skipped: [] })
    };
    const events: OperationEvent[] = [];
    const obs = observe(full as unknown as Backend, { now: clock(2), onOperation: (e) => events.push(e) }) as Backend &
      CountingBackend &
      AggregatingBackend &
      PatchingBackend &
      MultiPatchingBackend &
      UpsertingBackend &
      RawQueryable &
      MigratableBackend & { transaction<T>(fn: (tx: Backend) => Promise<T>, ctx: Context): Promise<T> };
    const agg: AggregatePlan = { model: "M", where: { type: "all" }, groupBy: [], aggregates: [{ name: "n", op: "count" }] };

    await obs.queryUuids(allOf("M"), ctx);
    await obs.count(allOf("M"), ctx);
    await obs.aggregate(agg, ctx);
    await obs.patch("M", "a", {}, ctx);
    await obs.patchMany("M", { type: "all" }, {}, ctx);
    await obs.upsert("M", { type: "all" }, {}, {}, ctx);
    await obs.raw({ sql: "x" }, ctx);
    await obs.transaction(async () => "ok", ctx);
    await obs.migrate([]);
    await obs.rollback([], 1);
    obs.discardPending!();

    expect(events.map((e) => e.operation)).toEqual([
      "queryUuids", "count", "aggregate", "patch", "patchMany", "upsert", "raw", "transaction", "migrate", "rollback"
    ]);
    expect(events.find((e) => e.operation === "count")!.rows).toBe(5);
    expect(events.find((e) => e.operation === "patchMany")!.rows).toBe(3);
    expect(events.find((e) => e.operation === "raw")!.rows).toBe(2);
    expect(events.find((e) => e.operation === "migrate")!.rows).toBe(1);
    expect(events.find((e) => e.operation === "patch")!.rows).toBeUndefined();
    expect(discarded).toBe(true); // discardPending forwarded (not timed — no event for it)
  });
});

describe("observe: end to end + preserved push-down", () => {
  it("traces the operations a repository drives, and count/aggregate still push down", async () => {
    const events: OperationEvent[] = [];
    const backend = observe(new PostgresBackend(new (newDb().adapters.createPg().Pool)()), { onOperation: (e) => events.push(e) });
    const orm = new RepositoryManager({ backend });
    const sales = orm.define({ name: "sale", properties: { region: text(), amount: integer() } });

    await orm.transaction(async () => {
      sales.save(sales.createInstance({ region: "eu", amount: 10 }));
      sales.save(sales.createInstance({ region: "eu", amount: 20 }));
      sales.save(sales.createInstance({ region: "us", amount: 5 }));
    });
    expect(await sales.all().count()).toBe(3);
    expect(await sales.all().aggregate((a) => ({ total: a.sum("amount") }))).toEqual({ total: 35 });

    const ops = events.map((e) => e.operation);
    // count & aggregate appear → the decorator kept the backend's native push-down (else they'd be plain queries)
    expect(ops).toContain("count");
    expect(ops).toContain("aggregate");
    expect(ops).toContain("transaction");
    expect(events.every((e) => e.ok)).toBe(true);
  });
});
