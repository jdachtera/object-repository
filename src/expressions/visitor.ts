import type { Comparator, TextMode } from "../core/QueryPlan.ts";
import type { JsonValue } from "../core/types.ts";
import type { Expression } from "./Expression.ts";
import type { ValueExpr } from "./values.ts";

/**
 * The compile seam (ARCHITECTURE.md §3).
 *
 * A backend implements an `ExpressionVisitor<R>` to translate an expression AST into its native
 * query representation `R` — a SQL fragment + params, a Mongo filter object, an IndexedDB key
 * range, etc. `Expression#compile` dispatches to the matching method. Composite nodes receive
 * their children as `Expression`s and recurse via `child.compile(this)`.
 *
 * Scan-only backends (in-memory, localStorage) skip compilation entirely and use
 * `Expression#match` instead — the reference evaluator and fallback.
 */
export interface ExpressionVisitor<R> {
  all(): R;
  compare(property: string, comparator: Comparator, value: JsonValue): R;
  /** A comparison between two computed value expressions (`price * qty > 100`). */
  expr(left: ValueExpr, comparator: Comparator, right: ValueExpr): R;
  /** "Any element of the array at `property` matches `predicate`" (embedded/array fields). */
  any(property: string, predicate: Expression): R;
  in(property: string, values: JsonValue[]): R;
  nin(property: string, values: JsonValue[]): R;
  contains(property: string, value: JsonValue): R;
  between(property: string, lowerEnd: JsonValue, upperEnd: JsonValue): R;
  /** Field presence — `shouldExist` false matches an absent path (a null value counts as present). */
  exists(property: string, shouldExist: boolean): R;
  /** Null-or-absent — `negated` false matches a null/absent value, true matches a present non-null one. */
  isNull(property: string, negated: boolean): R;
  /** Array-length predicate — the value at `property` is an array of exactly `length` elements. */
  size(property: string, length: number): R;
  /** String prefix/suffix/substring match (ASCII-only case folding when `caseInsensitive`). */
  textmatch(property: string, value: string, mode: TextMode, caseInsensitive: boolean): R;
  and(expressions: readonly Expression[]): R;
  or(expressions: readonly Expression[]): R;
  not(expression: Expression): R;
}
