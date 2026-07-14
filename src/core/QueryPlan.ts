import type { JsonValue, SortKey, Paging } from "./types.ts";

/**
 * The serialized form of an Expression AST node — the query half of the wire protocol
 * (ARCHITECTURE.md §4). It is produced by `Expression#stringify()` and rehydrated by
 * `Expression.parse()`. Backends either compile this to a native query or evaluate it
 * in memory via the fallback `match()`.
 *
 * This mirrors the legacy `src/Expression/*` shapes; the runtime classes will be ported
 * to TS in roadmap step 3 and implement `compile(visitor)` against these tags.
 */
export type ExpressionNode =
  | { type: "all" }
  | { type: "compare"; property: string; comparator: Comparator; value: JsonValue }
  | { type: "in"; property: string; values: JsonValue[] }
  // The value at `property` is NOT one of `values` (an absent/missing field matches, like Mongo `$nin`).
  | { type: "nin"; property: string; values: JsonValue[] }
  | { type: "contains"; property: string; value: JsonValue }
  | { type: "between"; property: string; lowerEnd: JsonValue; upperEnd: JsonValue }
  // Field presence: `shouldExist` true matches when the path is present (a null value counts as
  // present, matching Mongo `$exists`), false matches when it is absent. Compiles to Mongo
  // `$exists` / SQL `json_type(...) IS [NOT] NULL`, or a presence check in memory.
  | { type: "exists"; property: string; shouldExist: boolean }
  // Null-or-absent test: `negated` false matches when the value at `property` is null OR the path is
  // absent (the reference's `getPath(...) == null`); `negated` true matches a present, non-null value.
  // The one predicate that agrees across engines for null-or-absent — compiles to SQL `IS [NOT] NULL`
  // on a real column, Mongo `{field:null}` / `{$ne:null}`, or a `== null` check in memory.
  | { type: "isNull"; property: string; negated: boolean }
  // Array-length predicate: the value at `property` is an array of exactly `length` elements.
  // Compiles to Mongo `$size` / SQL `json_array_length`, or an array-length check in memory.
  | { type: "size"; property: string; length: number }
  // String match: the string at `property` starts with / ends with / contains `value`. Case
  // insensitivity is ASCII-only by design, so every engine agrees exactly — in memory (ASCII-lower),
  // SQL (`instr`/`substr` over `lower()`, which is ASCII in stock SQLite), and Mongo (an ASCII
  // character-class regex, not Unicode `$options:"i"`). Full Unicode/diacritic folding is a raw escape.
  | { type: "textmatch"; property: string; value: string; mode: TextMode; caseInsensitive: boolean }
  // A comparison between two *computed* value expressions (ARCHITECTURE.md §11), e.g.
  // `price * qty > 100`. Compiles to Mongo `$expr` / SQL arithmetic, or evaluates in memory.
  | { type: "expr"; left: ValueNode; comparator: Comparator; right: ValueNode }
  // "any element of the array at `property` matches `predicate`" — for embedded/array fields.
  // Compiles to Mongo `$elemMatch` / SQL `json_each` EXISTS, or any-element evaluation in memory.
  | { type: "any"; property: string; predicate: ExpressionNode }
  | { type: "not"; expression: ExpressionNode }
  | { type: "and"; expressions: ExpressionNode[] }
  | { type: "or"; expressions: ExpressionNode[] };

export type Comparator = "=" | "!=" | ">" | "<" | ">=" | "<=";

/** Where the match value must sit within the field's string. */
export type TextMode = "prefix" | "suffix" | "substring";

export type ArithOp = "+" | "-" | "*" | "/" | "%";

/**
 * A component extracted from a date (UTC). Dates are stored as epoch milliseconds, so every backend
 * extracts from the same representation; `month`/`dayOfMonth`/`hour` follow Mongo's 1-based month and
 * `dayOfWeek` is 1 (Sunday)–7 (Saturday), so the three engines agree.
 */
export type DatePart = "year" | "month" | "dayOfMonth" | "dayOfWeek" | "hour" | "minute" | "second";

/**
 * The serialized form of a scalar-valued (value) expression — field references and computed
 * values that can appear inside filters, projections, and aggregates (ARCHITECTURE.md §11). Each
 * has in-memory reference semantics and a per-backend compilation (Mongo aggregation expression,
 * SQL arithmetic), with a scan fallback where neither applies.
 */
