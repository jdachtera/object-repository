/**
 * Portable SQL compiler for the columnar Postgres / MySQL backends (ARCHITECTURE.md §3, §11).
 *
 * Walks the serialized `ExpressionNode` / `ValueNode` AST and emits a fragment with `?` placeholders
 * (the dialect renumbers them). Because each scalar field is a real, natively-typed column, filters
 * and value expressions are plain column references — no JSON extraction or casts. It **returns
 * `null` when it can't fully push a node down** (the backend then fetches rows and evaluates in
 * memory, so every query stays correct). Pushed down today: `all`, comparators, `in`/`nin`,
 * `between`, `and`/`or`/`not`, computed `expr`, case-sensitive `textmatch` over a text column (to
 * `LIKE`), and the arithmetic/`coalesce`/`cond`/`switch` value ops. Not yet: `exists`/`size`/
 * `contains`/`any`, case-insensitive or metacharacter text search, and date parts (they scan-fallback).
 */
import type { AggregatePlan, Comparator, ExpressionNode, ValueNode, WindowPlan, WindowFnKind } from "../../core/QueryPlan.ts";
import type { JsonValue } from "../../core/types.ts";
import { OVERFLOW_COLUMN, type SqlDialect } from "./dialect.ts";
import { arithFragment, negFragment, concatFragment, coalesceFragment } from "./valueSql.ts";

export interface SqlFrag {
  sql: string;
  params: JsonValue[];
}

const OP: Record<Comparator, string> = { "=": "=", "!=": "<>", ">": ">", "<": "<", ">=": ">=", "<=": "<=" };
const AGG = { sum: "SUM", avg: "AVG", min: "MIN", max: "MAX" } as const;
const TOP = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Compile a filter AST to a WHERE fragment, or `null` if any part can't be pushed down.
 *
 * `columns` maps the model's real columns to their stored type. It gates two schema-aware push-downs:
 * text search (`textmatch`) only pushes over a `text` column, and a **dotted path** into an embedded
 * subdocument (a `json`/`array`/`scalar` column, or the `_extra` overflow for an undeclared field)
 * compiles to a type-exact JSON extraction. Omitting it (schema unknown) keeps both on the scan path.
 */
export function compileWhere(node: ExpressionNode, d: SqlDialect, columns?: ReadonlyMap<string, string>): SqlFrag | null {
  switch (node.type) {
    case "all":
      return { sql: "1=1", params: [] };
    case "and":
    case "or": {
      if (node.expressions.length === 0) return { sql: node.type === "and" ? "1=1" : "0=1", params: [] };
      const parts = node.expressions.map((e) => compileWhere(e, d, columns));
      if (parts.some((p) => p === null)) return null;
      const join = node.type === "and" ? " AND " : " OR ";
      return { sql: `(${parts.map((p) => p!.sql).join(join)})`, params: parts.flatMap((p) => p!.params) };
    }
    case "not": {
      const inner = compileWhere(node.expression, d, columns);
      return inner && { sql: `NOT (${inner.sql})`, params: inner.params };
    }
    case "compare":
      return compileCompare(node.property, node.comparator, node.value, d, columns);
    case "in":
    case "nin":
      return compileIn(node.type, node.property, node.values, d, columns);
    case "between":
      if (typeof node.lowerEnd !== "number" || typeof node.upperEnd !== "number" || !TOP.test(node.property)) return null;
      return { sql: `${d.column(node.property)} BETWEEN ? AND ?`, params: [node.lowerEnd, node.upperEnd] };
    case "isNull":
      return compileIsNull(node.property, node.negated, d, columns);
    case "textmatch":
      return compileTextMatch(node, d, columns);
    case "expr": {
      const l = compileValue(node.left, d);
      const r = compileValue(node.right, d);
      return l && r ? { sql: `(${l.sql} ${OP[node.comparator]} ${r.sql})`, params: [...l.params, ...r.params] } : null;
    }
    default:
      return null; // exists / size / contains / any → scan fallback
  }
}

