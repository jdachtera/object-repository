/**
 * Text-search push-down for the columnar SQL backends. Case-sensitive `startsWith`/`endsWith`/
 * `includesText` over a real text column compile to `LIKE` (`LIKE BINARY` on MySQL); case-insensitive,
 * non-text-column, and metacharacter searches stay on the scan path so results still match the
 * in-memory reference exactly. The compiler decisions are asserted directly; parity + actual push-down
 * are verified behaviorally on pg-mem.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { compileWhere } from "./sql/compile.js";
import { postgresDialect as PG, mysqlDialect as MY } from "./sql/dialect.js";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { startsWith, endsWith, includesText, eq, and } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Expression } from "../expressions/index.js";
import type { QueryPlan } from "../core/QueryPlan.js";
import type { FieldSpec } from "../core/Backend.js";

const ctx = SYSTEM_CONTEXT;
const TEXT = new Map([["title", "text"]]); // the model's columns (name → stored type)
const c = (expr: Expression, d: typeof PG | typeof MY, cols?: ReadonlyMap<string, string>) => compileWhere(expr.serialize(), d, cols);

describe("text-search compilation to LIKE", () => {
  it("case-sensitive prefix/suffix/substring over a text column push down", () => {
    expect(c(startsWith("title", "Pre"), PG, TEXT)).toEqual({ sql: `"title" LIKE ?`, params: ["Pre%"] });
    expect(c(endsWith("title", "ee"), PG, TEXT)).toEqual({ sql: `"title" LIKE ?`, params: ["%ee"] });
    expect(c(includesText("title", "am"), PG, TEXT)).toEqual({ sql: `"title" LIKE ?`, params: ["%am%"] });
    // MySQL forces case sensitivity with LIKE BINARY
    expect(c(includesText("title", "am"), MY, TEXT)).toEqual({ sql: "`title` LIKE BINARY ?", params: ["%am%"] });
  });

  it("composes inside AND with a column comparison", () => {
    expect(c(and(eq("title", "x"), startsWith("title", "Pre")), PG, TEXT)).toEqual({
      sql: `("title" = ? AND "title" LIKE ?)`,
      params: ["x", "Pre%"]
    });
  });

  it("falls back to scan for the cases LIKE can't match exactly", () => {
    expect(c(startsWith("title", "Pre", { caseInsensitive: true }), PG, TEXT)).toBeNull(); // ASCII-only insensitive
    expect(c(startsWith("name", "Pre"), PG, TEXT)).toBeNull(); // not a declared text column
    expect(c(includesText("title", "50%"), PG, TEXT)).toBeNull(); // literal % — would need ESCAPE
    expect(c(startsWith("title", "a_b"), PG, TEXT)).toBeNull(); // literal _
    expect(c(startsWith("title", "Pre"), PG)).toBeNull(); // schema unknown → don't risk it
  });
});

/** A pg client that records the SQL it runs, so we can prove a query pushed down vs scanned. */
class SpyPg {
  readonly sql: string[] = [];
  constructor(private readonly pool: { query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) {}
  async query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.sql.push(sql);
    return this.pool.query(sql, params);
  }
}

const SONGS = [
  { uuid: "s1", title: "Für Elise" },
  { uuid: "s2", title: "fur trader blues" },
  { uuid: "s3", title: "Prelude in C" },
  { uuid: "s4", title: "C-JAM blues" }
];
const TITLE_FIELDS: FieldSpec[] = [{ name: "title", type: "text" }];
const query = (where: Expression): QueryPlan => ({ model: "Song", where: where.serialize(), order: [], paging: { start: 0 } });

async function seeded() {
  const spy = new SpyPg(new (newDb().adapters.createPg().Pool)());
  const be = new PostgresBackend(spy);
  await be.registerModel("Song", [], TITLE_FIELDS);
  for (const song of SONGS) be.save("Song", song, ctx);
  await be.persist(ctx);
  spy.sql.length = 0;
  return { be, spy };
}

describe("text-search parity on pg-mem (push-down matches the reference)", () => {
  it("pushes case-sensitive matches into a LIKE and returns the same rows as scan", async () => {
    const { be, spy } = await seeded();
    const ids = async (w: Expression) => (await be.query(query(w), ctx)).map((r) => String(r.uuid)).sort();

    expect(await ids(includesText("title", "blues"))).toEqual(["s2", "s4"]);
    expect(await ids(startsWith("title", "Prelude"))).toEqual(["s3"]);
    expect(await ids(endsWith("title", "blues"))).toEqual(["s2", "s4"]);
    expect(await ids(includesText("title", "jam"))).toEqual([]); // case-sensitive: no lowercase "jam"
    expect(spy.sql.every((s) => s.includes("LIKE"))).toBe(true); // every one of the above pushed down
  });

  it("scans (still correct) for case-insensitive and non-ASCII cases", async () => {
    const { be, spy } = await seeded();
    // ASCII case-insensitive folds only ASCII letters — "JAM" matches, "Für" is never matched by "fur"
    expect((await be.query(query(includesText("title", "JAM", { caseInsensitive: true })), ctx)).map((r) => r.uuid)).toEqual(["s4"]);
    expect((await be.query(query(includesText("title", "fur", { caseInsensitive: true })), ctx)).map((r) => r.uuid)).toEqual(["s2"]);
    expect(spy.sql.every((s) => !s.includes("LIKE"))).toBe(true); // neither pushed down — both scanned
  });
});
