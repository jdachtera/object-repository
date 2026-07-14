/**
 * Aggregation primitives for the advanced-query surface (ARCHITECTURE.md §11).
 *
 * These define the *reference semantics* of each aggregate, computed in memory over a result set.
 * Per §11, a backend may later push an aggregate down (SQL `SUM`, Mongo `$group`); when it can't,
 * these run as the fallback — so the result is identical everywhere, only the performance differs.
 */
import { field, isValueExpr, type ValueExpr } from "../expressions/values.ts";
import { reduceWithExpr } from "../expressions/aggregateReduce.ts";
import type { AggregateOp } from "../core/QueryPlan.ts";
import type { JsonObject } from "../core/types.ts";

/**
 * A named reduction descriptor (ARCHITECTURE.md §11). It carries enough structure to be *pushed
 * down* (its `op` and serializable `value` expression) and to run as the in-memory *reference*
 * (`reduce`). The two faces stay in lock-step so a backend's `$group` / `GROUP BY` and the fallback
 * scan produce identical numbers.
 *
 * Null handling matches SQL/Mongo: non-numeric / missing values are ignored by sum/avg/min/max
 * (avg divides by the count of numeric values), and an empty — or all-null — input reduces to 0.
 * `count` counts rows regardless of value (like `COUNT(*)` / `$sum: 1`).
 */
export interface AggregateExpr<T> {
  readonly op: AggregateOp;
  /** Value expression to reduce over; `undefined` for `count`. */
  readonly value?: ValueExpr;
  reduce(rows: readonly T[]): number;
}

/** Keys of `T` whose value is a number — the only ones numeric aggregates accept. */
export type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

/** What a numeric aggregate reduces over: a numeric field, or a computed value expression. */
export type NumericInput<T> = NumericKey<T> | ValueExpr;

/** What `countDistinct` reduces over: *any* field (its type is irrelevant), or a value expression. */
export type AnyInput<T> = keyof T | ValueExpr;

/** Typed factory handed to `aggregate`/`groupBy` so field references are checked against `T`. */
export interface Aggregators<T> {
  count(): AggregateExpr<T>;
  /** Distinct count of a field's present values — the portable `$size` of `$addToSet` / `COUNT(DISTINCT)`. */
  countDistinct(value: AnyInput<T>): AggregateExpr<T>;
  sum(value: NumericInput<T>): AggregateExpr<T>;
  avg(value: NumericInput<T>): AggregateExpr<T>;
  min(value: NumericInput<T>): AggregateExpr<T>;
  max(value: NumericInput<T>): AggregateExpr<T>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** An input (field name or value expression) as a value expression — the push-down form. */
function asValueExpr(input: NumericInput<any> | AnyInput<any>): ValueExpr {
  return isValueExpr(input) ? input : field(String(input));
}

function makeExpr(op: AggregateOp, input?: NumericInput<any> | AnyInput<any>): AggregateExpr<any> {
  const value = input === undefined ? undefined : asValueExpr(input);
  // The reduction semantics are defined once in the expression layer (shared with the transport
  // adapter's server-side push-down), so every path produces identical numbers.
  return { op, value, reduce: (rows) => reduceWithExpr(op, value, rows as readonly JsonObject[]) };
}

/** Concrete aggregator factory (typed loosely; the public API re-types them per `T`). */
export const AGGREGATORS: Aggregators<any> = {
  count: () => makeExpr("count"),
  countDistinct: (value) => makeExpr("countDistinct", value),
  sum: (value) => makeExpr("sum", value),
  avg: (value) => makeExpr("avg", value),
  min: (value) => makeExpr("min", value),
  max: (value) => makeExpr("max", value)
};
/* eslint-enable @typescript-eslint/no-explicit-any */