/** A scalar the JSON push-down can bind type-exactly (matches the reference's strict comparison). */
function isJsonScalar(value: JsonValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Resolve a property to a JSON extraction against the `_extra` overflow — but only for an
 * **undeclared** head (or a dotted path into a declared `embedded` subdocument), whose value the
 * in-memory reference's `getPath` actually traverses. A path whose head is a *declared* scalar column
 * is rejected (`null` → scan): scalar columns can't be descended, and `json`/`array` columns store an
 * opaque JSON *string* the reference can't reach into either, so pushing them down would return matches
 * the reference doesn't (parity).
 *
 * A **top-level undeclared** property lives whole in `_extra` — e.g. a to-one relation reference
 * (stored under the relation name) or any undeclared field. Routing it here lets a relation filter push
 * down (`(_extra #> '{customer}') = ?`) instead of hitting a non-existent column, matching `getPath`
 * exactly for scalar `=`/`$in`.
 */
function jsonSource(property: string, columns?: ReadonlyMap<string, string>): { column: string; path: string[] } | null {
  if (!columns) return null;
  const segments = property.split(".");
  if (!segments.every((s) => TOP.test(s))) return null; // identifier-only segments (injection guard)
  const head = segments[0]!;
  if (head === "uuid") return null; // the uuid primary key has its own column, never in _extra
  const headType = columns.get(head);
  if (headType === "embedded") return { column: head, path: segments.slice(1) }; // extract from the subdocument column
  if (headType !== undefined) return null; // any other declared column → opaque/untraversable → scan
  return { column: OVERFLOW_COLUMN, path: segments }; // embedded object in the overflow → getPath traverses it
}

/**
 * Compile a null-or-absent test. A declared scalar column stores both an absent field and an explicit
 * null as SQL `NULL`, and the columnar reader decodes a NULL column back to an absent field — so
 * `col IS NULL` is exactly the reference's `getPath(...) == null` for a real column. A nested/undeclared
 * path (the `_extra` overflow) can't: a JSON extraction returns SQL NULL for an absent key but a JSON
 * `'null'` for a present null, which `IS NULL` would treat differently from the reference — so those
 * scan-fall-back (return `null`).
 */
function compileIsNull(property: string, negated: boolean, d: SqlDialect, columns?: ReadonlyMap<string, string>): SqlFrag | null {
  if (!TOP.test(property)) return null; // nested/dotted path → scan
  if (columns && property !== "uuid" && !columns.has(property)) return null; // undeclared (_extra) → scan
  return { sql: `${d.column(property)} IS ${negated ? "NOT NULL" : "NULL"}`, params: [] };
}

/** LIKE metacharacters — a value containing one scans instead (avoids needing an ESCAPE clause). */
const LIKE_META = /[%_\\]/;

function compileTextMatch(
  node: { property: string; value: string; mode: "prefix" | "suffix" | "substring"; caseInsensitive: boolean },
  d: SqlDialect,
  columns?: ReadonlyMap<string, string>
): SqlFrag | null {
  // Case-insensitive (ASCII-only in the reference) and non-text columns can't match `LIKE` exactly,
  // and a value carrying a LIKE metacharacter would need escaping the emulators don't support — scan.
  if (node.caseInsensitive || !TOP.test(node.property) || columns?.get(node.property) !== "text") return null;
  if (LIKE_META.test(node.value)) return null;
  const pattern = node.mode === "prefix" ? `${node.value}%` : node.mode === "suffix" ? `%${node.value}` : `%${node.value}%`;
  return { sql: d.likeMatch(d.column(node.property)), params: [pattern] };
}

function compileCompare(property: string, op: Comparator, value: JsonValue, d: SqlDialect, columns?: ReadonlyMap<string, string>): SqlFrag | null {
  const json = jsonSource(property, columns);
  if (json) {
    // Only equality of a scalar pushes down type-exactly; other comparators keep the scan fallback.
    if (op !== "=" || !isJsonScalar(value)) return null;
    return { sql: `${d.jsonExtract(json.column, json.path)} = ${d.jsonValue()}`, params: [JSON.stringify(value)] };
  }
  if (!TOP.test(property)) return null;
  if (typeof value === "number" || typeof value === "string") {
    const col = d.column(property);
    // `!=` also matches a missing field (stored NULL), like the in-memory reference and Mongo `$ne`;
    // a bare `col <> ?` would drop those rows (SQL 3-valued logic), diverging from the reference.
    if (op === "!=") return { sql: `(${col} ${OP[op]} ? OR ${col} IS NULL)`, params: [value] };
    return { sql: `${col} ${OP[op]} ?`, params: [value] };
  }
  return null; // boolean / null → scan fallback (rare; per-dialect boolean binding differs)
}

function compileIn(kind: "in" | "nin", property: string, values: JsonValue[], d: SqlDialect, columns?: ReadonlyMap<string, string>): SqlFrag | null {
  const json = jsonSource(property, columns);
  if (json) {
    // A nested `$in` pushes down type-exactly; `nin` (which also matches a missing field) stays a scan.
    if (kind !== "in") return null;
    if (values.length === 0) return { sql: "0=1", params: [] };
    if (!values.every(isJsonScalar)) return null;
    const holes = values.map(() => d.jsonValue()).join(", ");
    return { sql: `${d.jsonExtract(json.column, json.path)} IN (${holes})`, params: values.map((v) => JSON.stringify(v)) };
  }
  if (!TOP.test(property)) return null;
  if (values.length === 0) return { sql: kind === "in" ? "0=1" : "1=1", params: [] };
  // A typed column can't mix number and string members — push down only a uniform list.
  const allNum = values.every((v) => typeof v === "number");
  const allStr = values.every((v) => typeof v === "string");
  if (!allNum && !allStr) return null;
  const col = d.column(property);
  const holes = values.map(() => "?").join(", ");
  // `nin` also matches a missing field (NULL), like the in-memory reference and Mongo `$nin`.
  return kind === "in"
    ? { sql: `${col} IN (${holes})`, params: [...values] }
    : { sql: `(${col} IS NULL OR ${col} NOT IN (${holes}))`, params: [...values] };
}

/** Compile a value expression to a column-based SQL fragment, or `null` if it can't push down. */
export function compileValue(node: ValueNode, d: SqlDialect): SqlFrag | null {
  switch (node.type) {
    case "field":
      return TOP.test(node.path) ? { sql: d.column(node.path), params: [] } : null;
    case "lit":
      // Inline numeric / boolean / null literals: as bound params they'd be untyped, and Postgres
      // infers untyped params as text in ambiguous spots (e.g. `CASE … THEN ?`), which broke
      // `SUM(CASE …)`. Numbers/booleans/null can't carry injection, so inlining them is safe.
      if (typeof node.value === "number") return { sql: String(node.value), params: [] };
      if (typeof node.value === "boolean") return { sql: node.value ? "TRUE" : "FALSE", params: [] };
      if (node.value === null) return { sql: "NULL", params: [] };
      return { sql: "?", params: [node.value] };
    case "arith": {
      const ps = node.operands.map((o) => compileValue(o, d));
      if (ps.some((p) => !p)) return null;
      // Only a binary division/modulo pushes down (the shared assembler guards a zero divisor); a
      // longer chain scans (rare). Null-coercion + the divide guard live in `valueSql` so this stays
      // in exact parity with the SQLite compiler and the in-memory reference.
      if ((node.op === "/" || node.op === "%") && ps.length !== 2) return null;
      return arithFragment(node.op, ps as SqlFrag[], d.truncate);
    }
    case "neg": {
      const i = compileValue(node.operand, d);
      return i && negFragment(i);
    }
    case "concat": {
      const ps = node.operands.map((o) => compileValue(o, d));
      if (ps.some((p) => !p)) return null;
      return concatFragment(ps as SqlFrag[], (sqls) => d.concat(sqls));
    }
    case "coalesce": {
      const ps = node.operands.map((o) => compileValue(o, d));
      if (ps.some((p) => !p)) return null;
      return coalesceFragment(ps as SqlFrag[]);
    }
    case "vcompare": {
      const l = compileValue(node.left, d);
      const r = compileValue(node.right, d);
      return l && r ? { sql: `(${l.sql} ${OP[node.op]} ${r.sql})`, params: [...l.params, ...r.params] } : null;
    }
    case "vand":
    case "vor": {
      const ps = node.operands.map((o) => compileValue(o, d));
      if (ps.some((p) => !p)) return null;
      if (ps.length === 0) return { sql: node.type === "vand" ? "TRUE" : "FALSE", params: [] };
      const join = node.type === "vand" ? " AND " : " OR ";
      return { sql: `(${ps.map((p) => p!.sql).join(join)})`, params: ps.flatMap((p) => p!.params) };
    }
    case "vnot": {
      const i = compileValue(node.operand, d);
      return i && { sql: `(NOT ${i.sql})`, params: i.params };
    }
    case "cond": {
      const parts = [compileValue(node.test, d), compileValue(node.then, d), compileValue(node.otherwise, d)];
      if (parts.some((p) => !p)) return null;
      return {
        sql: `CASE WHEN ${parts[0]!.sql} THEN ${parts[1]!.sql} ELSE ${parts[2]!.sql} END`,
        params: parts.flatMap((p) => p!.params)
      };
    }
    case "switch": {
      const params: JsonValue[] = [];
      const whens: string[] = [];
      for (const branch of node.branches) {
        const w = compileValue(branch.when, d);
        const t = compileValue(branch.then, d);
        if (!w || !t) return null;
        params.push(...w.params, ...t.params);
        whens.push(`WHEN ${w.sql} THEN ${t.sql}`);
      }
      const e = compileValue(node.otherwise, d);
      if (!e) return null;
      params.push(...e.params);
      return { sql: `CASE ${whens.join(" ")} ELSE ${e.sql} END`, params };
    }
    default:
      return null; // datepart / datestring → scan fallback
  }
}

export interface AggregateSql {
  columns: string;
  groupBy: string;
  params: JsonValue[];
  /** Just the group-key params — bound a second time for the trailing GROUP BY expressions. */
  groupParams: JsonValue[];
}

/** Compile the SELECT list + GROUP BY for an aggregate, or `null` if any key/value can't push down. */
export function compileAggregate(plan: AggregatePlan, d: SqlDialect): AggregateSql | null {
  const groupParams: JsonValue[] = [];
  const groupExprs: string[] = [];
  const groupCols: string[] = [];
  for (let i = 0; i < plan.groupBy.length; i++) {
    const g = compileValue(plan.groupBy[i]!, d);
    if (!g) return null;
    groupParams.push(...g.params);
    groupExprs.push(g.sql);
    groupCols.push(`${g.sql} AS g${i}`);
  }
  const aggParams: JsonValue[] = [];
  const aggCols: string[] = [];
  for (let i = 0; i < plan.aggregates.length; i++) {
    const agg = plan.aggregates[i]!;
    if (agg.op === "count") {
      aggCols.push(`COUNT(*) AS a${i}`);
      continue;
    }
    const v = compileValue(agg.value!, d);
    if (!v) return null;
    aggParams.push(...v.params);
    if (agg.op === "countDistinct") {
      // COUNT(DISTINCT x) skips NULL on every engine — matches the reference's present-values-only set.
      aggCols.push(`COUNT(DISTINCT ${v.sql}) AS a${i}`);
      continue;
    }
    aggCols.push(`COALESCE(${AGG[agg.op]}(${v.sql}), 0) AS a${i}`);
  }
  const groupBy = groupExprs.length ? ` GROUP BY ${groupExprs.join(", ")}` : "";
  return { columns: [...groupCols, ...aggCols].join(", "), groupBy, params: [...groupParams, ...aggParams], groupParams };
}

const WINDOW_FN: Record<WindowFnKind, string> = { rowNumber: "ROW_NUMBER()", rank: "RANK()", denseRank: "DENSE_RANK()" };

/**
 * Compile the window SELECT columns (`ROW_NUMBER()/RANK()/DENSE_RANK() OVER (PARTITION BY … ORDER BY …)
 * AS w<i>`), or `null` if a partition key can't push down or an order key isn't a real column. The
 * caller prepends these to `SELECT *`, so `params` bind *before* the WHERE params.
 */
export function compileWindow(
  plan: WindowPlan,
  d: SqlDialect,
  columns?: ReadonlyMap<string, string>
): { columns: string; params: JsonValue[] } | null {
  const params: JsonValue[] = [];
  const partitionParts: string[] = [];
  for (const node of plan.partitionBy) {
    const c = compileValue(node, d);
    if (!c) return null;
    params.push(...c.params);
    partitionParts.push(c.sql);
  }
  const orderParts: string[] = [];
  for (const key of plan.order) {
    // Order must be over a real column (a nested/undeclared path can't drive `OVER (… ORDER BY …)`).
    if (!TOP.test(key.property)) return null;
    if (columns && key.property !== "uuid" && !columns.has(key.property)) return null;
    orderParts.push(`${d.column(key.property)} ${key.descending ? "DESC" : "ASC"}${d.nullsOrder(key.descending)}`);
  }
  const over = `OVER (${partitionParts.length ? `PARTITION BY ${partitionParts.join(", ")}` : ""}${
    partitionParts.length && orderParts.length ? " " : ""
  }${orderParts.length ? `ORDER BY ${orderParts.join(", ")}` : ""})`;
  const cols = plan.functions.map((fn, i) => `${WINDOW_FN[fn.kind]} ${over} AS w${i}`).join(", ");
  return { columns: cols, params };
}
