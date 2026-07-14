/**
 * The reference reduction for an `AggregatePlan`, computed over a row set (ARCHITECTURE.md §11).
 *
 * This is the single source of truth for what `count`/`sum`/`avg`/`min`/`max` *mean*: a backend that
 * pushes the aggregate down (SQL `GROUP BY`, Mongo `$group`) must produce the same numbers this
 * produces over the same rows. It lives in the expression layer because it only needs value-node
 * evaluation — so both the repository's in-memory fallback and the transport adapter's server-side
 * reduction share it, with no layering cycle.
 *
 * Null handling matches SQL/Mongo: non-numeric / missing values are ignored by sum/avg/min/max (avg
 * divides by the count of numeric values), and an empty — or all-null — group reduces to 0. `count`
 * counts rows regardless of value (`COUNT(*)` / `$sum: 1`).
 */
import type { AggregateOp, AggregatePlan, AggregateResultRow } from "../core/QueryPlan.ts";
import type { JsonObject, JsonValue } from "../core/types.ts";
import { parseValue, type ValueExpr } from "./values.ts";

/** The finite numbers a reduction sees, after dropping null / missing / non-numeric values. */
function numericValues(rows: readonly JsonObject[], value: ValueExpr): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = value.evaluate(row);
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Apply one reduction over a row set. `value` is undefined for `count`. */
export function reduceWithExpr(op: AggregateOp, value: ValueExpr | undefined, rows: readonly JsonObject[]): number {
  if (op === "count") return rows.length;
  if (op === "countDistinct") {
    // Distinct count of present (non-null) values — Mongo's `$size` of `$addToSet`, and SQL's
    // `COUNT(DISTINCT x)` (which likewise skips NULL). Objects/arrays compare by structure.
    const seen = new Set<string>();
    for (const row of rows) {
      const v = value!.evaluate(row);
      if (v !== null && v !== undefined) seen.add(typeof v === "object" ? JSON.stringify(v) : `${typeof v}:${String(v)}`);
    }
    return seen.size;
  }
  const nums = numericValues(rows, value!);
  if (nums.length === 0) return 0; // empty / all-null group, matching COALESCE(...,0) / $ifNull
  switch (op) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

/**
 * Reduce a whole `AggregatePlan` over a (already filtered) row set. `groupBy: []` yields a single
 * global row; otherwise rows are bucketed by the evaluated key tuple — hashed exactly the way the
 * backends' `GROUP BY` / `$group` dedupe keys — and each bucket reduced independently.
 */
export function reduceAggregatePlan(plan: AggregatePlan, rows: readonly JsonObject[]): AggregateResultRow[] {
  const keyExprs = plan.groupBy.map(parseValue);
  const stages = plan.aggregates.map((agg) => ({ name: agg.name, op: agg.op, value: agg.value ? parseValue(agg.value) : undefined }));
  const reduce = (group: readonly JsonObject[]) =>
    Object.fromEntries(stages.map((s) => [s.name, reduceWithExpr(s.op, s.value, group)]));

  // A global aggregate is one row even over an empty set (COUNT(*) = 0), matching native backends.
  if (keyExprs.length === 0) return [{ key: [], values: reduce(rows) }];

  const buckets = new Map<string, { key: JsonValue[]; rows: JsonObject[] }>();
  for (const row of rows) {
    const key = keyExprs.map((keyExpr) => keyExpr.evaluate(row));
    const hash = JSON.stringify(key.map((value) => value ?? null));
    const bucket = buckets.get(hash) ?? { key, rows: [] };
    bucket.rows.push(row);
    buckets.set(hash, bucket);
  }
  return [...buckets.values()].map(({ key, rows: group }) => ({ key, values: reduce(group) }));
}
