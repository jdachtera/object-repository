import type { JsonObject, JsonValue } from "../core/types.ts";
import type { ArithOp, Comparator, DatePart, ValueNode } from "../core/QueryPlan.ts";
import { compareJson } from "./nodes.ts";
import { getPath } from "./path.ts";

/**
 * A scalar-valued expression (ARCHITECTURE.md §11): a field reference, a literal, or a computed
 * value (arithmetic, concat, coalesce). Like the boolean `Expression`, each node can be evaluated
 * in memory (the reference semantics + scan fallback) and compiled to a backend's native value
 * language (Mongo aggregation expression, SQL arithmetic).
 */
export interface ValueExpr {
  evaluate(record: JsonObject): JsonValue;
  serialize(): ValueNode;
  compile<R>(visitor: ValueVisitor<R>): R;
}

/** The compile seam for value expressions — implemented by each backend's value compiler. */
export interface ValueVisitor<R> {
  field(path: string): R;
  lit(value: JsonValue): R;
  arith(op: ArithOp, operands: readonly ValueExpr[]): R;
  neg(operand: ValueExpr): R;
  concat(operands: readonly ValueExpr[]): R;
  coalesce(operands: readonly ValueExpr[]): R;
  datepart(part: DatePart, operand: ValueExpr, timezone?: string): R;
  /** Format an epoch-ms date with a `strftime`-style pattern (the `%Y %m %d %H %M %S %%` subset). */
  datestring(format: string, operand: ValueExpr, timezone?: string): R;
  /** Boolean-valued comparison of two value expressions (for use inside `cond`/`switch`). */
  vcompare(op: Comparator, left: ValueExpr, right: ValueExpr): R;
  vand(operands: readonly ValueExpr[]): R;
  vor(operands: readonly ValueExpr[]): R;
  vnot(operand: ValueExpr): R;
  cond(test: ValueExpr, then: ValueExpr, otherwise: ValueExpr): R;
  switch(branches: ReadonlyArray<{ when: ValueExpr; then: ValueExpr }>, otherwise: ValueExpr): R;
}

class Field implements ValueExpr {
  constructor(readonly path: string) {}
  evaluate(record: JsonObject): JsonValue {
    return getPath(record, this.path) ?? null;
  }
  serialize(): ValueNode {
    return { type: "field", path: this.path };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.field(this.path);
  }
}

class Lit implements ValueExpr {
  constructor(readonly value: JsonValue) {}
  evaluate(): JsonValue {
    return this.value;
  }
  serialize(): ValueNode {
    return { type: "lit", value: this.value };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.lit(this.value);
  }
}

class Arith implements ValueExpr {
  constructor(
    readonly op: ArithOp,
    readonly operands: readonly ValueExpr[]
  ) {}
  evaluate(record: JsonObject): JsonValue {
    const numbers = this.operands.map((operand) => num(operand.evaluate(record)));
    return numbers.reduce((acc, value) => applyArith(this.op, acc, value));
  }
  serialize(): ValueNode {
    return { type: "arith", op: this.op, operands: this.operands.map((o) => o.serialize()) };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.arith(this.op, this.operands);
  }
}

class Neg implements ValueExpr {
  constructor(readonly operand: ValueExpr) {}
  evaluate(record: JsonObject): JsonValue {
    return -num(this.operand.evaluate(record));
  }
  serialize(): ValueNode {
    return { type: "neg", operand: this.operand.serialize() };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.neg(this.operand);
  }
}

class Concat implements ValueExpr {
  constructor(readonly operands: readonly ValueExpr[]) {}
  evaluate(record: JsonObject): JsonValue {
    return this.operands.map((operand) => String(operand.evaluate(record) ?? "")).join("");
  }
  serialize(): ValueNode {
    return { type: "concat", operands: this.operands.map((o) => o.serialize()) };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.concat(this.operands);
  }
}

