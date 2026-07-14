/**
 * Compile-unit tests for the window (`OVER (…)`) push-down. Verifies the emitted SQL for the columnar
 * dialects and the null fallbacks (a partition/order key that isn't a real column → scan in memory).
 * End-to-end behavior against real engines is covered in window.test.ts (SQLite) + a live-Postgres run.
 */
import { describe, it, expect } from "vitest";
import { compileWindow } from "./sql/compile.js";
import { postgresDialect as PG } from "./sql/dialect.js";
import { field } from "../expressions/values.js";
import type { WindowPlan } from "../core/QueryPlan.js";

const COLS = new Map([
  ["user", "text"],
  ["amount", "integer"]
]);

const plan = (over: Partial<WindowPlan>): WindowPlan => ({
  model: "pay",
  where: { type: "all" },
  partitionBy: [],
  order: [],
  functions: [{ name: "r", kind: "rank" }],
  ...over
});

describe("compileWindow (OVER clause)", () => {
  it("PARTITION BY + ORDER BY over real columns", () => {
    const out = compileWindow(
      plan({
        partitionBy: [field("user").serialize()],
        order: [{ property: "amount", descending: false }],
        functions: [
          { name: "n", kind: "rowNumber" },
          { name: "r", kind: "rank" },
          { name: "dr", kind: "denseRank" }
        ]
      }),
      PG,
      COLS
    );
    expect(out).toEqual({
      columns:
        `ROW_NUMBER() OVER (PARTITION BY "user" ORDER BY "amount" ASC NULLS FIRST) AS w0, ` +
        `RANK() OVER (PARTITION BY "user" ORDER BY "amount" ASC NULLS FIRST) AS w1, ` +
        `DENSE_RANK() OVER (PARTITION BY "user" ORDER BY "amount" ASC NULLS FIRST) AS w2`,
      params: []
    });
  });

  it("descending order + no partition ranks the whole set", () => {
    const out = compileWindow(plan({ order: [{ property: "amount", descending: true }] }), PG, COLS);
    expect(out).toEqual({ columns: `RANK() OVER (ORDER BY "amount" DESC NULLS LAST) AS w0`, params: [] });
  });

  it("falls back (null) when the order key isn't a real column", () => {
    expect(compileWindow(plan({ order: [{ property: "meta.score", descending: false }] }), PG, COLS)).toBeNull();
    expect(compileWindow(plan({ order: [{ property: "undeclared", descending: false }] }), PG, COLS)).toBeNull();
  });

  it("falls back (null) when a partition key can't push down (a computed/nested value)", () => {
    expect(compileWindow(plan({ partitionBy: [field("meta.tier").serialize()] }), PG, COLS)).toBeNull();
  });
});
