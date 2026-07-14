/**
 * Connection resilience (`resilientExecutor`): per-call timeout + safe retry-with-backoff. Reads and
 * whole transactions retry transient failures; writes issued via `run` only time out (retrying could
 * double-apply). Backoff is exponential and capped. Verified against fake executors (with an injected
 * instant sleep) and end-to-end through a flaky `PostgresBackend`.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { resilientExecutor, TimeoutError } from "./sql/resilience.js";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { integer } from "../properties/factories.js";
import type { SqlExecutor } from "./sql/SqlBackend.js";

const connErr = () => Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
const noSleep = async () => {};

describe("resilientExecutor", () => {
  it("retries a failing read and succeeds, backing off between attempts", async () => {
    let calls = 0;
    const delays: number[] = [];
    const inner: SqlExecutor = {
      run: async () => {
        if (++calls < 3) throw connErr();
        return [{ v: 1 }];
      }
    };
    const exec = resilientExecutor(inner, { sleep: noSleep, onRetry: (i) => delays.push(i.delayMs) });

    expect(await exec.run("SELECT 1", [])).toEqual([{ v: 1 }]);
    expect(calls).toBe(3); // two failures, then success
    expect(delays).toEqual([50, 100]); // exponential backoff (50, then ×2)
  });

  it("does not retry a write (a retry could double-apply it)", async () => {
    let calls = 0;
    const inner: SqlExecutor = {
      run: async () => {
        calls++;
        throw connErr();
      }
    };
    const err = await resilientExecutor(inner, { sleep: noSleep }).run("INSERT INTO t VALUES (1)", []).catch((e) => e);
    expect(err.code).toBe("ECONNRESET");
    expect(calls).toBe(1); // no retry
  });

  it("retries the whole transaction as one atomic unit", async () => {
    let attempts = 0;
    const inner: SqlExecutor = {
      run: async () => [],
      transaction: async (fn) => {
        if (++attempts < 2) throw connErr();
        return fn({ run: async () => [] });
      }
    };
    const exec = resilientExecutor(inner, { sleep: noSleep });
    expect(await exec.transaction!(async () => "ok")).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("gives up after `retries` attempts and throws the last error", async () => {
    let calls = 0;
    const inner: SqlExecutor = {
      run: async () => {
        calls++;
        throw connErr();
      }
    };
    await expect(resilientExecutor(inner, { retries: 2, sleep: noSleep }).run("SELECT 1", [])).rejects.toThrow(/connection reset/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    const inner: SqlExecutor = {
      run: async () => {
        calls++;
        throw Object.assign(new Error("duplicate key"), { code: "23505" }); // Postgres unique_violation
      }
    };
    await expect(resilientExecutor(inner, { sleep: noSleep }).run("SELECT 1", [])).rejects.toThrow(/duplicate key/);
    expect(calls).toBe(1);
  });

  it("times out a slow call, and the timeout is itself retryable", async () => {
    let starts = 0;
    let retried = 0;
    const inner: SqlExecutor = {
      run: () => {
        starts++;
        return new Promise(() => {}); // never resolves
      }
    };
    const exec = resilientExecutor(inner, { timeoutMs: 10, retries: 1, sleep: noSleep, onRetry: () => retried++ });
    await expect(exec.run("SELECT 1", [])).rejects.toBeInstanceOf(TimeoutError);
    expect(starts).toBe(2); // first attempt + one retry, both timed out
    expect(retried).toBe(1);
  });

  it("caps the backoff at maxBackoffMs", async () => {
    const delays: number[] = [];
    const inner: SqlExecutor = {
      run: async () => {
        throw connErr();
      }
    };
    await resilientExecutor(inner, {
      retries: 5,
      backoffMs: 100,
      backoffFactor: 3,
      maxBackoffMs: 500,
      sleep: noSleep,
      onRetry: (i) => delays.push(i.delayMs)
    })
      .run("SELECT 1", [])
      .catch(() => {});
    expect(delays).toEqual([100, 300, 500, 500, 500]); // 100, 300, 900→cap, ...
  });

  it("exposes no transaction method when the inner executor has none", () => {
    expect(resilientExecutor({ run: async () => [] }).transaction).toBeUndefined();
  });

  it("uses a real backoff delay when no sleep is injected", async () => {
    let calls = 0;
    const inner: SqlExecutor = {
      run: async () => {
        if (++calls < 2) throw connErr();
        return [{ v: 1 }];
      }
    };
    // no `sleep` override → the default setTimeout-based delay runs (backoff kept tiny)
    expect(await resilientExecutor(inner, { backoffMs: 1 }).run("SELECT 1", [])).toEqual([{ v: 1 }]);
    expect(calls).toBe(2);
  });
});

describe("resilience end to end (PostgresBackend)", () => {
  it("recovers from a transient read failure against pg-mem", async () => {
    const pool = new (newDb().adapters.createPg().Pool)();
    let failed = false;
    const flaky = {
      query: (sql: string, params: unknown[]) => {
        if (/FROM "flaky"/.test(sql) && !failed) {
          failed = true;
          return Promise.reject(connErr()); // drop the first real read
        }
        return pool.query(sql, params);
      }
    };
    const orm = new RepositoryManager({ backend: new PostgresBackend(flaky, { sleep: noSleep }) });
    const rows_ = orm.define({ name: "flaky", properties: { n: integer() } });
    await orm.transaction(async () => rows_.save(rows_.createInstance({ n: 1 })));

    expect(await rows_.all().list()).toHaveLength(1); // first SELECT threw, retried, succeeded
    expect(failed).toBe(true);
  });
});
