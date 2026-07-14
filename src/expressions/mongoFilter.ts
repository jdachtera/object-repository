/**
 * Parse a MongoDB-shaped filter document (`{ age: { $gt: 30 }, $or: [...] }`) into this library's
 * portable expression AST — the *inverse* of `compileMongoFilter`. It lives here, in the expression
 * layer, because it is pure AST construction with no backend or Mongo-driver dependency: the core
 * `QueryCollection.where()` uses it, so keeping it out of the heavier `compat/mongo` facade means a
 * plain `object-repository` import never pulls the Mongo update/cursor machinery into the bundle. The full Mongo
 * compat surface (`mongoCollection`, update parsing) re-exports `parseMongoFilter` from here.
 *
 * Fidelity: this maps the common, portable subset. Anything it can't express exactly — arbitrary
 * regexes, `$where`, unsupported operators — **throws** rather than guessing, so drift is loud.
 */
import {
  all,
  and,
  or,
  not,
  eq,
  neq,
  gt,
  gte,
  lt,
  lte,
  inList,
  notInList,
  exists,
  size,
  contains,
  any,
  startsWith,
  endsWith,
  includesText
} from "./builders.ts";
import type { Expression } from "./Expression.ts";
import type { JsonValue } from "../core/types.ts";

/** A MongoDB filter document. */
export type MongoFilter = Record<string, unknown>;

/** Parse a MongoDB filter document into the portable expression AST (throws on anything unsupported). */
export function parseMongoFilter(filter: MongoFilter): Expression {
  const clauses: Expression[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") clauses.push(and(...asFilters(value).map(parseMongoFilter)));
    else if (key === "$or") clauses.push(or(...asFilters(value).map(parseMongoFilter)));
    else if (key === "$nor") clauses.push(not(or(...asFilters(value).map(parseMongoFilter))));
    else if (key.startsWith("$")) throw new Error(`Unsupported top-level Mongo operator "${key}".`);
    else clauses.push(fieldClause(key, value));
  }
  if (clauses.length === 0) return all();
  return clauses.length === 1 ? clauses[0]! : and(...clauses);
}

function asFilters(value: unknown): MongoFilter[] {
  if (!Array.isArray(value)) throw new Error("Mongo $and/$or/$nor expects an array of filters.");
  return value as MongoFilter[];
}

/** An operator object is `{ $op: … }` (vs. a plain equality value). */
export function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key.startsWith("$"))
  );
}

function fieldClause(field: string, condition: unknown): Expression {
  if (!isOperatorObject(condition)) return eq(field, condition as JsonValue);
  const caseInsensitive = typeof condition.$options === "string" && condition.$options.includes("i");
  const parts: Expression[] = [];
  for (const [op, operand] of Object.entries(condition)) {
    if (op === "$options") continue; // consumed alongside $regex
    if (op === "$regex") parts.push(regexClause(field, operand, caseInsensitive));
    else parts.push(fieldOperator(field, op, operand));
  }
  return parts.length === 1 ? parts[0]! : and(...parts);
}

function fieldOperator(field: string, op: string, operand: unknown): Expression {
  switch (op) {
    case "$eq":
      return eq(field, operand as JsonValue);
    case "$ne":
      return neq(field, operand as JsonValue);
    case "$gt":
      return gt(field, operand as JsonValue);
    case "$gte":
      return gte(field, operand as JsonValue);
    case "$lt":
      return lt(field, operand as JsonValue);
    case "$lte":
      return lte(field, operand as JsonValue);
    case "$in":
      return inList(field, operand as JsonValue[]);
    case "$nin":
      return notInList(field, operand as JsonValue[]);
    case "$exists":
      return exists(field, Boolean(operand));
    case "$size":
      return size(field, Number(operand));
    case "$all":
      return and(...(operand as JsonValue[]).map((value) => contains(field, value)));
    case "$elemMatch":
      return any(field, parseMongoFilter(operand as MongoFilter));
    case "$not":
      return not(fieldClause(field, operand));
    default:
      throw new Error(`Unsupported Mongo operator "${op}" on field "${field}".`);
  }
}

/** Map a `$regex` to prefix/suffix/substring text search — literal patterns with optional ^/$ anchors only. */
function regexClause(field: string, operand: unknown, caseInsensitive: boolean): Expression {
  const source = operand instanceof RegExp ? operand.source : String(operand);
  const ci = caseInsensitive || (operand instanceof RegExp && operand.flags.includes("i"));
  const anchoredStart = source.startsWith("^");
  const anchoredEnd = source.endsWith("$") && !source.endsWith("\\$");
  const core = source.slice(anchoredStart ? 1 : 0, anchoredEnd ? -1 : undefined);
  if (/[.*+?()[\]{}|\\]/.test(core) || core.includes("^") || core.includes("$")) {
    throw new Error(`Unsupported $regex "${source}" — only literal patterns with optional ^/$ anchors map to text search.`);
  }
  const options = { caseInsensitive: ci };
  if (anchoredStart && anchoredEnd) {
    if (ci) throw new Error(`Unsupported case-insensitive anchored $regex "${source}"; use $eq for exact matches.`);
    return eq(field, core);
  }
  if (anchoredStart) return startsWith(field, core, options);
  if (anchoredEnd) return endsWith(field, core, options);
  return includesText(field, core, options);
}
