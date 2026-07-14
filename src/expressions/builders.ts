import type { JsonValue } from "../core/types.ts";
import type { Comparator } from "../core/QueryPlan.ts";
import type { Expression } from "./Expression.ts";
import { All, And, Any, Between, Compare, Contains, Exists, Expr, In, IsNull, Nin, Not, Or, Size, TextMatch } from "./nodes.ts";
import { field, isValueExpr, lit, type ValueExpr, type ValueInput } from "./values.ts";

/** Fluent constructors for the expression AST (mirrors the legacy `Expression.*` statics). */

/**
 * Normalise a literal comparand into a JSON scalar. A `Date` isn't a `JsonValue`; the ORM stores dates
 * as epoch milliseconds (the `date()` codec), so a `Date` passed to a filter is folded to `.getTime()`
 * here — otherwise it would compare a `Date` object against a stored number and, under the type-exact
 * comparison rules, never match. Applied at construction so every backend (and the reference) sees the
 * same numeric form.
 */
const comparand = (value: JsonValue): JsonValue => (value instanceof Date ? value.getTime() : value);

export const all = (): Expression => new All();

/**
 * Build a comparison. The fast path — a plain property name vs. a literal — stays a `Compare`
 * (index-pushable). If either side is a value expression, it becomes a computed `Expr`
 * (`gt(mul(field("price"), field("qty")), 100)`), where a bare string is read as a field.
 */
function comparison(
  left: string | ValueExpr,
  comparator: Comparator,
  right: ValueInput
): Expression {
  if (typeof left === "string" && !isValueExpr(right)) {
    return new Compare(left, comparator, comparand(right));
  }
  const leftExpr = isValueExpr(left) ? left : field(left);
  const rightExpr = isValueExpr(right) ? right : lit(comparand(right));
  return new Expr(leftExpr, comparator, rightExpr);
}

export const compare = (left: string | ValueExpr, comparator: Comparator, right: ValueInput): Expression =>
  comparison(left, comparator, right);

export const eq = (left: string | ValueExpr, right: ValueInput): Expression => comparison(left, "=", right);
export const neq = (left: string | ValueExpr, right: ValueInput): Expression => comparison(left, "!=", right);
export const gt = (left: string | ValueExpr, right: ValueInput): Expression => comparison(left, ">", right);
export const lt = (left: string | ValueExpr, right: ValueInput): Expression => comparison(left, "<", right);
export const gte = (left: string | ValueExpr, right: ValueInput): Expression => comparison(left, ">=", right);
export const lte = (left: string | ValueExpr, right: ValueInput): Expression => comparison(left, "<=", right);

export const and = (...expressions: Expression[]): Expression => new And(expressions);
export const or = (...expressions: Expression[]): Expression => new Or(expressions);
export const not = (expression: Expression): Expression => new Not(expression);

/** Named `inList` because `in` is a reserved word; exposed as `expr.in` on the default export. */
export const inList = (property: string, values: JsonValue[]): Expression =>
  new In(property, values.map(comparand));

/** Negated `inList`: the value at `property` is none of `values` (a missing field matches). */
export const notInList = (property: string, values: JsonValue[]): Expression =>
  new Nin(property, values.map(comparand));

export const contains = (property: string, value: JsonValue): Expression =>
  new Contains(property, comparand(value));

/**
 * Match when any element of the array at `property` satisfies `predicate` — for filtering into
 * embedded/array fields (`any("items", eq("sku", "X"))`). Bare-value elements are matched against
 * the field `value` (`any("langs", eq("value", "de"))`).
 */
export const any = (property: string, predicate: Expression): Expression =>
  new Any(property, predicate);

export const between = (property: string, lowerEnd: JsonValue, upperEnd: JsonValue): Expression =>
  new Between(property, comparand(lowerEnd), comparand(upperEnd));

/** Match when `property` is present (`shouldExist` true, the default) or absent (false). */
export const exists = (property: string, shouldExist = true): Expression =>
  new Exists(property, shouldExist);

/** Match when the value at `property` is null OR absent (the cross-engine-exact null-or-absent test). */
export const isNull = (property: string): Expression => new IsNull(property, false);
/** Match when the value at `property` is present and not null. */
export const isNotNull = (property: string): Expression => new IsNull(property, true);

/** Match when the array at `property` has exactly `length` elements. */
export const size = (property: string, length: number): Expression => new Size(property, length);

/** Options for the string-match predicates. Case folding, when on, is ASCII-only (§ raw door for Unicode). */
export interface TextMatchOptions {
  caseInsensitive?: boolean;
}
/** The string at `property` starts with `value`. */
export const startsWith = (property: string, value: string, options: TextMatchOptions = {}): Expression =>
  new TextMatch(property, value, "prefix", options.caseInsensitive ?? false);
/** The string at `property` ends with `value`. */
export const endsWith = (property: string, value: string, options: TextMatchOptions = {}): Expression =>
  new TextMatch(property, value, "suffix", options.caseInsensitive ?? false);
/** The string at `property` contains `value` as a substring (named to avoid the array `contains`). */
export const includesText = (property: string, value: string, options: TextMatchOptions = {}): Expression =>
  new TextMatch(property, value, "substring", options.caseInsensitive ?? false);

/** Ergonomic namespace: `import expr from ".../expressions"; expr.eq("x", 1)`. */
export default {
  all,
  compare,
  eq,
  neq,
  gt,
  lt,
  gte,
  lte,
  and,
  or,
  not,
  in: inList,
  notIn: notInList,
  contains,
  any,
  between,
  exists,
  isNull,
  isNotNull,
  size,
  startsWith,
  endsWith,
  includesText
};
