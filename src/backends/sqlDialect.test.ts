/**
 * Compile-only tests for the columnar Postgres / MySQL dialects — they assert the exact SQL the
 * compiler emits (no database needed), the way the Mongo tests assert `compileMongoFilter`. This is
 * the primary regression net for MySQL (which has no in-process engine to run against here) and the
 * fine-grained check for Postgres alongside the pg-mem behavioral test. Fields are real columns now,
 * so filters/values are plain column references — no JSON extraction or casts.
 */
import { describe, it, expect } from "vitest";
import { compileWhere, compileValue, compileAggregate } from "./sql/compile.js";
import { postgresDialect as PG, mysqlDialect as MY } from "./sql/dialect.js";
import { eq, gt, inList, notInList, between, and, or, not, exists, size, startsWith, field, mul } from "../expressions/index.js";
import type { AggregatePlan } from "../core/QueryPlan.js";

const w = (expr: { serialize: () => import("../core/QueryPlan.js").ExpressionNode }, d: typeof PG | typeof MY) =>
  compileWhere(expr.serialize(), d);

describe("SQL dialect compilation (columnar)", () => {
  it("comparisons reference real columns (quoted per dialect)", () => {
    expect(w(gt("age", 30), PG)).toEqual({ sql: `"age" > ?`, params: [30] });
    expect(w(eq("name", "Ann"), PG)).toEqual({ sql: `"name" = ?`, params: ["Ann"] });
    expect(w(gt("age", 30), MY)).toEqual({ sql: "`age` > ?", params: [30] });
    expect(w(eq("name", "Ann"), MY)).toEqual({ sql: "`name` = ?", params: ["Ann"] });
  });

  it("in / nin (nin also matches a missing field)", () => {
    expect(w(inList("age", [1, 2]), PG)).toEqual({ sql: `"age" IN (?, ?)`, params: [1, 2] });
    expect(w(notInList("role", ["admin"]), PG)).toEqual({
      sql: `("role" IS NULL OR "role" NOT IN (?))`,
      params: ["admin"]
    });
  });

  it("between, and/or/not compose", () => {
    expect(w(between("age", 18, 65), PG)).toEqual({ sql: `"age" BETWEEN ? AND ?`, params: [18, 65] });
    expect(w(and(gt("age", 18), eq("city", "eu")), PG)).toEqual({ sql: `("age" > ? AND "city" = ?)`, params: [18, "eu"] });
    expect(w(or(eq("a", "x"), eq("b", "y")), PG)!.sql).toBe(`("a" = ? OR "b" = ?)`);
    expect(w(not(gt("age", 5)), PG)!.sql).toBe(`NOT ("age" > ?)`);
  });

  it("computed expr filter (price * qty > 100) — numeric literals inline, operands null-coerced", () => {
    // operands are COALESCE'd to 0 so a null field matches the in-memory reference (`num()`), not NULL.
    expect(w(gt(mul(field("price"), field("qty")), 100), PG)).toEqual({
      sql: `((COALESCE("price", 0) * COALESCE("qty", 0)) > 100)`,
      params: []
    });
    expect(w(gt(mul(field("price"), field("qty")), 100), MY)!.sql).toBe(
      "((COALESCE(`price`, 0) * COALESCE(`qty`, 0)) > 100)"
    );
  });

  it("ops without push-down yet return null (backend scans instead)", () => {
    expect(w(exists("x"), PG)).toBeNull();
    expect(w(size("tags", 2), PG)).toBeNull();
    expect(w(startsWith("title", "A"), PG)).toBeNull();
    expect(w(exists("x"), MY)).toBeNull();
  });

  it("aggregate compiles to GROUP BY with COALESCE'd reductions over columns", () => {
    const plan: AggregatePlan = {
      model: "Sale",
      where: { type: "all" },
      groupBy: [{ type: "field", path: "region" }],
      aggregates: [
        { name: "n", op: "count" },
        { name: "total", op: "sum", value: { type: "field", path: "amount" } }
      ]
    };
    expect(compileAggregate(plan, PG)).toEqual({
      columns: `"region" AS g0, COUNT(*) AS a0, COALESCE(SUM("amount"), 0) AS a1`,
      groupBy: ` GROUP BY "region"`,
      params: [],
      groupParams: []
    });
  });

  it("finalize renumbers placeholders for Postgres, leaves MySQL positional", () => {
    expect(PG.finalize("a = ? AND b = ?")).toBe("a = $1 AND b = $2");
    expect(MY.finalize("a = ? AND b = ?")).toBe("a = ? AND b = ?");
  });

  it("value expressions: coalesce / neg / concat / vand / switch", () => {
    expect(compileValue({ type: "coalesce", operands: [{ type: "field", path: "a" }, { type: "lit", value: 0 }] }, PG)).toEqual({
      sql: `COALESCE("a", 0)`,
      params: []
    });
    expect(compileValue({ type: "neg", operand: { type: "field", path: "a" } }, PG)).toEqual({ sql: `(-COALESCE("a", 0))`, params: [] });

    const concat = { type: "concat" as const, operands: [{ type: "field" as const, path: "a" }, { type: "lit" as const, value: "!" }] };
    expect(compileValue(concat, PG)).toEqual({ sql: `(COALESCE("a", '') || COALESCE(?, ''))`, params: ["!"] });
    expect(compileValue(concat, MY)).toEqual({ sql: "CONCAT(COALESCE(`a`, ''), COALESCE(?, ''))", params: ["!"] });

    const vand = {
      type: "vand" as const,
      operands: [
        { type: "vcompare" as const, op: ">" as const, left: { type: "field" as const, path: "a" }, right: { type: "lit" as const, value: 1 } },
        { type: "vnot" as const, operand: { type: "vor" as const, operands: [] } }
      ]
    };
    expect(compileValue(vand, PG)).toEqual({ sql: `(("a" > 1) AND (NOT FALSE))`, params: [] });

    const sw = {
      type: "switch" as const,
      branches: [{ when: { type: "vcompare" as const, op: "=" as const, left: { type: "field" as const, path: "t" }, right: { type: "lit" as const, value: "a" } }, then: { type: "lit" as const, value: 1 } }],
      otherwise: { type: "lit" as const, value: 0 }
    };
    expect(compileValue(sw, PG)).toEqual({ sql: `CASE WHEN ("t" = ?) THEN 1 ELSE 0 END`, params: ["a"] });
  });

  it("returns null for value ops it can't emit (date parts), so the backend scans", () => {
    expect(compileValue({ type: "datepart", part: "year", operand: { type: "field", path: "ts" } }, PG)).toBeNull();
    expect(compileValue({ type: "datestring", format: "%Y", operand: { type: "field", path: "ts" } }, MY)).toBeNull();
  });

  it("filter edge cases fall back (dotted path, mixed-type IN, boolean compare)", () => {
    expect(w(eq("a.b", "x"), PG)).toBeNull(); // nested path → scan
    expect(compileWhere({ type: "in", property: "x", values: [1, "a"] }, PG)).toBeNull(); // mixed types
    expect(compileWhere({ type: "compare", property: "active", comparator: "=", value: true }, PG)).toBeNull(); // boolean
    expect(compileWhere({ type: "in", property: "x", values: [] }, PG)).toEqual({ sql: "0=1", params: [] });
    expect(compileWhere({ type: "nin", property: "x", values: [] }, PG)).toEqual({ sql: "1=1", params: [] });
  });

  it("maps stored-type tags to column types, and builds columnar DDL", () => {
    expect(PG.columnType("integer")).toBe("bigint");
    expect(PG.columnType("boolean")).toBe("boolean");
    expect(PG.columnType("date")).toBe("bigint");
    expect(MY.columnType("text")).toBe("text"); // real TEXT column — no varchar(255) truncation
    expect(MY.columnType("boolean")).toBe("tinyint(1)");

    const create = PG.createTable("Song", [
      { name: "title", type: "text" },
      { name: "plays", type: "integer" }
    ]);
    expect(create).toBe(
      `CREATE TABLE IF NOT EXISTS "Song" ("uuid" text PRIMARY KEY, "title" text, "plays" bigint, "_extra" text)`
    );
    expect(PG.upsert("Song", ["uuid", "title", "_extra"])).toBe(
      `INSERT INTO "Song" ("uuid", "title", "_extra") VALUES ($1, $2, $3) ON CONFLICT (uuid) DO UPDATE SET "title" = excluded."title", "_extra" = excluded."_extra"`
    );
    expect(MY.upsert("Song", ["uuid", "title"])).toBe(
      "INSERT INTO `Song` (`uuid`, `title`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `title` = VALUES(`title`)"
    );
    expect(PG.createIndex("Song", "by_title", ["title"], true)).toBe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "by_title" ON "Song" ("title")`
    );

    // MySQL DDL + batched statements
    const myCreate = MY.createTable("Song", [
      { name: "title", type: "text" },
      { name: "plays", type: "integer" }
    ]);
    expect(myCreate).toContain("`uuid` varchar(64) PRIMARY KEY"); // uuid PK stays varchar (indexable), not TEXT
    expect(myCreate).toContain("`title` text"); // real TEXT column, no truncation
    // Without column types, columns index whole; with them, a TEXT-backed column gets a (255) prefix.
    expect(MY.createIndex("Song", "by_title", ["title"], false)).toBe("CREATE INDEX `by_title` ON `Song` (`title`)");
    expect(MY.createIndex("Song", "by_title", ["title"], false, new Map([["title", "text"]]))).toBe(
      "CREATE INDEX `by_title` ON `Song` (`title`(255))"
    );
    // a compound index prefixes only the TEXT column, not the numeric one
    expect(MY.createIndex("Song", "ti_pl", ["title", "plays"], true, new Map([["title", "text"], ["plays", "integer"]]))).toBe(
      "CREATE UNIQUE INDEX `ti_pl` ON `Song` (`title`(255), `plays`)"
    );
    expect(MY.upsertMany("Song", ["uuid", "title"], 2)).toBe(
      "INSERT INTO `Song` (`uuid`, `title`) VALUES (?, ?), (?, ?) ON DUPLICATE KEY UPDATE `title` = VALUES(`title`)"
    );
    expect(MY.deleteMany("Song", 2)).toBe("DELETE FROM `Song` WHERE uuid IN (?, ?)");
    // Postgres multi-row upsert numbers placeholders across every tuple
    expect(PG.upsertMany("Song", ["uuid", "title"], 2)).toBe(
      `INSERT INTO "Song" ("uuid", "title") VALUES ($1, $2), ($3, $4) ON CONFLICT (uuid) DO UPDATE SET "title" = excluded."title"`
    );
  });

  it("upsertMany's optional updateColumns restricts the DO UPDATE / ON DUPLICATE KEY set (dirty-field tracking)", () => {
    // The VALUES/insert side always carries every column — only the update clause narrows.
    expect(PG.upsertMany("Song", ["uuid", "title", "plays", "_extra"], 1, ["plays"])).toBe(
      `INSERT INTO "Song" ("uuid", "title", "plays", "_extra") VALUES ($1, $2, $3, $4) ON CONFLICT (uuid) DO UPDATE SET "plays" = excluded."plays"`
    );
    expect(MY.upsertMany("Song", ["uuid", "title", "plays"], 1, ["plays"])).toBe(
      "INSERT INTO `Song` (`uuid`, `title`, `plays`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `plays` = VALUES(`plays`)"
    );
    // Multiple restricted columns, still one shared multi-row statement.
    expect(PG.upsertMany("Song", ["uuid", "title", "plays"], 2, ["title", "plays"])).toBe(
      `INSERT INTO "Song" ("uuid", "title", "plays") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT (uuid) DO UPDATE SET "title" = excluded."title", "plays" = excluded."plays"`
    );
  });

  it("paging clauses differ (Postgres bare OFFSET, MySQL max-LIMIT OFFSET)", () => {
    expect(PG.paging(10, 5)).toBe(" LIMIT 10 OFFSET 5");
    expect(PG.paging(null, 5)).toBe(" OFFSET 5");
    expect(PG.paging(null, 0)).toBe("");
    expect(MY.paging(10, 5)).toBe(" LIMIT 10 OFFSET 5");
    expect(MY.paging(null, 5)).toBe(" LIMIT 18446744073709551615 OFFSET 5");
    expect(MY.paging(null, 0)).toBe("");
  });
});
