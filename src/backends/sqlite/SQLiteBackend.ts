import type {
  AggregatingBackend,
  Backend,
  ChangeEvent,
  ChangeListener,
  CountingBackend,
  IndexSpec,
  MultiPatchingBackend,
  PatchOp,
  PatchingBackend,
  PersistResult,
  PersistedChange,
  SchemaAwareBackend,
  Unsubscribe,
  UpsertingBackend
} from "../../core/Backend.ts";
import type { Capabilities, Context, JsonObject, JsonValue, SortKey, Uuid } from "../../core/types.ts";
import type { QueryPlan, Comparator, AggregatePlan, AggregateResultRow, AggregateStage, ExpressionNode, DatePart, TextMode, WindowPlan, WindowFnKind } from "../../core/QueryPlan.ts";
import { generateUuid } from "../../core/uuid.ts";
import type { Expression } from "../../expressions/Expression.ts";
import type { ExpressionVisitor } from "../../expressions/visitor.ts";
import type { ValueExpr, ValueVisitor } from "../../expressions/values.ts";
import { arithFragment, negFragment, concatFragment, coalesceFragment } from "../sql/valueSql.ts";
import { parse } from "../../expressions/parse.ts";
import { parseValue } from "../../expressions/values.ts";
import { asciiLower } from "../../expressions/nodes.ts";

/** A value the driver may return synchronously (embedded SQLite) or as a Promise (D1, Turso, WASM). */
export type Awaitable<T> = T | Promise<T>;

/** One write in an atomic batch — a statement plus its bound params. */
export interface SqliteWrite {
  sql: string;
  params: SqliteParam[];
}

/**
 * Minimal structural view of a SQLite driver, so the library never imports a concrete driver and stays
 * bundle-safe for every target. The caller injects the database. Every method may be **sync or async**
 * (`Awaitable`): a synchronous embedded driver (`node:sqlite` `DatabaseSync`, `better-sqlite3`) works
 * unchanged, and an asynchronous one (Cloudflare D1, Turso/libSQL, a WASM build) drops straight in —
 * the backend `await`s through the seam either way, so `await` on a plain value is just a free
 * microtask.
 *
 *   new SQLiteBackend(new DatabaseSync(":memory:"))   // embedded, sync driver
 *   new D1Backend(env.DB)                              // edge, async driver (a thin preset)
 */
export interface SqliteStatement {
  all(...params: SqliteParam[]): Awaitable<unknown[]>;
  run(...params: SqliteParam[]): Awaitable<unknown>;
}
export interface SqliteDatabase {
  exec(sql: string): Awaitable<void>;
  prepare(sql: string): SqliteStatement;
  /**
   * Run a set of writes atomically. Optional: when absent, the backend brackets them with
   * `BEGIN`/`COMMIT` via `exec` (correct on an interactive driver like `node:sqlite`). A batch-only
   * driver with no interactive transaction — Cloudflare D1 — provides this instead (mapping to
   * `db.batch(...)`), and the backend then never issues a bare `BEGIN`.
   */
  batchWrite?(writes: SqliteWrite[]): Awaitable<void>;
}
type SqliteParam = string | number | bigint | null | Uint8Array;

const CAPABILITIES: Capabilities = {
  indexes: true,
  ranges: true,
  sortPushdown: true,
  joins: false, // relations decompose-and-stitch above the backend; JOIN push-down is future
  transactions: true,
  changeFeed: true
};

/**
 * A compiling SQL backend over SQLite (ARCHITECTURE.md §3, §11). Records are stored as
 * `(uuid TEXT PRIMARY KEY, data JSON)`, and the expression AST compiles to a `WHERE` clause via
 * `json_extract`, with `ORDER BY` / `LIMIT` / `OFFSET` and `COUNT(*)` all pushed down to SQL —
 * including filtered counts, which is fuller push-down than the IndexedDB backend. Indexes from
 * property metadata become SQLite expression indexes.
 */