class Coalesce implements ValueExpr {
  constructor(readonly operands: readonly ValueExpr[]) {}
  evaluate(record: JsonObject): JsonValue {
    for (const operand of this.operands) {
      const value = operand.evaluate(record);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  }
  serialize(): ValueNode {
    return { type: "coalesce", operands: this.operands.map((o) => o.serialize()) };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.coalesce(this.operands);
  }
}

class DatePartExpr implements ValueExpr {
  constructor(
    readonly part: DatePart,
    readonly operand: ValueExpr,
    readonly timezone?: string
  ) {}
  evaluate(record: JsonObject): JsonValue {
    const value = this.operand.evaluate(record);
    if (value === null || value === undefined) return null; // absent/null → null (not epoch 0)
    // Dates are stored as epoch ms; over a hydrated instance the value may be a Date — coerce both.
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(ms)) return null;
    return zonedFields(ms, this.timezone)[this.part];
  }
  serialize(): ValueNode {
    return { type: "datepart", part: this.part, operand: this.operand.serialize(), timezone: this.timezone };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.datepart(this.part, this.operand, this.timezone);
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The wall-clock fields of an epoch-ms instant. `dayOfWeek` is 1 (Sunday)–7, matching Mongo. */
export interface ZonedFields {
  year: number;
  month: number;
  dayOfMonth: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Decompose an epoch-ms instant into wall-clock fields, in an IANA `timezone` when given (DST-aware,
 * via `Intl`) or UTC otherwise. This is the single source of truth for `datePart`/`dateToString`, so a
 * timezone shifts day/hour boundaries consistently everywhere the reference runs.
 */
export function zonedFields(ms: number, timezone?: string): ZonedFields {
  if (!timezone) {
    const d = new Date(ms);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      dayOfMonth: d.getUTCDate(),
      dayOfWeek: d.getUTCDay() + 1,
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds()
    };
  }
  const parts: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const dayOfMonth = Number(parts.day);
  // day-of-week from the *zoned* Y/M/D (build a UTC date from those fields, then read its weekday).
  const dayOfWeek = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay() + 1;
  return {
    year,
    month,
    dayOfMonth,
    dayOfWeek,
    hour: parts.hour === "24" ? 0 : Number(parts.hour), // some ICU builds emit "24" for midnight
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

/** Render the supported `strftime`/`$dateToString` tokens of `format` against a (zoned) date. */
export function formatDate(date: Date, format: string, timezone?: string): string {
  const f = zonedFields(date.getTime(), timezone);
  return format.replace(/%[%YmdHMS]/g, (token) => {
    switch (token) {
      case "%%":
        return "%";
      case "%Y":
        return String(f.year).padStart(4, "0");
      case "%m":
        return pad2(f.month);
      case "%d":
        return pad2(f.dayOfMonth);
      case "%H":
        return pad2(f.hour);
      case "%M":
        return pad2(f.minute);
      case "%S":
        return pad2(f.second);
      default:
        return token;
    }
  });
}

class DateToStringExpr implements ValueExpr {
  constructor(
    readonly format: string,
    readonly operand: ValueExpr,
    readonly timezone?: string
  ) {}
  evaluate(record: JsonObject): JsonValue {
    const value = this.operand.evaluate(record);
    if (value === null || value === undefined) return null;
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(ms)) return null;
    return formatDate(new Date(ms), this.format, this.timezone);
  }
  serialize(): ValueNode {
    return { type: "datestring", format: this.format, operand: this.operand.serialize(), timezone: this.timezone };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.datestring(this.format, this.operand, this.timezone);
  }
}

/** Whether a value counts as true for `cond`/`switch` (matches Mongo: false/null/0/missing → false). */
function truthy(value: JsonValue): boolean {
  return value !== false && value !== null && value !== undefined && value !== 0;
}

class VCompare implements ValueExpr {
  constructor(
    readonly op: Comparator,
    readonly left: ValueExpr,
    readonly right: ValueExpr
  ) {}
  evaluate(record: JsonObject): JsonValue {
    return compareJson(this.left.evaluate(record), this.op, this.right.evaluate(record));
  }
  serialize(): ValueNode {
    return { type: "vcompare", op: this.op, left: this.left.serialize(), right: this.right.serialize() };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.vcompare(this.op, this.left, this.right);
  }
}

class VAnd implements ValueExpr {
  constructor(readonly operands: readonly ValueExpr[]) {}
  evaluate(record: JsonObject): JsonValue {
    return this.operands.every((operand) => truthy(operand.evaluate(record)));
  }
  serialize(): ValueNode {
    return { type: "vand", operands: this.operands.map((o) => o.serialize()) };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.vand(this.operands);
  }
}

class VOr implements ValueExpr {
  constructor(readonly operands: readonly ValueExpr[]) {}
  evaluate(record: JsonObject): JsonValue {
    return this.operands.some((operand) => truthy(operand.evaluate(record)));
  }
  serialize(): ValueNode {
    return { type: "vor", operands: this.operands.map((o) => o.serialize()) };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.vor(this.operands);
  }
}

class VNot implements ValueExpr {
  constructor(readonly operand: ValueExpr) {}
  evaluate(record: JsonObject): JsonValue {
    return !truthy(this.operand.evaluate(record));
  }
  serialize(): ValueNode {
    return { type: "vnot", operand: this.operand.serialize() };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.vnot(this.operand);
  }
}

class Cond implements ValueExpr {
  constructor(
    readonly test: ValueExpr,
    readonly then: ValueExpr,
    readonly otherwise: ValueExpr
  ) {}
  evaluate(record: JsonObject): JsonValue {
    return truthy(this.test.evaluate(record)) ? this.then.evaluate(record) : this.otherwise.evaluate(record);
  }
  serialize(): ValueNode {
    return { type: "cond", test: this.test.serialize(), then: this.then.serialize(), otherwise: this.otherwise.serialize() };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.cond(this.test, this.then, this.otherwise);
  }
}

class Switch implements ValueExpr {
  constructor(
    readonly branches: ReadonlyArray<{ when: ValueExpr; then: ValueExpr }>,
    readonly otherwise: ValueExpr
  ) {}
  evaluate(record: JsonObject): JsonValue {
    for (const branch of this.branches) {
      if (truthy(branch.when.evaluate(record))) return branch.then.evaluate(record);
    }
    return this.otherwise.evaluate(record);
  }
  serialize(): ValueNode {
    return {
      type: "switch",
      branches: this.branches.map((b) => ({ when: b.when.serialize(), then: b.then.serialize() })),
      otherwise: this.otherwise.serialize()
    };
  }
  compile<R>(visitor: ValueVisitor<R>): R {
    return visitor.switch(this.branches, this.otherwise);
  }
}

// --- builders -------------------------------------------------------------------------------

/** Anything usable where a value expression is expected: an expression, or a raw literal. */
export type ValueInput = ValueExpr | JsonValue;

export function isValueExpr(value: unknown): value is ValueExpr {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ValueExpr).evaluate === "function" &&
    typeof (value as ValueExpr).compile === "function"
  );
}

export function toValueExpr(input: ValueInput): ValueExpr {
  return isValueExpr(input) ? input : new Lit(input);
}

export const field = (path: string): ValueExpr => new Field(path);
export const lit = (value: JsonValue): ValueExpr => new Lit(value);
export const add = (...inputs: ValueInput[]): ValueExpr => new Arith("+", inputs.map(toValueExpr));
export const sub = (a: ValueInput, b: ValueInput): ValueExpr => new Arith("-", [toValueExpr(a), toValueExpr(b)]);
export const mul = (...inputs: ValueInput[]): ValueExpr => new Arith("*", inputs.map(toValueExpr));
export const div = (a: ValueInput, b: ValueInput): ValueExpr => new Arith("/", [toValueExpr(a), toValueExpr(b)]);
export const mod = (a: ValueInput, b: ValueInput): ValueExpr => new Arith("%", [toValueExpr(a), toValueExpr(b)]);
export const neg = (a: ValueInput): ValueExpr => new Neg(toValueExpr(a));
export const concat = (...inputs: ValueInput[]): ValueExpr => new Concat(inputs.map(toValueExpr));
export const coalesce = (...inputs: ValueInput[]): ValueExpr => new Coalesce(inputs.map(toValueExpr));

/**
 * Extract a date component (`year`, `month`, …) from an epoch-ms value expression. UTC by default;
 * pass an IANA `timezone` (e.g. `"Europe/Berlin"`) to bucket by local wall-clock time (DST-aware).
 * A timezone runs on the in-memory reference and pushes down natively on Mongo; SQLite can't express
 * an IANA offset in `strftime` and rejects it (Postgres/MySQL already reduce date parts in memory).
 */
export const datePart = (part: DatePart, operand: ValueInput, timezone?: string): ValueExpr =>
  new DatePartExpr(part, toValueExpr(operand), timezone);
export const year = (operand: ValueInput, timezone?: string): ValueExpr => datePart("year", operand, timezone);
export const month = (operand: ValueInput, timezone?: string): ValueExpr => datePart("month", operand, timezone);
export const dayOfMonth = (operand: ValueInput, timezone?: string): ValueExpr => datePart("dayOfMonth", operand, timezone);
export const dayOfWeek = (operand: ValueInput, timezone?: string): ValueExpr => datePart("dayOfWeek", operand, timezone);
export const hour = (operand: ValueInput, timezone?: string): ValueExpr => datePart("hour", operand, timezone);
/** Format an epoch-ms date — `dateToString(field("createdAt"), "%Y-%m-%d")`. Tokens: `%Y %m %d %H %M %S %%`. Optional IANA `timezone`. */
export const dateToString = (operand: ValueInput, format: string, timezone?: string): ValueExpr =>
  new DateToStringExpr(format, toValueExpr(operand), timezone);

// Boolean-valued builders + conditionals (for `cond`/`switch`). `cmp` is the value-level peer of the
// filter comparators; `allOf`/`anyOf`/`negate` combine conditions; named so they don't shadow the
// filter-level `and`/`or`/`not`.
/** Boolean comparison of two values — `cmp(field("level"), "=", "beginner")`. */
export const cmp = (left: ValueInput, op: Comparator, right: ValueInput): ValueExpr =>
  new VCompare(op, toValueExpr(left), toValueExpr(right));
export const allOf = (...conditions: ValueInput[]): ValueExpr => new VAnd(conditions.map(toValueExpr));
export const anyOf = (...conditions: ValueInput[]): ValueExpr => new VOr(conditions.map(toValueExpr));
export const negate = (condition: ValueInput): ValueExpr => new VNot(toValueExpr(condition));
/** If `test` is truthy yield `then`, else `otherwise` — `cond(cmp(field("n"), ">", 0), 1, 0)`. */
export const cond = (test: ValueInput, then: ValueInput, otherwise: ValueInput): ValueExpr =>
  new Cond(toValueExpr(test), toValueExpr(then), toValueExpr(otherwise));
/** First matching branch's value, else `otherwise` — `switchExpr([[cond1, v1], [cond2, v2]], dflt)`. */
export const switchExpr = (
  branches: ReadonlyArray<[when: ValueInput, then: ValueInput]>,
  otherwise: ValueInput
): ValueExpr =>
  new Switch(
    branches.map(([when, then]) => ({ when: toValueExpr(when), then: toValueExpr(then) })),
    toValueExpr(otherwise)
  );

/** Rehydrate a value expression from its serialized node (used by `Expression.parse`). */
export function parseValue(node: ValueNode): ValueExpr {
  switch (node.type) {
    case "field":
      return new Field(node.path);
    case "lit":
      return new Lit(node.value);
    case "arith":
      return new Arith(node.op, node.operands.map(parseValue));
    case "neg":
      return new Neg(parseValue(node.operand));
    case "concat":
      return new Concat(node.operands.map(parseValue));
    case "coalesce":
      return new Coalesce(node.operands.map(parseValue));
    case "datepart":
      return new DatePartExpr(node.part, parseValue(node.operand), node.timezone);
    case "datestring":
      return new DateToStringExpr(node.format, parseValue(node.operand), node.timezone);
    case "vcompare":
      return new VCompare(node.op, parseValue(node.left), parseValue(node.right));
    case "vand":
      return new VAnd(node.operands.map(parseValue));
    case "vor":
      return new VOr(node.operands.map(parseValue));
    case "vnot":
      return new VNot(parseValue(node.operand));
    case "cond":
      return new Cond(parseValue(node.test), parseValue(node.then), parseValue(node.otherwise));
    case "switch":
      return new Switch(
        node.branches.map((b) => ({ when: parseValue(b.when), then: parseValue(b.then) })),
        parseValue(node.otherwise)
      );
  }
}

function num(value: JsonValue): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function applyArith(op: ArithOp, a: number, b: number): number {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? 0 : a / b;
    case "%":
      return b === 0 ? 0 : a % b;
  }
}
