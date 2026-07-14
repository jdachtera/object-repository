import type { QueryPlan, AggregatePlan, AggregateResultRow, WindowPlan, WindowFn, WindowFnKind, ExpressionNode } from "../core/QueryPlan.ts";
import type { JsonObject, JsonValue, Paging, SortKey, Uuid } from "../core/types.ts";
import type { Expression } from "../expressions/Expression.ts";
import { all, and, or, eq, gt, lt } from "../expressions/builders.ts";
import { field, type ValueExpr } from "../expressions/values.ts";
import { computeWindow } from "../expressions/windowReduce.ts";
import { parseMongoFilter, type MongoFilter } from "../expressions/mongoFilter.ts";
import { liveQuery } from "./liveQuery.ts";
import { AGGREGATORS, type AggregateExpr, type Aggregators } from "./aggregate.ts";
import { projectValue, type InferSelection, type Selection } from "./projection.ts";
import type { Where } from "./where.ts";

/** Above this many rows, an in-memory aggregate is flagged (the "no silent O(n)" rule, §11). */
const IN_MEMORY_AGGREGATE_WARN_THRESHOLD = 50_000;

/** Per-read options that stay off the serializable `QueryPlan` (a Repository-execution concern). */
export interface ReadOptions {
  /** Include soft-deleted rows (default: excluded on a soft-delete model). */
  includeDeleted?: boolean;
}

/** What a `QueryCollection` needs from its repository to execute a plan. */
export interface Queryable<T> {
  readonly modelName: string;
  runQuery(plan: QueryPlan, options?: ReadOptions): Promise<T[]>;
  runQueryUuids(plan: QueryPlan, options?: ReadOptions): Promise<Uuid[]>;
  runCount(plan: QueryPlan, options?: ReadOptions): Promise<number>;
  /** Fetch rows projecting/loading only what `selection` references (projection-driven). */
  runProject(plan: QueryPlan, selection: Selection, options?: ReadOptions): Promise<unknown[]>;
  /** Push a grouped aggregate down to the backend; `null` if it can't (caller reduces in memory). */
  runAggregate(plan: AggregatePlan, options?: ReadOptions): Promise<AggregateResultRow[] | null>;
  /** Push a ranking window down to the backend (rows + window columns); `null` if it can't. */
  runWindow(plan: WindowPlan, options?: ReadOptions): Promise<unknown[] | null>;
  /** Encode a scalar property's runtime value to its stored (comparable) form — for keyset cursors. */
  encodeKey(property: string, value: unknown): JsonValue;
  /**
   * Register a listener fired after a committed change to this model. `options.where` scopes it: the
   * listener fires only when the changed record matches that filter before or after the write (omit to
   * fire on every change). The hook `liveQuery`/`subscribe` re-run on. Returns an unsubscribe.
   */
  subscribeChanges(listener: () => void, options?: { where?: ExpressionNode }): () => void;
}

/** One ranking window column descriptor (from the `windowed` builder). */
export interface WindowFnDescriptor {
  kind: WindowFnKind;
}

/** The factory handed to `windowed` — `w => ({ rank: w.rank(), n: w.rowNumber() })`. */
export interface WindowFunctions {
  /** Sequential 1,2,3… within the partition (ties broken by input order). */
  rowNumber(): WindowFnDescriptor;
  /** 1,1,3 — tied rows share a rank, then a gap. */
  rank(): WindowFnDescriptor;
  /** 1,1,2 — tied rows share a rank, no gap. */
  denseRank(): WindowFnDescriptor;
}

const WINDOW_FNS: WindowFunctions = {
  rowNumber: () => ({ kind: "rowNumber" }),
  rank: () => ({ kind: "rank" }),
  denseRank: () => ({ kind: "denseRank" })
};

/** One page of a keyset (cursor) traversal. `nextCursor` is null once the end is reached. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * An immutable, chainable query builder (ARCHITECTURE.md §3). Each method returns a new
 * collection, so a base query can be branched without shared mutation. `list()`/`listUuids()`
 * build a `QueryPlan` and hand it to the repository.
 */
export class QueryCollection<T> {
  constructor(
    private readonly source: Queryable<T>,
    private readonly expression: Expression = all(),
    private readonly order: readonly SortKey[] = [],
    private readonly paging: Paging = { start: 0 },
    private readonly includeDeletedFlag = false
  ) {}