export class SQLiteBackend
  implements
    Backend,
    SchemaAwareBackend,
    CountingBackend,
    PatchingBackend,
    MultiPatchingBackend,
    UpsertingBackend,
    AggregatingBackend
{
  readonly capabilities = CAPABILITIES;

  private readonly db: SqliteDatabase;
  private readonly tables = new Set<string>();
  private saveQueue: PersistedChange[] = [];
  private removeQueue: PersistedChange[] = [];
  private readonly listeners = new Set<ChangeListener>();

  constructor(database: SqliteDatabase) {
    this.db = database;
  }

  async registerModel(model: string, indexes: IndexSpec[]): Promise<void> {
    await this.ensureTable(model);
    for (const index of indexes) {
      // SQLite does compound + direction + unique; TTL/text are Mongo-only and skipped. `where`
      // (partial) is skipped too — a full index stays correct, and SQLite's UNIQUE already treats
      // NULLs as distinct, which covers the "unique among present values" partial-unique case.
      if (index.text || index.ttlSeconds !== undefined) continue;
      const cols = index.fields.map((f) => `${jsonExtract(f.path)}${f.descending ? " DESC" : ""}`).join(", ");
      // Index names are developer-supplied and may contain characters that aren't valid in a bare SQL
      // identifier (e.g. a compound index named "songId-userId"); fold those to `_` before quoting.
      const name = ident(`${model}_${index.name}_idx`.replace(/[^A-Za-z0-9_]/g, "_"));
      await this.db.exec(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name} ON ${ident(model)} (${cols})`
      );
    }
  }

  async query(plan: QueryPlan, _ctx: Context): Promise<JsonObject[]> {
    await this.ensureTable(plan.model);
    const where = compile(plan.where);
    const sql =
      `SELECT ${selectExpr(plan.project)} AS data FROM ${ident(plan.model)} WHERE ${where.sql}` +
      orderClause(plan.order) +
      pagingClause(plan.paging);
    const rows = await this.db.prepare(sql).all(...coerce(where.params));
    return rows.map((row) => JSON.parse(String((row as { data: unknown }).data)) as JsonObject);
  }

  async queryUuids(plan: QueryPlan, _ctx: Context): Promise<Uuid[]> {
    await this.ensureTable(plan.model);
    const where = compile(plan.where);
    const sql =
      `SELECT uuid FROM ${ident(plan.model)} WHERE ${where.sql}` +
      orderClause(plan.order) +
      pagingClause(plan.paging);
    return (await this.db.prepare(sql).all(...coerce(where.params))).map((row) => String((row as { uuid: unknown }).uuid));
  }

  async count(plan: QueryPlan, _ctx: Context): Promise<number> {
    await this.ensureTable(plan.model);
    const where = compile(plan.where);
    const sql = `SELECT COUNT(*) AS n FROM ${ident(plan.model)} WHERE ${where.sql}`;
    const row = (await this.db.prepare(sql).all(...coerce(where.params)))[0] as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  async aggregate(plan: AggregatePlan, _ctx: Context): Promise<AggregateResultRow[]> {
    await this.ensureTable(plan.model);
    const where = compile(plan.where);
    // SELECT lists group columns first, then aggregate columns; params bind in that order, then the
    // WHERE params. `GROUP BY` uses ordinal positions so a computed key's params aren't bound twice.
    const groupParams: JsonValue[] = [];
    const groupCols = plan.groupBy.map((node, i) => {
      const sql = parseValue(node).compile(SQL_VALUES);
      groupParams.push(...sql.params);
      return `${sql.sql} AS g${i}`;
    });
    const aggParams: JsonValue[] = [];
    const aggCols = plan.aggregates.map((agg, i) => {
      const sql = aggregateSql(agg);
      aggParams.push(...sql.params);
      return `${sql.sql} AS a${i}`;
    });
    const groupBy = plan.groupBy.length
      ? ` GROUP BY ${plan.groupBy.map((_, i) => i + 1).join(", ")}`
      : "";
    const sql =
      `SELECT ${[...groupCols, ...aggCols].join(", ")} FROM ${ident(plan.model)} WHERE ${where.sql}` + groupBy;
    const rows = (await this.db
      .prepare(sql)
      .all(...coerce([...groupParams, ...aggParams, ...where.params]))) as Record<string, unknown>[];
    return rows.map((row) => ({
      key: plan.groupBy.map((_, i) => row[`g${i}`] as JsonValue),
      values: Object.fromEntries(plan.aggregates.map((agg, i) => [agg.name, Number(row[`a${i}`] ?? 0)]))
    }));
  }

  /** Ranking window functions via SQLite `OVER (…)` (3.25+); partition/order over `json_extract` values. */
  async window(plan: WindowPlan, _ctx: Context): Promise<JsonObject[] | null> {
    await this.ensureTable(plan.model);
    const where = compile(plan.where);
    const params: JsonValue[] = [];
    const partitionParts = plan.partitionBy.map((node) => {
      const s = parseValue(node).compile(SQL_VALUES);
      params.push(...s.params);
      return s.sql;
    });
    const orderParts = plan.order.map((k) => `${jsonExtract(k.property)} ${k.descending ? "DESC" : "ASC"}`);
    const over = `OVER (${partitionParts.length ? `PARTITION BY ${partitionParts.join(", ")}` : ""}${
      partitionParts.length && orderParts.length ? " " : ""
    }${orderParts.length ? `ORDER BY ${orderParts.join(", ")}` : ""})`;
    const winCols = plan.functions.map((fn, i) => `${SQLITE_WINDOW_FN[fn.kind]} ${over} AS w${i}`).join(", ");
    const sql = `SELECT data, ${winCols} FROM ${ident(plan.model)} WHERE ${where.sql}`;
    const rows = (await this.db.prepare(sql).all(...coerce([...params, ...where.params]))) as Record<string, unknown>[];
    return rows.map((row) => {
      const decoded = JSON.parse(String(row.data)) as JsonObject;
      plan.functions.forEach((fn, i) => (decoded[fn.name] = Number(row[`w${i}`] ?? 0)));
      return decoded;
    });
  }

  async patch(model: string, uuid: Uuid, ops: Record<string, PatchOp>, _ctx: Context): Promise<void> {
    await this.ensureTable(model);
    const update = patchDataExpr(ops);
    await this.db.prepare(`UPDATE ${ident(model)} SET data = ${update.expr} WHERE uuid = ?`).run(...update.params, uuid);
  }

  async upsert(model: string, where: ExpressionNode, set: JsonObject, setOnInsert: JsonObject, _ctx: Context): Promise<void> {
    await this.ensureTable(model);
    const w = compile(where);
    const readThenWrite = async () => {
      const found = (await this.db
        .prepare(`SELECT uuid FROM ${ident(model)} WHERE ${w.sql} LIMIT 1`)
        .all(...coerce(w.params)))[0] as { uuid: string } | undefined;
      if (found) {
        const { expr, params } = setFieldsExpr(set);
        await this.db.prepare(`UPDATE ${ident(model)} SET data = ${expr} WHERE uuid = ?`).run(...params, found.uuid);
      } else {
        const doc = { ...setOnInsert, ...set };
        await this.db.prepare(`INSERT INTO ${ident(model)} (uuid, data) VALUES (?, ?)`).run(String(doc.uuid), JSON.stringify(doc));
      }
    };
    if (this.db.batchWrite) {
      // A batch-only driver (D1) has no interactive transaction — read then write, not atomic against
      // a concurrent writer. Make the key `unique` so the store rejects a racing duplicate insert.
      await readThenWrite();
      return;
    }
    // `BEGIN IMMEDIATE` takes the write lock up front, so the read-then-write is atomic against other
    // writers (SQLite serializes writers) — no insert/update race.
    await this.db.exec("BEGIN IMMEDIATE");
    try {
      await readThenWrite();
      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async patchMany(model: string, where: ExpressionNode, ops: Record<string, PatchOp>, _ctx: Context): Promise<number> {
    await this.ensureTable(model);
    const update = patchDataExpr(ops);
    const w = compile(where);
    // SET params bind before WHERE params (they appear first in the statement).
    const result = await this.db
      .prepare(`UPDATE ${ident(model)} SET data = ${update.expr} WHERE ${w.sql}`)
      .run(...update.params, ...coerce(w.params));
    return Number((result as { changes?: number }).changes ?? 0);
  }

  save(model: string, record: JsonObject, _ctx: Context, dirty?: readonly string[]): void {
    // Just queue — tables are ensured in `persist` (an async driver can't be awaited from a sync
    // `save`). No column to scope down to (one JSON blob column, ARCHITECTURE.md §12), so `dirty` is
    // accepted for interface uniformity but unused; every write is a full-record replace.
    this.saveQueue.push({ model, record, dirty });
  }

  remove(model: string, record: JsonObject, _ctx: Context): void {
    this.removeQueue.push({ model, record });
  }

  async persist(_ctx: Context): Promise<PersistResult> {
    const saved = this.saveQueue;
    const removed = this.removeQueue;
    this.saveQueue = [];
    this.removeQueue = [];

    for (const change of saved) {
      if (typeof change.record.uuid !== "string" || change.record.uuid.length === 0) {
        change.record.uuid = generateUuid();
      }
    }
    for (const model of new Set([...saved, ...removed].map((c) => c.model))) await this.ensureTable(model);

    const writes: SqliteWrite[] = [];
    for (const change of saved) {
      writes.push({
        sql:
          `INSERT INTO ${ident(change.model)} (uuid, data) VALUES (?, ?) ` +
          `ON CONFLICT(uuid) DO UPDATE SET data = excluded.data`,
        params: [String(change.record.uuid), JSON.stringify(change.record)]
      });
    }
    for (const change of removed) {
      writes.push({ sql: `DELETE FROM ${ident(change.model)} WHERE uuid = ?`, params: [String(change.record.uuid)] });
    }
    await this.runAtomic(writes);

    for (const change of saved) {
      this.emit({ model: change.model, uuid: String(change.record.uuid), kind: "saved", record: change.record });
    }
    for (const change of removed) {
      this.emit({ model: change.model, uuid: String(change.record.uuid), kind: "removed" });
    }
    return { saved, removed };
  }

  /**
   * Run a set of writes atomically. A driver that provides `batchWrite` (D1) owns the atomicity
   * (`db.batch`); otherwise the writes are bracketed with `BEGIN`/`COMMIT` via `exec` (interactive
   * drivers like `node:sqlite`), rolling back on error.
   */
  private async runAtomic(writes: SqliteWrite[]): Promise<void> {
    if (writes.length === 0) return;
    if (this.db.batchWrite) {
      await this.db.batchWrite(writes);
      return;
    }
    await this.db.exec("BEGIN");
    try {
      for (const write of writes) await this.db.prepare(write.sql).run(...write.params);
      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  discardPending(): void {
    this.saveQueue = [];
    this.removeQueue = [];
  }

  changes(listener: ChangeListener, _ctx: Context): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async ensureTable(model: string): Promise<void> {
    if (this.tables.has(model)) return;
    await this.db.exec(`CREATE TABLE IF NOT EXISTS ${ident(model)} (uuid TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.tables.add(model);
  }
}

// --- SQL compilation (the ExpressionVisitor seam, ARCHITECTURE.md §3) -----------------------

interface Sql {
  sql: string;
  params: JsonValue[];
}

const SQL_OP: Record<Comparator, string> = {
  "=": "=",
  "!=": "<>",
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<="
};

class SqlVisitor implements ExpressionVisitor<Sql> {
  // `column` resolves a property to a SQL expression. At the top level it reads the `data` blob;
  // inside an `any` (json_each) it reads each array element via the `value` column.
  constructor(
    private readonly column: (property: string) => string = dataColumn,
    // Parallel to `column`, but yields a `json_type(...)` expression — used by `exists` to tell an
    // absent path (NULL type) apart from a present null value (`'null'` type).
    private readonly typeColumn: (property: string) => string = dataType
  ) {}

  all(): Sql {
    return { sql: "1=1", params: [] };
  }
  compare(property: string, comparator: Comparator, value: JsonValue): Sql {
    const col = this.column(property);
    // `!=` also matches a missing field (NULL), like the in-memory reference and Mongo `$ne`; a bare
    // `col <> ?` drops those rows under SQL 3-valued logic. (Ordering comparators exclude NULL, which
    // matches the reference too — see `relate`.)
    if (comparator === "!=") return { sql: `(${col} ${SQL_OP[comparator]} ? OR ${col} IS NULL)`, params: [value] };
    return { sql: `${col} ${SQL_OP[comparator]} ?`, params: [value] };
  }
  expr(left: ValueExpr, comparator: Comparator, right: ValueExpr): Sql {
    const l = left.compile(SQL_VALUES);
    const r = right.compile(SQL_VALUES);
    return { sql: `(${l.sql} ${SQL_OP[comparator]} ${r.sql})`, params: [...l.params, ...r.params] };
  }
  any(property: string, predicate: Expression): Sql {
    const sub = predicate.compile(new SqlVisitor(elementColumn, elementType));
    return {
      sql: `EXISTS (SELECT 1 FROM json_each(${this.column(property)}) WHERE ${sub.sql})`,
      params: sub.params
    };
  }
  in(property: string, values: JsonValue[]): Sql {
    if (values.length === 0) return { sql: "0=1", params: [] };
    return { sql: `${this.column(property)} IN (${values.map(() => "?").join(", ")})`, params: [...values] };
  }
  nin(property: string, values: JsonValue[]): Sql {
    if (values.length === 0) return { sql: "1=1", params: [] }; // nothing excluded → matches all
    // `NOT IN` is NULL (excluded) when the column is NULL; OR-ing `IS NULL` makes a missing field
    // match, as the in-memory reference does (`undefined` is not in the list).
    const col = this.column(property);
    return { sql: `(${col} IS NULL OR ${col} NOT IN (${values.map(() => "?").join(", ")}))`, params: [...values] };
  }
  contains(property: string, value: JsonValue): Sql {
    return {
      sql: `EXISTS (SELECT 1 FROM json_each(${this.column(property)}) WHERE value = ?)`,
      params: [value]
    };
  }
  between(property: string, lowerEnd: JsonValue, upperEnd: JsonValue): Sql {
    return { sql: `${this.column(property)} BETWEEN ? AND ?`, params: [lowerEnd, upperEnd] };
  }
  exists(property: string, shouldExist: boolean): Sql {
    // `json_type` is NULL only when the path is absent; a stored null yields `'null'`, so this
    // distinguishes present-but-null from missing, matching the in-memory and Mongo semantics.
    return { sql: `${this.typeColumn(property)} IS ${shouldExist ? "NOT NULL" : "NULL"}`, params: [] };
  }
  isNull(property: string, negated: boolean): Sql {
    // `json_extract` yields SQL NULL for BOTH an absent path and a stored JSON null, so `IS NULL`
    // is exactly the reference's null-or-absent `getPath(...) == null`.
    return { sql: `${this.column(property)} IS ${negated ? "NOT NULL" : "NULL"}`, params: [] };
  }
  size(property: string, length: number): Sql {
    // Guard on the JSON type so non-arrays / missing paths never match (e.g. `size 0` on a missing
    // field), matching Mongo `$size` (which only matches actual arrays of that length).
    return {
      sql: `(${this.typeColumn(property)} = 'array' AND json_array_length(${this.column(property)}) = ?)`,
      params: [length]
    };
  }
  textmatch(property: string, value: string, mode: TextMode, caseInsensitive: boolean): Sql {
    const col = this.column(property);
    if (value === "") return { sql: `typeof(${col}) = 'text'`, params: [] }; // empty matches any string
    // For case-insensitive, lower BOTH sides: stock SQLite `lower()` is ASCII-only, so it matches the
    // `asciiLower`-folded needle and the in-memory reference. The needle is a bound value (no LIKE
    // wildcards to escape) used with `instr`/`substr` — exact, literal substring matching.
    const target = caseInsensitive ? `lower(${col})` : col;
    const needle = caseInsensitive ? asciiLower(value) : value;
    switch (mode) {
      case "prefix":
        return { sql: `instr(${target}, ?) = 1`, params: [needle] };
      case "suffix":
        return { sql: `substr(${target}, -length(?)) = ?`, params: [needle, needle] };
      case "substring":
        return { sql: `instr(${target}, ?) > 0`, params: [needle] };
    }
  }
  and(expressions: readonly Expression[]): Sql {
    return combine(expressions, "AND", this);
  }
  or(expressions: readonly Expression[]): Sql {
    return combine(expressions, "OR", this);
  }
  not(expression: Expression): Sql {
    const inner = expression.compile(this);
    return { sql: `NOT (${inner.sql})`, params: inner.params };
  }
}

function combine(expressions: readonly Expression[], joiner: "AND" | "OR", visitor: SqlVisitor): Sql {
  if (expressions.length === 0) return { sql: joiner === "AND" ? "1=1" : "0=1", params: [] };
  const parts = expressions.map((expression) => expression.compile(visitor));
  return {
    sql: `(${parts.map((part) => part.sql).join(` ${joiner} `)})`,
    params: parts.flatMap((part) => part.params)
  };
}

function compile(where: QueryPlan["where"]): Sql {
  return parse(where).compile(new SqlVisitor());
}

const AGG_FN: Record<Exclude<AggregateStage["op"], "count" | "countDistinct">, string> = {
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX"
};

const SQLITE_WINDOW_FN: Record<WindowFnKind, string> = { rowNumber: "ROW_NUMBER()", rank: "RANK()", denseRank: "DENSE_RANK()" };

/**
 * One aggregate column. `count` → `COUNT(*)`; the rest reduce a value expression and `COALESCE` to 0
 * so an empty / all-null group matches the in-memory reference (which returns 0). SQL's `SUM`/`AVG`/
 * `MIN`/`MAX` already ignore NULLs and `AVG` divides by the non-null count — the same null semantics.
 */
function aggregateSql(agg: AggregateStage): Sql {
  if (agg.op === "count") return { sql: "COUNT(*)", params: [] };
  const value = parseValue(agg.value!).compile(SQL_VALUES);
  // COUNT(DISTINCT x) skips NULL — matches the reference's distinct count over present values.
  if (agg.op === "countDistinct") return { sql: `COUNT(DISTINCT ${value.sql})`, params: value.params };
  return { sql: `COALESCE(${AGG_FN[agg.op]}(${value.sql}), 0)`, params: value.params };
}

/**
 * Build the `SET data = ...` expression for a patch (shared by `patch` and `patchMany`). One atomic
 * nested `json_set`/`json_remove`; inc/mul reference `json_extract(data, ...)` — the pre-update value
 * — so the arithmetic happens DB-side, and `json_remove` drops a key (a no-op if already absent).
 */
/**
 * SQL building a new JSON array for `push`/`addToSet`/`pull`. `current` is the `json_extract` of the
 * field; the new values bind as a JSON-array param (`?`). Ordering is preserved; scalar elements.
 */
function arrayOpSql(kind: "push" | "addToSet" | "pull", current: string): string {
  const existing = `COALESCE(${current}, json('[]'))`;
  if (kind === "pull") {
    return (
      `(SELECT json_group_array(value) FROM (SELECT key AS k, value FROM json_each(${existing}) ` +
      `WHERE value NOT IN (SELECT value FROM json_each(?))) ORDER BY k)`
    );
  }
  const newRows =
    kind === "addToSet"
      ? `SELECT 1 AS s, key AS k, value FROM json_each(?) WHERE value NOT IN (SELECT value FROM json_each(${existing}))`
      : `SELECT 1 AS s, key AS k, value FROM json_each(?)`;
  return (
    `(SELECT json_group_array(value) FROM (` +
    `SELECT 0 AS s, key AS k, value FROM json_each(${existing}) UNION ALL ${newRows}) ORDER BY s, k)`
  );
}

/** Build `json_set(data, '$.f', ?, …)` applying a flat field→value map (objects as `json(?)`). */
function setFieldsExpr(fields: JsonObject): { expr: string; params: SqliteParam[] } {
  const params: SqliteParam[] = [];
  let expr = "data";
  for (const [field, value] of Object.entries(fields)) {
    const isObject = value !== null && typeof value === "object";
    expr = `json_set(${expr}, '$.${path(field)}', ${isObject ? "json(?)" : "?"})`;
    params.push(isObject ? JSON.stringify(value) : (value as SqliteParam));
  }
  return { expr, params };
}

function patchDataExpr(ops: Record<string, PatchOp>): { expr: string; params: SqliteParam[] } {
  const params: SqliteParam[] = [];
  let expr = "data";
  for (const [fieldName, op] of Object.entries(ops)) {
    const jsonPath = `'$.${path(fieldName)}'`;
    if (op.kind === "unset") {
      expr = `json_remove(${expr}, ${jsonPath})`;
      continue;
    }
    let valueSql: string;
    if (op.kind === "set") {
      valueSql = op.value !== null && typeof op.value === "object" ? "json(?)" : "?";
      params.push(op.value !== null && typeof op.value === "object" ? JSON.stringify(op.value) : (op.value as SqliteParam));
    } else if (op.kind === "setExpr") {
      // The compiled value expression reads `json_extract(data, …)` of the original `data` column,
      // so every computed field sees the pre-update row (snapshot semantics).
      const value = parseValue(op.value).compile(SQL_VALUES);
      valueSql = value.sql;
      params.push(...coerce(value.params));
    } else if (op.kind === "push" || op.kind === "addToSet" || op.kind === "pull") {
      // Rebuild the array with a subquery over `json_each` of the *original* column (snapshot), so
      // ordering is preserved; scalar elements (the common case — tokens/ids/roles).
      valueSql = arrayOpSql(op.kind, jsonExtract(fieldName));
      params.push(JSON.stringify(op.values));
    } else {
      valueSql = `COALESCE(${jsonExtract(fieldName)}, 0) ${op.kind === "inc" ? "+" : "*"} ?`;
      params.push(op.by);
    }
    expr = `json_set(${expr}, ${jsonPath}, ${valueSql})`;
  }
  return { expr, params };
}

/** Compiles value expressions to SQL arithmetic (ARCHITECTURE.md §11). The arithmetic / concat /
 *  coalesce operators (null-coercion + the divide-by-zero guard) come from the shared `valueSql`
 *  assembler so they stay in exact parity with the columnar Postgres/MySQL compiler. */
const SQL_VALUES: ValueVisitor<Sql> = {
  field: (path) => ({ sql: dataColumn(path), params: [] }),
  lit: (value) => ({ sql: "?", params: [value] }),
  arith: (op, operands) => arithFragment(op, operands.map((operand) => operand.compile(SQL_VALUES))),
  neg: (operand) => negFragment(operand.compile(SQL_VALUES)),
  concat: (operands) => concatFragment(operands.map((operand) => operand.compile(SQL_VALUES)), (sqls) => `(${sqls.join(" || ")})`),
  coalesce: (operands) => coalesceFragment(operands.map((operand) => operand.compile(SQL_VALUES))),
  datepart: (part, operand, timezone) => {
    if (timezone) throw new Error(`SQLite can't extract a date part in timezone "${timezone}" — strftime has no IANA support. Use a UTC date part, or Postgres/MySQL/Mongo/in-memory.`);
    const inner = operand.compile(SQL_VALUES);
    // Stored value is epoch ms → `/1000` to seconds for `unixepoch`; `dayOfWeek` (%w is 0–6, Sun=0)
    // is shifted to 1–7 to match Mongo / the in-memory reference.
    const extracted = `CAST(strftime('${SQL_DATE_FMT[part]}', (${inner.sql}) / 1000, 'unixepoch') AS INTEGER)`;
    return { sql: part === "dayOfWeek" ? `(${extracted} + 1)` : extracted, params: inner.params };
  },
  datestring: (format, operand, timezone) => {
    if (timezone) throw new Error(`SQLite can't format a date in timezone "${timezone}" — strftime has no IANA support.`);
    const inner = operand.compile(SQL_VALUES);
    // The format is a bound param appearing before the operand's params in the SQL text.
    return { sql: `strftime(?, (${inner.sql}) / 1000, 'unixepoch')`, params: [format, ...inner.params] };
  },
  vcompare: (op, left, right) => {
    const l = left.compile(SQL_VALUES);
    const r = right.compile(SQL_VALUES);
    return { sql: `(${l.sql} ${SQL_OP[op]} ${r.sql})`, params: [...l.params, ...r.params] };
  },
  vand: (operands) => boolCombine(operands, "AND", "1"),
  vor: (operands) => boolCombine(operands, "OR", "0"),
  vnot: (operand) => {
    const inner = operand.compile(SQL_VALUES);
    return { sql: `(NOT ${inner.sql})`, params: inner.params };
  },
  cond: (test, then, otherwise) => {
    const parts = [test, then, otherwise].map((expr) => expr.compile(SQL_VALUES));
    return {
      sql: `CASE WHEN ${parts[0]!.sql} THEN ${parts[1]!.sql} ELSE ${parts[2]!.sql} END`,
      params: parts.flatMap((part) => part.params)
    };
  },
  switch: (branches, otherwise) => {
    const params: JsonValue[] = [];
    const whens = branches
      .map((branch) => {
        const when = branch.when.compile(SQL_VALUES);
        const then = branch.then.compile(SQL_VALUES);
        params.push(...when.params, ...then.params);
        return `WHEN ${when.sql} THEN ${then.sql}`;
      })
      .join(" ");
    const dflt = otherwise.compile(SQL_VALUES);
    params.push(...dflt.params);
    return { sql: `CASE ${whens} ELSE ${dflt.sql} END`, params };
  }
};

/** Join boolean operands with AND/OR; an empty set is the identity (`1` = true / `0` = false). */
function boolCombine(operands: readonly ValueExpr[], joiner: "AND" | "OR", empty: string): Sql {
  if (operands.length === 0) return { sql: empty, params: [] };
  const parts = operands.map((operand) => operand.compile(SQL_VALUES));
  return { sql: `(${parts.map((part) => part.sql).join(` ${joiner} `)})`, params: parts.flatMap((part) => part.params) };
}

const SQL_DATE_FMT: Record<DatePart, string> = {
  year: "%Y",
  month: "%m",
  dayOfMonth: "%d",
  dayOfWeek: "%w",
  hour: "%H",
  minute: "%M",
  second: "%S"
};

/** The SELECT expression: the whole `data` blob, or a `json_object` of just the projected fields. */
function selectExpr(project: string[] | undefined): string {
  if (!project) return "data";
  const fields = ["uuid", ...project.filter((field) => field !== "uuid")];
  const pairs = fields.map((field) => `'${path(field)}', ${dataColumn(field)}`);
  return `json_object(${pairs.join(", ")})`;
}

/** Top-level column: the `uuid` primary key directly, else a `json_extract` of the data blob. */
function dataColumn(property: string): string {
  return property === "uuid" ? "uuid" : jsonExtract(property);
}

/** Top-level `json_type` of a property — NULL when the path is absent (presence test for `exists`). */
function dataType(property: string): string {
  return property === "uuid" ? "typeof(uuid)" : `json_type(data, '$.${path(property)}')`;
}

/** Column inside a json_each: the element itself (`value`), or a field of an object element. */
function elementColumn(property: string): string {
  return property === "value" ? "value" : `json_extract(value, '$.${path(property)}')`;
}

/** `json_type` of a json_each element (or a field of an object element) — the element-context peer of `dataType`. */
function elementType(property: string): string {
  return property === "value" ? "json_type(value)" : `json_type(value, '$.${path(property)}')`;
}

function jsonExtract(property: string): string {
  return `json_extract(data, '$.${path(property)}')`;
}

function orderClause(order: SortKey[]): string {
  if (order.length === 0) return "";
  const keys = order.map((key) => `${dataColumn(key.property)} ${key.descending ? "DESC" : "ASC"}`);
  return ` ORDER BY ${keys.join(", ")}`;
}

function pagingClause(paging: QueryPlan["paging"]): string {
  if (paging.end !== undefined) return ` LIMIT ${paging.end - paging.start} OFFSET ${paging.start}`;
  if (paging.start > 0) return ` LIMIT -1 OFFSET ${paging.start}`;
  return "";
}

/** Coerce JSON params to SQLite-bindable values (booleans → 1/0, objects → JSON text). */
function coerce(params: JsonValue[]): SqliteParam[] {
  return params.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value;
  });
}

/** Identifiers (model names) are developer-controlled, but validate to keep SQL injection-free. */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

function path(property: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(property)) {
    throw new Error(`Invalid property path: ${JSON.stringify(property)}`);
  }
  return property;
}
