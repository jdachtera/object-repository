import type { JsonObject, JsonValue } from "../core/types.ts";
import type { Comparator, ExpressionNode, TextMode } from "../core/QueryPlan.ts";
import type { Expression } from "./Expression.ts";
import type { ExpressionVisitor } from "./visitor.ts";
import type { ValueExpr } from "./values.ts";
import { getPath } from "./path.ts";

/** Compare two evaluated JSON scalars with a comparator (shared by Compare and Expr). */
export function compareJson(left: JsonValue | undefined, comparator: Comparator, right: JsonValue): boolean {
  switch (comparator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return relate(left, right) > 0;
    case "<":
      return relate(left, right) < 0;
    case ">=":
      return left === right || relate(left, right) > 0;
    case "<=":
      return left === right || relate(left, right) < 0;
  }
}

/**
 * Relational comparison over JSON scalars for ordering (`<`, `<=`, `>`, `>=`). Returns `NaN` when the
 * operands are *unordered* — either is absent (null/undefined) or they are different types — so every
 * ordering comparison against it is false. This matches what the compiled backends do (SQL three-valued
 * logic excludes NULL; Mongo `$lt`/`$gt` type-bracket) and keeps the in-memory reference in exact
 * parity with them. Equality (`=`/`!=`) is handled separately by `===`, so an absent field can still be
 * matched by `!=` (as on Mongo) — only ordering treats it as unordered.
 */