  /** The per-read options this collection carries (currently just the soft-delete inclusion flag). */
  private opts(): ReadOptions {
    return { includeDeleted: this.includeDeletedFlag };
  }

  /** Narrow with an additional filter (AND-combined with any existing filter). */
  filter(expression: Expression): QueryCollection<T> {
    const combined =
      this.expression.serialize().type === "all" ? expression : and(this.expression, expression);
    return new QueryCollection(this.source, combined, this.order, this.paging, this.includeDeletedFlag);
  }

  /** Include soft-deleted rows in the results (a no-op on a model without soft-delete). */
  includeDeleted(): QueryCollection<T> {
    return new QueryCollection(this.source, this.expression, this.order, this.paging, true);
  }

  /**
   * Narrow with a **typed** Mongo-shaped filter — `where({ age: { $gte: 18 }, "sub.tier": "gold" })`.
   * Field names and operator value types are checked against the model (top-level *and* dotted paths
   * into `embedded()` subdocuments), the type-safe alternative to the stringly-typed `filter(eq(…))`.
   * Compiles to the same AST as the Mongo compat facade.
   */
  where(filter: Where<T>): QueryCollection<T> {
    return this.filter(parseMongoFilter(filter as MongoFilter));
  }

  /** Append a sort key (checked against the model's fields). */
  sort(property: keyof T & string, descending = false): QueryCollection<T> {
    return new QueryCollection(this.source, this.expression, [...this.order, { property, descending }], this.paging, this.includeDeletedFlag);
  }

  /** Restrict to a `[start, end)` window. */
  slice(start: number, end?: number): QueryCollection<T> {
    // `start`/`end` become a SQL OFFSET/LIMIT that is inlined (not a bound param), so reject a
    // non-integer window here — the friendly early error for an untrusted/stringly-typed offset.
    if (!Number.isInteger(start) || start < 0) {
      throw new Error(`slice(start) must be a non-negative integer, got ${JSON.stringify(start)}`);
    }
    if (end !== undefined && (!Number.isInteger(end) || end < start)) {
      throw new Error(`slice(end) must be an integer >= start, got ${JSON.stringify(end)}`);
    }
    return new QueryCollection(this.source, this.expression, this.order, { start, end }, this.includeDeletedFlag);
  }

  /**
   * Keyset (cursor) pagination — the O(1)-seek alternative to `slice()`'s `OFFSET`. Instead of
   * skipping rows, it seeks past the last row of the previous page with a `WHERE (sortKeys, uuid) >
   * cursor` predicate that pushes down like any other filter (so it uses an index rather than
   * counting past the offset). `uuid` is appended as a tiebreaker for a total, stable order.
   *
   *   let page = await users.sort("age").page({ limit: 20 });
   *   while (page.hasMore) page = await users.sort("age").page({ limit: 20, after: page.nextCursor! });
   *
   * The cursor is an opaque token bound to this query's ordering; reusing it under a different `sort`
   * throws. Ignores any prior `slice()`. Sort keys should be non-null (the `uuid` tiebreaker keeps the
   * order total even when the other keys tie).
   */
  async page(options: { limit: number; after?: string | null }): Promise<Page<T>> {
    const { limit } = options;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("page(): `limit` must be a positive integer");

    // Effective order = the declared keys plus a uuid tiebreaker, so the traversal is deterministic.
    const keys: SortKey[] = [...this.order, { property: "uuid", descending: false }];
    const signature = keys.map((k) => `${k.property}:${k.descending ? "desc" : "asc"}`).join(",");

    let where = this.expression;
    if (options.after) {
      const cursor = JSON.parse(options.after) as { o: string; v: JsonValue[] };
      if (cursor.o !== signature) throw new Error("page(): cursor does not match this query's ordering");
      const seek = keysetAfter(keys, cursor.v);
      where = where.serialize().type === "all" ? seek : and(where, seek);
    }

    // Fetch one extra row to detect a further page without a separate count.
    const fetched = await this.source.runQuery({
      model: this.source.modelName,
      where: where.serialize(),
      order: keys,
      paging: { start: 0, end: limit + 1 }
    }, this.opts());
    const hasMore = fetched.length > limit;
    const items = hasMore ? fetched.slice(0, limit) : fetched;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? JSON.stringify({ o: signature, v: keys.map((k) => this.keyValue(last, k.property)) })
        : null;
    return { items, nextCursor, hasMore };
  }