export type ValueNode =
  | { type: "field"; path: string }
  | { type: "lit"; value: JsonValue }
  | { type: "arith"; op: ArithOp; operands: ValueNode[] }
  | { type: "neg"; operand: ValueNode }
  | { type: "concat"; operands: ValueNode[] }
  | { type: "coalesce"; operands: ValueNode[] }
  // Boolean-valued nodes — usable as the condition of `cond`/`switch`. They evaluate to a boolean
  // and compile to aggregation booleans (`$eq`/`$and`/…) / SQL boolean expressions, so a condition
  // can live *inside* a value expression (which the query-filter `Expression` form cannot).
  | { type: "vcompare"; op: Comparator; left: ValueNode; right: ValueNode }
  | { type: "vand"; operands: ValueNode[] }
  | { type: "vor"; operands: ValueNode[] }
  | { type: "vnot"; operand: ValueNode }
  // Conditional value selection: `cond` is if/then/else; `switch` is the first matching branch's
  // value, else `otherwise`. Compile to Mongo `$cond`/`$switch` / SQL `CASE WHEN`.
  | { type: "cond"; test: ValueNode; then: ValueNode; otherwise: ValueNode }
  | { type: "switch"; branches: { when: ValueNode; then: ValueNode }[]; otherwise: ValueNode }
  // A date component (UTC) extracted from an epoch-ms operand. Compiles to Mongo `$year`/… over
  // `$toDate` / SQL `strftime`, or `new Date(ms).getUTC*()` in memory.
  | { type: "datepart"; part: DatePart; operand: ValueNode; timezone?: string }
  // Format an epoch-ms date (UTC) with a strftime-style pattern restricted to the tokens common to
  // Mongo `$dateToString` and SQL `strftime` (`%Y %m %d %H %M %S %%`), so all engines agree.
  | { type: "datestring"; format: string; operand: ValueNode; timezone?: string };

/**
 * A fully-described read request. Sorting and paging are first-class so they are either
 * pushed down by the backend or applied by the planner — never silently dropped
 * (see ARCHITECTURE.md §3).
 */
export interface QueryPlan {
  /** Logical model name (maps to table / collection / object-store / key prefix). */
  model: string;
  /** The filter AST; `{ type: "all" }` matches everything. */
  where: ExpressionNode;
  order: SortKey[];
  paging: Paging;
  /**
   * Optional projection: top-level field names to return (always implicitly includes `uuid`).
   * `undefined` returns the whole record. A backend honours this natively (Mongo projection, SQL
   * `json_object`) to trim payload — but it is only an optimization; returning extra fields is
   * still correct because the caller projects again.
   */
  project?: string[];
}

/** The reductions an aggregate stage can request (ARCHITECTURE.md §11). */
export type AggregateOp = "count" | "countDistinct" | "sum" | "avg" | "min" | "max";

/** One named reduction in an `AggregatePlan`: `op` over the (optional) value expression. */
export interface AggregateStage {
  /** Output key in each result row's `values`. */
  name: string;
  op: AggregateOp;
  /** Serialized value expression to reduce over; omitted for `count` (which counts rows). */
  value?: ValueNode;
}

/**
 * A fully-described aggregate request (the §11 push-down peer of `QueryPlan`): filter, group keys,
 * and named reductions. `groupBy` empty means a single global aggregate. A backend compiles this to
 * `$group` / `GROUP BY`; backends that can't simply don't implement the capability and the engine
 * reduces in memory instead — identical result, only the performance differs.
 */
export interface AggregatePlan {
  model: string;
  where: ExpressionNode;
  /**
   * Group-key value expressions; `[]` is a single global aggregate over the whole filtered set. A
   * plain field is just `{ type: "field", path }`, but any value expression works — e.g.
   * `year(field("createdAt"))` for monthly/yearly buckets — so grouping pushes down too.
   */
  groupBy: ValueNode[];
  aggregates: AggregateStage[];
}

/** One row of an aggregate result: the group-key values (parallel to `groupBy`) and the reductions. */
export interface AggregateResultRow {
  /** Group-key values in `groupBy` order; `[]` for a global aggregate. */
  key: JsonValue[];
  /** Reduction results keyed by `AggregateStage.name`. */
  values: Record<string, number>;
}

/** A ranking window function evaluated per partition (SQL `OVER (…)`, Mongo `$setWindowFields`). */
export type WindowFnKind = "rowNumber" | "rank" | "denseRank";

/** One named window column: `rowNumber`/`rank`/`denseRank` over the plan's partition + order. */
export interface WindowFn {
  /** Output column name merged into each row. */
  name: string;
  kind: WindowFnKind;
}

/**
 * A window request (the §11 push-down peer of `AggregatePlan` for *ranking*): filter, partition keys,
 * and an order, plus the ranking columns to compute per partition. Unlike an aggregate it returns the
 * full rows (not one row per group), each annotated with the window columns — SQL `ROW_NUMBER()/RANK()
 * OVER (PARTITION BY … ORDER BY …)`. A backend that can't push it down omits the capability and the
 * engine computes it over the fetched set instead (identical result, only the performance differs).
 */
export interface WindowPlan {
  model: string;
  where: ExpressionNode;
  /** Partition-key value expressions; `[]` ranks the whole filtered set as one partition. */
  partitionBy: ValueNode[];
  /** Order within each partition — the ranking order (ties share a rank). */
  order: SortKey[];
  functions: WindowFn[];
}