function relate(left: JsonValue | undefined, right: JsonValue): number {
  if (left === null || left === undefined || right === null || right === undefined) return NaN;
  if (typeof left !== typeof right) return NaN; // no cross-type coercion — different types are unordered
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export class All implements Expression {
  match(): boolean {
    return true;
  }
  serialize(): ExpressionNode {
    return { type: "all" };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.all();
  }
}

export class Compare implements Expression {
  constructor(
    readonly property: string,
    readonly comparator: Comparator,
    readonly value: JsonValue
  ) {}

  match(record: JsonObject): boolean {
    const left = getPath(record, this.property);
    const right = this.value;
    switch (this.comparator) {
      case "=":
        return left === right;
      case "!=":
        return left !== right;
      case ">":
        return relate(left, right) > 0;
      case "<":
        return relate(left, right) < 0;
      case ">=":
        return left === right || relate(left, right) > 0;
      case "<=":
        return left === right || relate(left, right) < 0;
    }
  }

  serialize(): ExpressionNode {
    return { type: "compare", property: this.property, comparator: this.comparator, value: this.value };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.compare(this.property, this.comparator, this.value);
  }
}

export class Expr implements Expression {
  constructor(
    readonly left: ValueExpr,
    readonly comparator: Comparator,
    readonly right: ValueExpr
  ) {}

  match(record: JsonObject): boolean {
    return compareJson(this.left.evaluate(record), this.comparator, this.right.evaluate(record));
  }
  serialize(): ExpressionNode {
    return { type: "expr", left: this.left.serialize(), comparator: this.comparator, right: this.right.serialize() };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.expr(this.left, this.comparator, this.right);
  }
}

export class Any implements Expression {
  constructor(
    readonly property: string,
    readonly predicate: Expression
  ) {}

  match(record: JsonObject): boolean {
    const array = getPath(record, this.property);
    if (!Array.isArray(array)) return false;
    return array.some((element) =>
      // Each element is matched as its own record; bare-value elements match against `value`.
      this.predicate.match(isRecord(element) ? element : ({ value: element } as JsonObject))
    );
  }
  serialize(): ExpressionNode {
    return { type: "any", property: this.property, predicate: this.predicate.serialize() };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.any(this.property, this.predicate);
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class In implements Expression {
  constructor(
    readonly property: string,
    readonly values: JsonValue[]
  ) {}

  match(record: JsonObject): boolean {
    return this.values.includes(getPath(record, this.property) as JsonValue);
  }
  serialize(): ExpressionNode {
    return { type: "in", property: this.property, values: this.values };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.in(this.property, this.values);
  }
}

export class Nin implements Expression {
  constructor(
    readonly property: string,
    readonly values: JsonValue[]
  ) {}

  match(record: JsonObject): boolean {
    return !this.values.includes(getPath(record, this.property) as JsonValue);
  }
  serialize(): ExpressionNode {
    return { type: "nin", property: this.property, values: this.values };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.nin(this.property, this.values);
  }
}

export class Contains implements Expression {
  constructor(
    readonly property: string,
    readonly value: JsonValue
  ) {}

  match(record: JsonObject): boolean {
    const list = getPath(record, this.property);
    return Array.isArray(list) && list.includes(this.value);
  }
  serialize(): ExpressionNode {
    return { type: "contains", property: this.property, value: this.value };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.contains(this.property, this.value);
  }
}

export class Between implements Expression {
  constructor(
    readonly property: string,
    readonly lowerEnd: JsonValue,
    readonly upperEnd: JsonValue
  ) {}

  match(record: JsonObject): boolean {
    const value = getPath(record, this.property);
    return (
      (value === this.lowerEnd || relate(value, this.lowerEnd) > 0) &&
      (value === this.upperEnd || relate(value, this.upperEnd) < 0)
    );
  }
  serialize(): ExpressionNode {
    return { type: "between", property: this.property, lowerEnd: this.lowerEnd, upperEnd: this.upperEnd };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.between(this.property, this.lowerEnd, this.upperEnd);
  }
}

export class Exists implements Expression {
  constructor(
    readonly property: string,
    readonly shouldExist: boolean
  ) {}

  match(record: JsonObject): boolean {
    // A present path (including one whose value is null) counts as existing, matching Mongo;
    // `getPath` only returns `undefined` when the key/path is actually absent.
    const present = getPath(record, this.property) !== undefined;
    return present === this.shouldExist;
  }
  serialize(): ExpressionNode {
    return { type: "exists", property: this.property, shouldExist: this.shouldExist };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.exists(this.property, this.shouldExist);
  }
}

export class IsNull implements Expression {
  constructor(
    readonly property: string,
    readonly negated: boolean
  ) {}

  match(record: JsonObject): boolean {
    // Null-or-absent: `getPath` returns `undefined` for a missing path and the stored value otherwise,
    // so `== null` is true for both an explicit null and an absent field (the one cross-engine-exact
    // null test). `negated` flips it to "present and not null".
    const isNull = getPath(record, this.property) == null;
    return isNull !== this.negated;
  }
  serialize(): ExpressionNode {
    return { type: "isNull", property: this.property, negated: this.negated };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.isNull(this.property, this.negated);
  }
}

export class Size implements Expression {
  constructor(
    readonly property: string,
    readonly length: number
  ) {}

  match(record: JsonObject): boolean {
    const value = getPath(record, this.property);
    return Array.isArray(value) && value.length === this.length;
  }
  serialize(): ExpressionNode {
    return { type: "size", property: this.property, length: this.length };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.size(this.property, this.length);
  }
}

/** ASCII-only lowercasing — A–Z → a–z, everything else untouched (matches stock SQLite `lower()`). */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export class TextMatch implements Expression {
  constructor(
    readonly property: string,
    readonly value: string,
    readonly mode: TextMode,
    readonly caseInsensitive: boolean
  ) {}

  match(record: JsonObject): boolean {
    const value = getPath(record, this.property);
    if (typeof value !== "string") return false;
    const haystack = this.caseInsensitive ? asciiLower(value) : value;
    const needle = this.caseInsensitive ? asciiLower(this.value) : this.value;
    switch (this.mode) {
      case "prefix":
        return haystack.startsWith(needle);
      case "suffix":
        return haystack.endsWith(needle);
      case "substring":
        return haystack.includes(needle);
    }
  }
  serialize(): ExpressionNode {
    return {
      type: "textmatch",
      property: this.property,
      value: this.value,
      mode: this.mode,
      caseInsensitive: this.caseInsensitive
    };
  }
  hash(): string {
    return JSON.stringify(this.serialize());
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.textmatch(this.property, this.value, this.mode, this.caseInsensitive);
  }
}

export class And implements Expression {
  constructor(readonly expressions: readonly Expression[]) {}

  match(record: JsonObject): boolean {
    return this.expressions.every((expression) => expression.match(record));
  }
  serialize(): ExpressionNode {
    return { type: "and", expressions: this.expressions.map((e) => e.serialize()) };
  }
  hash(): string {
    // Sort child hashes so `and(a, b)` and `and(b, a)` produce the same cache key.
    const parts = this.expressions.map((e) => e.hash()).sort();
    return JSON.stringify({ type: "and", expressions: parts });
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.and(this.expressions);
  }
}

export class Or implements Expression {
  constructor(readonly expressions: readonly Expression[]) {}

  match(record: JsonObject): boolean {
    return this.expressions.some((expression) => expression.match(record));
  }
  serialize(): ExpressionNode {
    return { type: "or", expressions: this.expressions.map((e) => e.serialize()) };
  }
  hash(): string {
    const parts = this.expressions.map((e) => e.hash()).sort();
    return JSON.stringify({ type: "or", expressions: parts });
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.or(this.expressions);
  }
}

export class Not implements Expression {
  constructor(readonly expression: Expression) {}

  match(record: JsonObject): boolean {
    return !this.expression.match(record);
  }
  serialize(): ExpressionNode {
    return { type: "not", expression: this.expression.serialize() };
  }
  hash(): string {
    return JSON.stringify({ type: "not", expression: this.expression.hash() });
  }
  compile<R>(visitor: ExpressionVisitor<R>): R {
    return visitor.not(this.expression);
  }
}
