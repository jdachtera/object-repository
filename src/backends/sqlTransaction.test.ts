/**
 * Transaction wiring for the SQL backends. pg-mem accepts BEGIN/COMMIT/ROLLBACK but doesn't actually
 * revert on rollback (emulator limitation), so the rollback path is verified against a capturing pg
 * client that asserts the exact statement sequence; the commit path is also checked behaviorally on
 * pg-mem elsewhere.
 */
import { describe, it, expect } from "vitest";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { MySqlBackend } from "./sql/MySqlBackend.js";
import { SqlBackend } from "./sql/SqlBackend.js";
import { postgresDialect } from "./sql/dialect.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { FieldSpec } from "../core/Backend.js";

const ctx = SYSTEM_CONTEXT;
const FIELDS: FieldSpec[] = [{ name: "n", type: "integer" }];

/** A `pg`-shaped client/pool that records the statement verbs and can be told to fail an INSERT. */
class FakePg {
  log: string[] = [];
  failInsert = false;
  private verb(sql: string): string {
    return sql.split(/\s|\(/)[0]!.toUpperCase();
  }
  async query(sql: string, _params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const verb = this.verb(sql);
    this.log.push(verb);
    if (this.failInsert && verb === "INSERT") throw new Error("duplicate key");
    return { rows: [] };
  }
  async connect() {
    return { query: this.query.bind(this), release: () => this.log.push("RELEASE") };
  }
}

describe("SQL transactions", () => {
  it("advertises the transaction capability when the executor supports it", () => {
    expect(new PostgresBackend(new FakePg()).capabilities.transactions).toBe(true);
  });

  it("wraps a persist batch in BEGIN … COMMIT on a checked-out connection", async () => {
    const pg = new FakePg();
    const be = new PostgresBackend(pg);
    await be.registerModel("T", [], FIELDS); // DDL + migration happen at register time, outside the tx
    pg.log.length = 0;
    be.save("T", { uuid: "a", n: 1 }, ctx);
    be.save("T", { uuid: "b", n: 2 }, ctx);
    await be.persist(ctx);

    // both rows go in ONE multi-row INSERT, wrapped in BEGIN … COMMIT, then the connection is released
    expect(pg.log).toEqual(["BEGIN", "INSERT", "COMMIT", "RELEASE"]);
  });

  it("rolls back and re-throws when a write in the batch fails", async () => {
    const pg = new FakePg();
    const be = new PostgresBackend(pg);
    await be.registerModel("T", [], FIELDS);
    pg.log.length = 0;
    pg.failInsert = true;
    be.save("T", { uuid: "a", n: 1 }, ctx);

    await expect(be.persist(ctx)).rejects.toThrow(/duplicate key/);
    expect(pg.log).toEqual(["BEGIN", "INSERT", "ROLLBACK", "RELEASE"]); // no COMMIT
  });

  it("an executor without a transaction hook degrades to a batch flush (no BEGIN)", async () => {
    // A bare SqlExecutor (no `transaction`) — the interactive scope can't isolate, so `transaction`
    // just runs the callback and flushes the queue once, with no BEGIN/COMMIT wrapping.
    class BareExec {
      calls: string[] = [];
      async run(sql: string): Promise<Record<string, unknown>[]> {
        if (sql.includes("information_schema")) return []; // table absent → CREATE at register time
        this.calls.push(sql.split(/\s|\(/)[0]!.toUpperCase());
        return [];
      }
    }
    const exec = new BareExec();
    const be = new SqlBackend(postgresDialect, exec);
    expect(be.capabilities.transactions).toBe(false);
    await be.registerModel("T", [], FIELDS);
    exec.calls.length = 0;

    const result = await be.transaction(async (tx) => {
      tx.save("T", { uuid: "a", n: 1 }, ctx);
      await tx.persist(ctx);
      return "ok";
    }, ctx);

    expect(result).toBe("ok");
    expect(exec.calls).toContain("INSERT");
    expect(exec.calls).not.toContain("BEGIN");
  });

  it("MySQL uses the driver's beginTransaction / commit (and rollback on failure)", async () => {
    // A mysql2-style pool: getConnection() → a connection with begin/commit/rollback methods.
    class FakeMySqlPool {
      log: string[] = [];
      failInsert = false;
      async query(sql: string): Promise<[Record<string, unknown>[], unknown]> {
        const verb = sql.split(/\s|\(/)[0]!.toUpperCase();
        this.log.push(verb);
        if (this.failInsert && verb === "INSERT") throw new Error("mysql dup");
        return [[], []];
      }
      async getConnection() {
        const self = this;
        return {
          query: (sql: string) => self.query(sql),
          beginTransaction: async () => void self.log.push("BEGIN"),
          commit: async () => void self.log.push("COMMIT"),
          rollback: async () => void self.log.push("ROLLBACK"),
          release: () => self.log.push("RELEASE")
        };
      }
    }
    const pool = new FakeMySqlPool();
    const be = new MySqlBackend(pool as never);
    expect(be.capabilities.transactions).toBe(true);
    await be.registerModel("T", [], FIELDS);
    pool.log.length = 0;
    be.save("T", { uuid: "a", n: 1 }, ctx);
    await be.persist(ctx);
    expect(pool.log).toEqual(["BEGIN", "INSERT", "COMMIT", "RELEASE"]);

    pool.log.length = 0;
    pool.failInsert = true;
    be.save("T", { uuid: "b", n: 2 }, ctx);
    await expect(be.persist(ctx)).rejects.toThrow(/mysql dup/);
    expect(pool.log).toEqual(["BEGIN", "INSERT", "ROLLBACK", "RELEASE"]);
  });
});