  /** The stored value of `property` on `row` (uuid passes through; scalars go through the codec). */
  private keyValue(row: T, property: string): JsonValue {
    const value = (row as Record<string, unknown>)[property];
    return property === "uuid" ? String(value) : this.source.encodeKey(property, value);
  }

  toPlan(): QueryPlan {
    return {
      model: this.source.modelName,
      where: this.expression.serialize(),
      order: [...this.order],
      paging: this.paging
    };
  }

  list(): Promise<T[]> {
    return this.source.runQuery(this.toPlan(), this.opts());
  }

  listUuids(): Promise<Uuid[]> {
    return this.source.runQueryUuids(this.toPlan(), this.opts());
  }

  async each(callback: (item: T, index: number) => void): Promise<T[]> {
    const items = await this.list();
    items.forEach(callback);
    return items;
  }

  /**
   * Subscribe to this query's results *reactively*: `onResult` fires with the current rows once loaded,
   * then again after every committed change to the model (a local write, or one over the change feed).
   * Returns an unsubscribe. Ergonomic sugar over {@link liveQuery} — for framework binding
   * (`useSyncExternalStore` / Solid `from`), prefer `liveQuery(collection)` directly.
   */
  subscribe(onResult: (rows: T[]) => void, onError?: (error: unknown) => void): () => void {
    const live = liveQuery(this);
    return live.subscribe(() => {
      const snapshot = live.getSnapshot();
      if (snapshot.error !== undefined) onError?.(snapshot.error);
      else if (snapshot.data !== undefined) onResult(snapshot.data);
    });
  }

  /**
   * Register a listener fired after a committed change to this query's model that can actually affect
   * this query — the low-level hook {@link liveQuery} re-runs on. It forwards this query's own filter as
   * the relevance scope, so a write to a row outside the filter (before and after) doesn't wake it.
   * Returns an unsubscribe. Most code should use `liveQuery`/`subscribe` instead of wiring this directly.
   */
  subscribeChanges(listener: () => void): () => void {
    return this.source.subscribeChanges(listener, { where: this.toPlan().where });
  }

  // --- advanced query stages (ARCHITECTURE.md §11) -------------------------------------------
  //
  // These run the reference (in-memory) semantics over the filtered set. `select` is row-shaped so
  // it honours order + paging; `count`/`aggregate`/`groupBy`/`distinct` operate on the whole
  // filtered set (paging applies to listings, not aggregates). Push-down to capable backends is the
  // future optimization — the result is identical either way.

  /**
   * Project rows through a nestable selection object (typed). Respects order + paging.
   * `select({ ref: true, total: mul(field("price"), field("qty")), customer: { name: true } })`
   * yields `{ ref; total; customer: { name } | null }[]`.
   */
  async select<S extends Selection>(spec: S): Promise<InferSelection<T, S>[]> {
    // Projection-driven: only the fields/relations the selection references are fetched/loaded.
    const rows = await this.source.runProject(this.toPlan(), spec, this.opts());
    return rows.map((row) => projectValue(row, spec) as InferSelection<T, S>);
  }

  /** Count matching rows (pushed down to the backend when it supports a native count). */
  count(): Promise<number> {
    return this.source.runCount({
      model: this.source.modelName,
      where: this.expression.serialize(),
      order: [],
      paging: { start: 0 }
    }, this.opts());
  }

