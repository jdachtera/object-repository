/**
 * MySQL backend tests. There's no in-process MySQL engine to run against here, so this drives the
 * backend through a capturing fake connection and asserts the exact SQL it emits — the columnar
 * dialect: backtick identifiers, one typed column per scalar field plus a `_extra` JSON overflow
 * column, `ON DUPLICATE KEY UPDATE`, positional `?`. Read/aggregate *semantics* over the same
 * `SqlBackend` code are covered behaviorally by the pg-mem Postgres suite.
 */
import { describe, it, expect } from "vitest";
import { MySqlBackend } from "./sql/MySqlBackend.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { gt } from "../expressions/index.js";
import type { AggregatePlan, QueryPlan } from "../core/QueryPlan.js";
import type { FieldSpec } from "../core/Backend.js";

const ctx = SYSTEM_CONTEXT;

class FakeConn {
  calls: Array<{ sql: string; params: unknown[] }> = [];
  rows: Record<string, unknown>[] = [];
  async query(sql: string, params: unknown[]): Promise<[Record<string, unknown>[], unknown]> {
    this.calls.push({ sql, params });
    return [this.rows, []];
  }
  find(prefix: string) {
    return this.calls.find((c) => c.sql.startsWith(prefix))!;
  }
  last() {
    return this.calls[this.calls.length - 1]!;
  }
}

const USER_FIELDS: FieldSpec[] = [
  { name: "name", type: "text" },
  { name: "age", type: "integer" }
];

describe("MySqlBackend emits columnar MySQL SQL and adapts the driver shape", () => {
  it("registerModel builds a typed table + overflow column; persist writes every column", async () => {
    const conn = new FakeConn();
    const be = new MySqlBackend(conn);
    await be.registerModel("Users", [], USER_FIELDS);

    expect(conn.find("CREATE").sql).toBe(
      "CREATE TABLE IF NOT EXISTS `Users` (`uuid` varchar(64) PRIMARY KEY, `name` text, `age` bigint, `_extra` longtext) COLLATE=utf8mb4_bin"
    );

    be.save("Users", { uuid: "u1", name: "Ann", age: 30 }, ctx);
    await be.persist(ctx);
    const insert = conn.find("INSERT");
    expect(insert.sql).toBe(
      "INSERT INTO `Users` (`uuid`, `name`, `age`, `_extra`) VALUES (?, ?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `age` = VALUES(`age`), `_extra` = VALUES(`_extra`)"
    );
    expect(insert.params).toEqual(["u1", "Ann", 30, null]); // no extra fields → overflow is NULL
  });

  it("query pushes filter / order / paging down to columns and decodes rows", async () => {
    const conn = new FakeConn();
    const be = new MySqlBackend(conn);
    await be.registerModel("Users", [], USER_FIELDS);
    conn.rows = [{ uuid: "u1", name: "Ann", age: 30, _extra: null }];
    const plan: QueryPlan = {
      model: "Users",
      where: gt("age", 25).serialize(),
      order: [{ property: "age", descending: false }],
      paging: { start: 0, end: 10 }
    };
    const res = await be.query(plan, ctx);

    expect(conn.last().sql).toBe("SELECT * FROM `Users` WHERE `age` > ? ORDER BY `age` ASC LIMIT 10 OFFSET 0");
    expect(conn.last().params).toEqual([25]);
    expect(res).toEqual([{ uuid: "u1", name: "Ann", age: 30 }]); // age decoded back to a number
  });

  it("count → SELECT COUNT(*)", async () => {
    const conn = new FakeConn();
    const be = new MySqlBackend(conn);
    await be.registerModel("Users", [], USER_FIELDS);
    conn.rows = [{ n: 2 }];
    expect(await be.count({ model: "Users", where: gt("age", 25).serialize(), order: [], paging: { start: 0 } }, ctx)).toBe(2);
    expect(conn.last().sql).toContain("SELECT COUNT(*) AS n FROM `Users` WHERE");
  });

  it("aggregate → GROUP BY on the real column, results mapped by name", async () => {
    const conn = new FakeConn();
    const be = new MySqlBackend(conn);
    await be.registerModel("Sales", [], [{ name: "region", type: "text" }, { name: "amount", type: "integer" }]);
    conn.rows = [{ g0: "eu", a0: 2, a1: 40 }];
    const plan: AggregatePlan = {
      model: "Sales",
      where: { type: "all" },
      groupBy: [{ type: "field", path: "region" }],
      aggregates: [
        { name: "n", op: "count" },
        { name: "total", op: "sum", value: { type: "field", path: "amount" } }
      ]
    };
    const rows = await be.aggregate(plan, ctx);
    expect(conn.last().sql).toContain("GROUP BY `region`");
    expect(conn.last().sql).toContain("COALESCE(SUM(`amount`), 0)");
    expect(rows).toEqual([{ key: ["eu"], values: { n: 2, total: 40 } }]);
  });

  it("remove → DELETE by uuid", async () => {
    const conn = new FakeConn();
    const be = new MySqlBackend(conn);
    await be.registerModel("Users", [], USER_FIELDS);
    be.remove("Users", { uuid: "u1" }, ctx);
    await be.persist(ctx);
    const del = conn.find("DELETE");
    expect(del.sql).toBe("DELETE FROM `Users` WHERE uuid IN (?)");
    expect(del.params).toEqual(["u1"]);
  });

  it("stores fields with no declared column in the JSON overflow", async () => {
    const conn = new FakeConn();
    const be = new MySqlBackend(conn);
    await be.registerModel("Users", [], USER_FIELDS);
    be.save("Users", { uuid: "u2", name: "Bo", age: 40, subscription: { plan: "pro" } }, ctx);
    await be.persist(ctx);
    const insert = conn.find("INSERT");
    expect(insert.params).toEqual(["u2", "Bo", 40, JSON.stringify({ subscription: { plan: "pro" } })]);
  });
});
