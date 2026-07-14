/**
 * The query-expression layer: a backend-agnostic filter AST that can be evaluated in memory
 * (`match`), serialized for the wire/cache (`serialize`/`hash`/`parse`), and compiled to a
 * native query via a visitor (`compile`). See ARCHITECTURE.md §3–4.
 */
export type { Expression } from "./Expression.ts";
export type { ExpressionVisitor } from "./visitor.ts";
export { All, Compare, Expr, Any, In, Nin, Contains, Between, Exists, IsNull, Size, TextMatch, And, Or, Not } from "./nodes.ts";
export { parse } from "./parse.ts";
export { getPath } from "./path.ts";

// Value (scalar) expressions: field references and computed values (§11).
export type { ValueExpr, ValueVisitor, ValueInput } from "./values.ts";
export {
  field,
  lit,
  add,
  sub,
  mul,
  div,
  mod,
  neg,
  concat,
  coalesce,
  datePart,
  year,
  month,
  dayOfMonth,
  dayOfWeek,
  hour,
  dateToString,
  cmp,
  allOf,
  anyOf,
  negate,
  cond,
  switchExpr,
  parseValue,
  isValueExpr,
  toValueExpr
} from "./values.ts";
export {
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
  inList,
  notInList,
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
} from "./builders.ts";

export { default } from "./builders.ts";
