/**
 * Compile-only tests for nested-path push-down: a dotted filter into an embedded object (in the
 * `_extra` overflow) compiles to a type-exact JSON extraction. Only equality/`$in` of a scalar over an
 * *undeclared* head pushes down (that's what the in-memory reference's `getPath` traverses); a declared
 * column, a comparison, `nin`, a null value, or an unknown schema all scan-fallback. Behavior against
 * real Postgres/MySQL — the only place this SQL runs — is verified in `sqlIntegration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { compileWhere } from "./sql/compile.js";
import { postgresDialect as PG, mysqlDialect as MY } from "./sql/dialect.js";
import { eq, gt, and, inList, notInList } from "../expressions/index.js";
import type { Expression } from "../expressions/index.js";

// declared columns; "address"/"meta"/"flags" are NOT here → they live in the _extra overflow
const COLS = new Map([
  ["name", "text"],
  ["age", "integer"]
]);
const w = (expr: Expression, d: typeof PG | typeof MY, cols: ReadonlyMap<string, string> | undefined = COLS) =>
  compileWhere(expr.serialize(), d, cols);

describe("nested-path push-down (JSON extraction over _extra)", () => {
  it("equality on an undeclared nested path, type-exact", () => {
    expect(w(eq("address.city", "NYC"), PG)).toEqual({ sql: `("_extra"::jsonb #> '{address,city}') = ?::jsonb`, params: ['"NYC"'] });
    expect(w(eq("meta.level", 2), PG)).toEqual({ sql: `("_extra"::jsonb #> '{meta,level}') = ?::jsonb`, params: ["2"] });
    expect(w(eq("flags.active", true), PG)).toEqual({ sql: `("_extra"::jsonb #> '{flags,active}') = ?::jsonb`, params: ["true"] });
    expect(w(eq("address.city", "NYC"), MY)).toEqual({ sql: "JSON_EXTRACT(`_extra`, '$.address.city') = CAST(? AS JSON)", params: ['"NYC"'] });
  });

  it("$in on an undeclared nested path", () => {
    expect(w(inList("meta.tier", ["gold", "plat"]), PG)).toEqual({
      sql: `("_extra"::jsonb #> '{meta,tier}') IN (?::jsonb, ?::jsonb)`,
      params: ['"gold"', '"plat"']
    });
    expect(w(inList("meta.tier", ["gold"]), MY)).toEqual({ sql: "JSON_EXTRACT(`_extra`, '$.meta.tier') IN (CAST(? AS JSON))", params: ['"gold"'] });
  });

  it("composes inside AND with a top-level column", () => {
    expect(w(and(gt("age", 20), eq("address.city", "NYC")), PG)).toEqual({
      sql: `("age" > ? AND ("_extra"::jsonb #> '{address,city}') = ?::jsonb)`,
      params: [20, '"NYC"']
    });
  });

  it("scan-fallback for everything the JSON path can't match exactly", () => {
    expect(w(gt("address.age", 30), PG)).toBeNull(); // a comparator other than = → scan
    expect(w(notInList("meta.tier", ["x"]), PG)).toBeNull(); // nin also matches a missing field → scan
    expect(w(eq("name.first", "x"), PG)).toBeNull(); // head is a declared (opaque) column → scan
    expect(w(eq("a.b", null as never), PG)).toBeNull(); // null isn't a JSON scalar we push → scan
    expect(w(eq("a.b!c.x" as string, "x"), PG)).toBeNull(); // non-identifier segment → scan
    expect(compileWhere(eq("address.city", "x").serialize(), PG, undefined)).toBeNull(); // schema unknown → scan
  });
});