  /** Distinct values of a field, in first-seen order. */
  async distinct<K extends keyof T>(key: K): Promise<T[K][]> {
    const seen = new Set<unknown>();
    const values: T[K][] = [];
    for (const row of await this.fetchAll()) {
      const value = row[key];
      if (!seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
    return values;
  }

  /**
   * Compute named aggregates over the filtered set: `aggregate(a => ({ n: a.count(), avg: a.avg("age") }))`.
   * Pushed down to a capable backend (`$group` / `GROUP BY`); otherwise reduced in memory — identical
   * result either way (ARCHITECTURE.md §11).
   */
  async aggregate<A extends Record<string, AggregateExpr<T>>>(
    build: (aggregators: Aggregators<T>) => A
  ): Promise<{ [K in keyof A]: number }> {
    const spec = build(AGGREGATORS as Aggregators<T>);
    const pushed = await this.source.runAggregate(this.aggregatePlan([], spec), this.opts());
    // A global aggregate yields one row; an empty store yields no rows → reference zeros over [].
    if (pushed) return pushed.length ? pickValues(spec, pushed[0]!.values) : applyAggregates(spec, []);

    const rows = await this.fetchAll();
    this.warnIfUnbounded(rows.length);
    return applyAggregates(spec, rows);
  }

  /**
   * Group rows by a field and compute named aggregates per group. Pushed down to a capable backend,
   * else grouped + reduced in memory (the reference semantics) — same result (ARCHITECTURE.md §11).
   */
  async groupBy<K extends keyof T, A extends Record<string, AggregateExpr<T>>>(
    key: K,
    build: (aggregators: Aggregators<T>) => A
  ): Promise<Array<{ key: T[K] } & { [N in keyof A]: number }>> {
    const groups = await this.groupByKeys([field(String(key))], build);
    return groups.map(({ key: keyValues, values }) => ({ key: keyValues[0] as T[K], ...values }));
  }

  /**
   * Group by a computed value expression — `groupByExpr(year(field("createdAt")), a => ({ n: a.count() }))`
   * for time buckets. Same push-down / in-memory-reference contract as `groupBy`; the key is whatever
   * the expression evaluates to.
   */
  async groupByExpr<A extends Record<string, AggregateExpr<T>>>(
    keyExpr: ValueExpr,
    build: (aggregators: Aggregators<T>) => A
  ): Promise<Array<{ key: JsonValue } & { [N in keyof A]: number }>> {
    const groups = await this.groupByKeys([keyExpr], build);
    return groups.map(({ key, values }) => ({ key: key[0] ?? null, ...values }));
  }

  /**
   * Group by several keys at once (fields or value expressions) — `groupByMany([field("provider"),
   * field("plan")], …)` or `[year(field("ts")), month(field("ts"))]` for month buckets. The `key` of
   * each group is the array of key values, parallel to the inputs.
   */
  async groupByMany<A extends Record<string, AggregateExpr<T>>>(
    keys: ValueExpr[],
    build: (aggregators: Aggregators<T>) => A
  ): Promise<Array<{ key: JsonValue[] } & { [N in keyof A]: number }>> {
    const groups = await this.groupByKeys(keys, build);
    return groups.map(({ key, values }) => ({ key, ...values }));
  }

  /**
   * Ranking window functions over a partition — the portable `$setWindowFields` / SQL `OVER (…)`. The
   * collection's `.sort(…)` is the ranking order; `partitionBy` names the field(s) that reset the
   * ranking. Each row comes back with the named window columns merged in:
   *
   *   // the user's rank by practice count (their first payment, top-per-group, running position…)
   *   const ranked = await events.all().sort("practiceCount", true)
   *     .windowed({ partitionBy: "day" }, (w) => ({ rank: w.rank(), n: w.rowNumber() }));
   *   // ranked: Array<Event & { rank: number; n: number }>
   *
   * Pushes down to `ROW_NUMBER()/RANK()/DENSE_RANK() OVER (PARTITION BY … ORDER BY …)` on capable SQL
   * backends; otherwise the filtered set is fetched and ranked in memory (identical result).
   */
  async windowed<W extends Record<string, WindowFnDescriptor>>(
    spec: { partitionBy?: string | readonly string[] },
    build: (fns: WindowFunctions) => W
  ): Promise<Array<T & { [N in keyof W]: number }>> {
    const built = build(WINDOW_FNS);
    const functions: WindowFn[] = Object.entries(built).map(([name, d]) => ({ name, kind: d.kind }));
    const partitionFields = spec.partitionBy === undefined ? [] : Array.isArray(spec.partitionBy) ? [...spec.partitionBy] : [spec.partitionBy as string];
    const plan: WindowPlan = {
      model: this.source.modelName,
      where: this.expression.serialize(),
      partitionBy: partitionFields.map((f) => field(f).serialize()),
      order: [...this.order],
      functions
    };

    const pushed = await this.source.runWindow(plan, this.opts());
    if (pushed) return pushed as Array<T & { [N in keyof W]: number }>;

    const rows = await this.fetchAll();
    this.warnIfUnbounded(rows.length);
    return computeWindow(plan, rows as unknown as JsonObject[]) as unknown as Array<T & { [N in keyof W]: number }>;
  }

  /** Shared engine for all the group-by variants: push down if possible, else group in memory. */
  private async groupByKeys<A extends Record<string, AggregateExpr<T>>>(
    keys: ValueExpr[],
    build: (aggregators: Aggregators<T>) => A
  ): Promise<Array<{ key: JsonValue[]; values: { [N in keyof A]: number } }>> {
    const spec = build(AGGREGATORS as Aggregators<T>);

    const pushed = await this.source.runAggregate(this.aggregatePlan(keys, spec), this.opts());
    if (pushed) return pushed.map((row) => ({ key: row.key, values: pickValues(spec, row.values) }));

    const rows = await this.fetchAll();
    this.warnIfUnbounded(rows.length);

    // Bucket by the evaluated key tuple, hashed so object/scalar keys dedupe the same way the
    // backends' GROUP BY / $group do.
    const buckets = new Map<string, { key: JsonValue[]; rows: T[] }>();
    for (const row of rows) {
      const key = keys.map((keyExpr) => keyExpr.evaluate(row as JsonObject));
      const hash = JSON.stringify(key.map((value) => value ?? null));
      const bucket = buckets.get(hash) ?? { key, rows: [] };
      bucket.rows.push(row);
      buckets.set(hash, bucket);
    }
    return [...buckets.values()].map(({ key, rows: bucket }) => ({ key, values: applyAggregates(spec, bucket) }));
  }

  /** Build the push-down plan from this collection's filter + group keys + an aggregate spec. */
  private aggregatePlan(groupBy: ValueExpr[], spec: Record<string, AggregateExpr<T>>): AggregatePlan {
    return {
      model: this.source.modelName,
      where: this.expression.serialize(),
      groupBy: groupBy.map((keyExpr) => keyExpr.serialize()),
      aggregates: Object.entries(spec).map(([name, expr]) => ({
        name,
        op: expr.op,
        value: expr.value?.serialize()
      }))
    };
  }

  /** Fetch the full filtered set (filter + order, no paging) for aggregate-style operations. */
  private fetchAll(): Promise<T[]> {
    return this.source.runQuery({
      model: this.source.modelName,
      where: this.expression.serialize(),
      order: [...this.order],
      paging: { start: 0 }
    }, this.opts());
  }

  private warnIfUnbounded(rowCount: number): void {
    if (rowCount > IN_MEMORY_AGGREGATE_WARN_THRESHOLD) {
      // eslint-disable-next-line no-console
      console.warn(
        `[orm] aggregating ${rowCount} rows in memory on "${this.source.modelName}"; ` +
          `consider a backend that pushes the aggregate down.`
      );
    }
  }
}

/**
 * The strict "row is after the cursor" predicate for a lexicographic keyset order — expands
 * `(k1, k2, …) > (v1, v2, …)` to `k1 ▷ v1 OR (k1 = v1 AND (k2 ▷ v2 OR …))`, where `▷` is `>` for an
 * ascending key and `<` for a descending one. Built from plain comparators, so it pushes down.
 */
function keysetAfter(keys: readonly SortKey[], bounds: readonly JsonValue[]): Expression {
  const build = (i: number): Expression => {
    const key = keys[i]!;
    const bound = bounds[i]!;
    const strict = key.descending ? lt(key.property, bound) : gt(key.property, bound);
    if (i === keys.length - 1) return strict;
    return or(strict, and(eq(key.property, bound), build(i + 1)));
  };
  return build(0);
}

/** Reduce a spec over rows in memory (the reference path / fallback). */
function applyAggregates<T, A extends Record<string, AggregateExpr<T>>>(
  spec: A,
  rows: readonly T[]
): { [K in keyof A]: number } {
  const result = {} as { [K in keyof A]: number };
  for (const [name, expr] of Object.entries(spec) as Array<[keyof A, AggregateExpr<T>]>) {
    result[name] = expr.reduce(rows);
  }
  return result;
}

/** Shape a pushed-down result row's values into the typed `{ name: number }` the spec promises. */
function pickValues<A extends Record<string, unknown>>(
  spec: A,
  values: Record<string, number>
): { [K in keyof A]: number } {
  const result = {} as { [K in keyof A]: number };
  for (const name of Object.keys(spec) as Array<keyof A>) {
    result[name] = values[name as string] ?? 0;
  }
  return result;
}
