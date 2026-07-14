/**
 * A compiling, columnar SQL backend over any engine, driven by a `SqlDialect` (ARCHITECTURE.md §3,
 * §11).
 *
 * Each model is a **real table** with one natively-typed column per scalar field (plus a `uuid`
 * primary key and a JSON `_extra` overflow column for anything without a declared scalar column —
 * e.g. embedded relations). So filters/sort/paging/COUNT and grouped aggregates compile to plain
 * column SQL and secondary indexes are ordinary column indexes; anything the compiler can't express
 * (see `compile.ts`) falls back to fetching rows and running the in-memory reference, so results are
 * identical either way.
 *
 * Capabilities: reads, count, and aggregate push-down, schema-aware table + index creation, and the
 * change feed. Patches and upserts use the repository's read-modify-write fallbacks (documented).
 */
import type {
  AggregatingBackend,
  Backend,
  ChangeEvent,
  ChangeListener,
  CountingBackend,
  FieldSpec,
  IndexSpec,
  PersistResult,
  PersistedChange,
  RawQueryable,
  SchemaAwareBackend,
  TransactionalBackend,
  Unsubscribe
} from "../../core/Backend.ts";
import type { Capabilities, Context, JsonObject, JsonValue, Uuid } from "../../core/types.ts";
import type { AggregatePlan, AggregateResultRow, QueryPlan, WindowPlan } from "../../core/QueryPlan.ts";
import { generateUuid } from "../../core/uuid.ts";
import { reduceAggregatePlan } from "../../expressions/aggregateReduce.ts";
import { scan } from "../util/scan.ts";
import { compileAggregate, compileWhere, compileWindow } from "./compile.ts";
import { OVERFLOW_COLUMN, type SqlDialect } from "./dialect.ts";
import { runMigrations, rollbackMigrations } from "./migrate.ts";
import type { MigratableBackend, Migration, MigrationReport } from "./migrate.ts";
import { UniqueConstraintError, uniqueKey, uniqueKeySets, sameBatchConflict } from "../util/unique.ts";

/**
 * What a concrete backend provides: run a parameterized statement, and (optionally) run a set of
 * statements inside a real DB transaction — `fn` receives a tx-scoped executor and its throw rolls
 * the whole thing back. Without it, `persist` still works, just not atomically.
 */
export interface SqlExecutor {
  run(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * A raw SQL statement the compiler can't express — written in the target dialect's own placeholder
 * style (Postgres `$1`, MySQL `?`), run as-is. This is the SQL shape of `RawQueryable`'s `Q`.
 */
export interface SqlRawQuery {
  sql: string;
  params?: unknown[];
}

const TOP = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Rows per multi-row statement — bounded so `rows × columns` params stay well under driver limits. */
const MAX_BATCH_ROWS = 500;

/** Group persisted changes by model, preserving first-seen order. */
function groupByModel(changes: PersistedChange[]): Map<string, PersistedChange[]> {
  const groups = new Map<string, PersistedChange[]>();
  for (const change of changes) {
    const list = groups.get(change.model);
    if (list) list.push(change);
    else groups.set(change.model, [change]);
  }
  return groups;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Backend-level options shared by the SQL backends (Postgres/MySQL). */
export interface SqlBackendOptions {
  /**
   * Run a pre-emptive `SELECT` before a write to raise a friendly `UniqueConstraintError` (matching the
   * in-memory reference) instead of leaning on the DB unique index to throw at write time. Off by
   * default — it costs one round-trip per model per unique key that the DB index already covers. It also
   * closes the MySQL divergence where an `ON DUPLICATE KEY UPDATE` silently absorbs a secondary-unique
   * collision. Not a lock: a concurrent inserter between the SELECT and the write is still caught only by
   * the DB index (the real backstop). Covers column-backed unique keys; a unique key over an undeclared/
   * embedded field is enforced by the reference only (there is no DB column/index for it).
   */
  uniquePreCheck?: boolean;
}

export class SqlBackend
  implements
    Backend,
    SchemaAwareBackend,
    CountingBackend,
    AggregatingBackend,
    RawQueryable<SqlRawQuery>,
    TransactionalBackend,
    MigratableBackend
{
  readonly capabilities: Capabilities;

  private readonly dialect: SqlDialect;
  private readonly exec: SqlExecutor;
  private readonly schemas = new Map<string, FieldSpec[]>();
  private readonly indexes = new Map<string, IndexSpec[]>();
  private readonly provisioned = new Map<string, Promise<unknown>>();
  private readonly uniquePreCheck: boolean;
  private saveQueue: PersistedChange[] = [];
  private removeQueue: PersistedChange[] = [];
  private readonly listeners = new Set<ChangeListener>();

  constructor(dialect: SqlDialect, executor: SqlExecutor, options: SqlBackendOptions = {}) {
    this.dialect = dialect;
    this.exec = executor;
    this.uniquePreCheck = options.uniquePreCheck ?? false;
    this.capabilities = {
      indexes: true,
      ranges: true,
      sortPushdown: true,
      joins: false,
      transactions: typeof executor.transaction === "function",
      changeFeed: true
    };
  }

  async registerModel(model: string, indexes: IndexSpec[], fields: FieldSpec[] = []): Promise<void> {
    this.schemas.set(model, fields);
    this.indexes.set(model, indexes);
    await this.ensure(model);
  }

  async query(plan: QueryPlan, _ctx: Context): Promise<JsonObject[]> {
    await this.ensure(plan.model);
    const where = this.schemas.has(plan.model) ? compileWhere(plan.where, this.dialect, this.columnTypes(plan.model)) : null;
    const orderOk = plan.order.every((k) => k.property === "uuid" || TOP.test(k.property));
    if (where && orderOk) {
      const sql = this.dialect.finalize(
        `SELECT * FROM ${this.dialect.ref(plan.model)} WHERE ${where.sql}` + this.orderClause(plan) + this.pagingClause(plan)
      );
      const rows = await this.exec.run(sql, coerce(where.params));
      return this.project(rows.map((r) => this.decodeRow(plan.model, r)), plan.project);
    }
    // Scan fallback: fetch everything, evaluate the whole plan in memory (filter + order + paging).
    const rows = await this.exec.run(`SELECT * FROM ${this.dialect.ref(plan.model)}`, []);
    return this.project(scan(rows.map((r) => this.decodeRow(plan.model, r)), plan), plan.project);
  }

  async queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    return (await this.query({ ...plan, project: ["uuid"] }, ctx)).map((row) => String(row.uuid));
  }

  async count(plan: QueryPlan, _ctx: Context): Promise<number> {
    await this.ensure(plan.model);
    const where = this.schemas.has(plan.model) ? compileWhere(plan.where, this.dialect, this.columnTypes(plan.model)) : null;
    if (where) {
      const sql = this.dialect.finalize(`SELECT COUNT(*) AS n FROM ${this.dialect.ref(plan.model)} WHERE ${where.sql}`);
      const row = (await this.exec.run(sql, coerce(where.params)))[0] as { n: unknown } | undefined;
      return row ? Number(row.n) : 0;
    }
    const rows = await this.exec.run(`SELECT * FROM ${this.dialect.ref(plan.model)}`, []);
    return scan(rows.map((r) => this.decodeRow(plan.model, r)), { ...plan, order: [], paging: { start: 0 } }).length;
  }

  async aggregate(plan: AggregatePlan, _ctx: Context): Promise<AggregateResultRow[]> {
    await this.ensure(plan.model);
    const where = this.schemas.has(plan.model) ? compileWhere(plan.where, this.dialect, this.columnTypes(plan.model)) : null;
    const agg = this.schemas.has(plan.model) ? compileAggregate(plan, this.dialect) : null;
    if (where && agg) {
      const sql = this.dialect.finalize(
        `SELECT ${agg.columns} FROM ${this.dialect.ref(plan.model)} WHERE ${where.sql}${agg.groupBy}`
      );
      const rows = await this.exec.run(sql, coerce([...agg.params, ...where.params, ...agg.groupParams]));
      return rows.map((row) => ({
        key: plan.groupBy.map((_, i) => row[`g${i}`] as JsonValue),
        values: Object.fromEntries(plan.aggregates.map((a, i) => [a.name, Number(row[`a${i}`] ?? 0)]))
      }));
    }
    const rows = await this.exec.run(`SELECT * FROM ${this.dialect.ref(plan.model)}`, []);
    const filtered = scan(rows.map((r) => this.decodeRow(plan.model, r)), { model: plan.model, where: plan.where, order: [], paging: { start: 0 } });
    return reduceAggregatePlan(plan, filtered);
  }

  /**
   * Compute ranking window functions with `ROW_NUMBER()/RANK()/DENSE_RANK() OVER (PARTITION BY … ORDER
   * BY …)` — one scan of the table, no client-side sort. Returns `null` when the partition/order can't
   * push down (a nested/undeclared key), so the repository computes it in memory with the reference.
   */
  async window(plan: WindowPlan, _ctx: Context): Promise<JsonObject[] | null> {
    await this.ensure(plan.model);
    if (!this.schemas.has(plan.model)) return null;
    const cols = this.columnTypes(plan.model);
    const where = compileWhere(plan.where, this.dialect, cols);
    const win = compileWindow(plan, this.dialect, cols);
    if (!where || !win) return null;
    // Window columns are in the SELECT list, so their params bind before the WHERE params.
    const sql = this.dialect.finalize(`SELECT *, ${win.columns} FROM ${this.dialect.ref(plan.model)} WHERE ${where.sql}`);
    const rows = await this.exec.run(sql, coerce([...win.params, ...where.params]));
    return rows.map((r) => {
      const decoded = this.decodeRow(plan.model, r);
      plan.functions.forEach((fn, i) => (decoded[fn.name] = Number(r[`w${i}`] ?? 0)));
      return decoded;
    });
  }

  /**
   * Escape hatch for SQL the compiler can't express (CTEs, window functions, engine-specific
   * operators). Runs through the same executor — so it shares the injected client/pool — and returns
   * the driver rows untouched (no column decoding; the query's shape is the caller's). Write your
   * placeholders in the target dialect's style: Postgres `$1, $2`, MySQL `?`.
   */
  async raw<R extends Record<string, unknown> = Record<string, unknown>>(
    query: SqlRawQuery,
    _ctx: Context
  ): Promise<R[]> {
    return (await this.exec.run(query.sql, query.params ?? [])) as R[];
  }

  /**
   * Apply a versioned migration set (create/drop table, add/drop/rename/retype column, index DDL, and
   * raw backfills), each recorded in a `_object_repository_migrations` table so re-runs are no-ops. Run this at
   * deploy/startup — the in-memory schema the backend caches from `registerModel` is not hot-reloaded,
   * so define models against the post-migration shape.
   */
  migrate(migrations: Migration[]): Promise<MigrationReport> {
    return runMigrations(this.exec, this.dialect, migrations, () => Date.now());
  }

  /** Revert the `count` most-recently-applied migrations that declare a `down` (default 1). */
  rollback(migrations: Migration[], count = 1): Promise<MigrationReport> {
    return rollbackMigrations(this.exec, this.dialect, migrations, count);
  }

  save(model: string, record: JsonObject, _ctx: Context, dirty?: readonly string[]): void {
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
    // Provision tables/indexes (DDL) *before* the transaction: MySQL implicitly commits on DDL, so a
    // CREATE inside the tx would break its atomicity. The writes then run as one atomic unit.
    for (const model of new Set([...saved, ...removed].map((c) => c.model))) await this.ensure(model);

    const writes = async (exec: SqlExecutor) => {
      // Opt-in: raise a friendly UniqueConstraintError before any write, on the same executor (so it
      // sees the tx's own uncommitted rows and rolls back cleanly on a throw). The DB unique index
      // remains the real backstop for a concurrent racing insert.
      if (this.uniquePreCheck) await this.precheckUnique(exec, saved, removed);
      // Batch by model into multi-row statements (chunked to stay well under driver parameter limits),
      // further bucketed by which physical columns actually changed (dirty-field tracking,
      // ARCHITECTURE.md §12) — an update then only touches the columns that changed, while same-
      // shaped writes (the common case, e.g. a bulk field bump) still share one statement.
      for (const [model, changes] of groupByModel(saved)) {
        const columns = this.columns(model);
        for (const { updateColumns, items } of this.bucketByDirtyColumns(model, changes)) {
          for (const chunk of chunked(items, MAX_BATCH_ROWS)) {
            const params = chunk.flatMap((c) => this.encodeRow(model, c.record));
            await exec.run(this.dialect.upsertMany(model, columns, chunk.length, updateColumns), params);
          }
        }
      }
      for (const [model, changes] of groupByModel(removed)) {
        for (const chunk of chunked(changes, MAX_BATCH_ROWS)) {
          await exec.run(this.dialect.deleteMany(model, chunk.length), chunk.map((c) => String(c.record.uuid)));
        }
      }
    };
    if (this.exec.transaction) await this.exec.transaction(writes);
    else await writes(this.exec);

    for (const change of saved) {
      this.emit({ model: change.model, uuid: String(change.record.uuid), kind: "saved", record: change.record });
    }
    for (const change of removed) {
      this.emit({ model: change.model, uuid: String(change.record.uuid), kind: "removed" });
    }
    return { saved, removed };
  }

  discardPending(): void {
    this.saveQueue = [];
    this.removeQueue = [];
  }

  /**
   * Run `fn` inside one real DB transaction, handing it a tx-scoped backend bound to the same
   * checked-out connection. Reads `fn` issues on that scoped backend see writes it has already
   * persisted (uncommitted) — true interactive isolation. Any writes queued on *this* (outer) backend
   * during `fn` are folded into the same transaction and flushed once, so a mixed unit still commits
   * atomically. `fn` returning commits; throwing rolls back, discards the outer queue, and re-throws.
   */
  async transaction<T>(fn: (tx: Backend) => Promise<T>, ctx: Context): Promise<T> {
    // Provision every known model *before* opening the tx: MySQL implicitly commits on DDL, so any
    // CREATE/ALTER inside the tx would silently break its atomicity.
    await Promise.all([...this.provisioned.values()]);
    if (!this.exec.transaction) {
      // Engine can't isolate (bare executor): no uncommitted-read isolation, just batch-flush our queue.
      const result = await fn(this);
      await this.persist(ctx);
      return result;
    }
    try {
      return await this.exec.transaction(async (txExec) => {
        const scoped = this.forTransaction(txExec);
        const result = await fn(scoped);
        // Fold in writes queued on the outer backend (repos not obtained from the tx scope) so the
        // whole unit commits together, then flush once on the tx connection.
        scoped.saveQueue.unshift(...this.saveQueue);
        scoped.removeQueue.unshift(...this.removeQueue);
        this.saveQueue = [];
        this.removeQueue = [];
        await scoped.persist(ctx);
        return result;
      });
    } catch (error) {
      this.discardPending();
      throw error;
    }
  }

  /**
   * A backend bound to a transaction's executor: same dialect, and it *shares* this backend's schema,
   * provisioning memo (so it runs no DDL), and change listeners (so writes it flushes invalidate the
   * same repositories' caches). Its executor has no nested `transaction`, so `persist` writes straight
   * onto the tx connection rather than opening a second `BEGIN`.
   */
  private forTransaction(exec: SqlExecutor): SqlBackend {
    const scoped = new SqlBackend(this.dialect, exec, { uniquePreCheck: this.uniquePreCheck });
    this.schemas.forEach((fields, model) => scoped.schemas.set(model, fields));
    this.indexes.forEach((specs, model) => scoped.indexes.set(model, specs));
    this.provisioned.forEach((done, model) => scoped.provisioned.set(model, done)); // already provisioned
    this.listeners.forEach((listener) => scoped.listeners.add(listener)); // snapshot; emits reach outer caches
    return scoped;
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

  // --- schema / columns ------------------------------------------------------------------------

  private fields(model: string): FieldSpec[] {
    return this.schemas.get(model) ?? [];
  }

  /** Column order used for INSERT: uuid, each scalar field, then the JSON overflow column. */
  private columns(model: string): string[] {
    return ["uuid", ...this.fields(model).map((f) => f.name), OVERFLOW_COLUMN];
  }

  /** Column name → stored type, for schema-aware push-downs (text search, nested-JSON paths). */
  private columnTypes(model: string): Map<string, string> {
    return new Map(this.fields(model).map((f) => [f.name, f.type]));
  }

  /**
   * Group saved changes by which physical columns their `dirty` hint touches, mapping any field
   * without its own declared scalar column (undeclared/embedded/relation fields) to the shared
   * `_extra` overflow column, so a change to one of those still updates it. Changes with no `dirty`
   * hint bucket under `updateColumns: undefined` (the default "update every column" path). Same-
   * shaped changes land in the same bucket so they still batch into one multi-row statement.
   */
  private bucketByDirtyColumns(
    model: string,
    changes: PersistedChange[]
  ): { updateColumns: string[] | undefined; items: PersistedChange[] }[] {
    const scalarNames = new Set(this.fields(model).map((f) => f.name));
    const buckets = new Map<string, { updateColumns: string[] | undefined; items: PersistedChange[] }>();
    for (const change of changes) {
      const columns = change.dirty
        ? [...new Set(change.dirty.map((f) => (scalarNames.has(f) ? f : OVERFLOW_COLUMN)))].sort()
        : undefined;
      const signature = columns ? columns.join(",") : "*";
      let bucket = buckets.get(signature);
      if (!bucket) {
        bucket = { updateColumns: columns, items: [] };
        buckets.set(signature, bucket);
      }
      bucket.items.push(change);
    }
    return [...buckets.values()];
  }

  private ensure(model: string): Promise<unknown> {
    let pending = this.provisioned.get(model);
    if (!pending) {
      pending = this.provision(model);
      this.provisioned.set(model, pending);
    }
    return pending;
  }

  private async provision(model: string): Promise<void> {
    const fields = this.fields(model);
    // Introspect first: create the table when absent, otherwise run an additive migration — add any
    // newly-declared column the existing table is missing. Only ever adds columns; dropping/renaming
    // is a manual, destructive operation. (Introspecting first also avoids a redundant CREATE on an
    // existing table.)
    const columnsQuery = this.dialect.columnsQuery(model);
    const present = new Set((await this.exec.run(columnsQuery.sql, columnsQuery.params)).map((r) => String(r.column_name)));
    if (present.size === 0) {
      await this.exec.run(this.dialect.createTable(model, fields), []);
    } else {
      for (const f of fields) {
        if (!present.has(f.name)) {
          await this.exec.run(this.dialect.addColumn(model, f.name, this.dialect.columnType(f.type)), []).catch(() => {});
        }
      }
    }

    const known = new Set(fields.map((f) => f.name));
    for (const index of this.indexes.get(model) ?? []) {
      // Columnar indexes only: TTL/text are Mongo features; skip an index over a field with no column.
      if (index.text || index.ttlSeconds !== undefined) continue;
      const cols = index.fields.map((f) => f.path);
      if (!cols.every((c) => c === "uuid" || known.has(c))) continue;
      // Scope the index name to the table: Postgres index names are schema-global, so a bare field
      // name (e.g. "email") on a second table would collide and — under `IF NOT EXISTS` — silently
      // skip, dropping that table's constraint. `<model>_<name>` keeps it unique per schema. Fold any
      // non-identifier characters (a developer-supplied name like "songId-userId") to `_` so the
      // dialect's identifier check accepts it.
      const name = `${model}_${index.name}`.replace(/[^A-Za-z0-9_]/g, "_");
      // CREATE INDEX may already exist on a persistent DB (MySQL has no IF NOT EXISTS) — ignore that.
      // Pass column types so MySQL can prefix-length a TEXT-backed index column.
      await this.exec.run(this.dialect.createIndex(model, name, cols, !!index.unique, this.columnTypes(model)), []).catch(() => {});
    }
  }

  /**
   * Pre-write uniqueness check (opt-in): for each model in the batch, catch same-batch duplicates in
   * memory, then `SELECT` for a pre-existing row with a colliding value on any column-backed unique key
   * (excluding the batch's own saved/removed rows, so a re-save, remove-then-reuse, or two-record value
   * swap is not a conflict). Throws `UniqueConstraintError` before any INSERT, so a violation leaves the
   * store intact. Mirrors `InMemoryBackend.checkUnique` semantics exactly (NULLs distinct, compound keys).
   */
  private async precheckUnique(exec: SqlExecutor, saved: PersistedChange[], removed: PersistedChange[]): Promise<void> {
    for (const [model, changes] of groupByModel(saved)) {
      const cols = this.columnTypes(model);
      // Only key-sets fully backed by real columns — exactly what the DB unique index covers.
      const keySets = uniqueKeySets(this.indexes.get(model) ?? []).filter((fields) =>
        fields.every((f) => f === "uuid" || cols.has(f))
      );
      if (keySets.length === 0) continue;

      const dup = sameBatchConflict(changes, keySets);
      if (dup) throw new UniqueConstraintError(model, dup);

      // Records this batch rewrites or removes free their old value — not a conflict against themselves.
      const freed = new Set(changes.map((c) => String(c.record.uuid)));
      for (const change of removed) if (change.model === model) freed.add(String(change.record.uuid));
      const freedList = [...freed];

      for (const fields of keySets) {
        const tuples = changes
          .filter((c) => uniqueKey(c.record, fields) !== null)
          .map((c) => fields.map((f) => c.record[f] as JsonValue));
        if (tuples.length === 0) continue;

        const keyPredicate =
          fields.length === 1
            ? `${this.dialect.column(fields[0]!)} IN (${tuples.map(() => "?").join(", ")})`
            : `(${tuples.map(() => `(${fields.map((f) => `${this.dialect.column(f)} = ?`).join(" AND ")})`).join(" OR ")})`;
        const keyParams = fields.length === 1 ? tuples.map((t) => t[0]!) : tuples.flat();

        const notIn = `uuid NOT IN (${freedList.map(() => "?").join(", ")})`;
        const sql = this.dialect.finalize(`SELECT uuid FROM ${this.dialect.ref(model)} WHERE ${notIn} AND ${keyPredicate} LIMIT 1`);
        const rows = await exec.run(sql, coerce([...(freedList as JsonValue[]), ...keyParams]));
        if (rows.length > 0) throw new UniqueConstraintError(model, fields);
      }
    }
  }

  /** Decompose a record into column values (scalars typed, everything else JSON in `_extra`). */
  private encodeRow(model: string, record: JsonObject): unknown[] {
    const fields = this.fields(model);
    const known = new Set(["uuid", ...fields.map((f) => f.name)]);
    const values: unknown[] = [String(record.uuid)];
    for (const f of fields) values.push(encodeValue(f.type, record[f.name] as JsonValue | undefined, this.dialect));
    const extra: JsonObject = {};
    for (const [key, value] of Object.entries(record)) if (!known.has(key)) extra[key] = value;
    values.push(Object.keys(extra).length ? JSON.stringify(extra) : null);
    return values;
  }

  /** Rebuild a record from a table row: typed scalar columns + the merged `_extra` overflow. */
  private decodeRow(model: string, row: Record<string, unknown>): JsonObject {
    const out: JsonObject = {};
    if (row.uuid != null) out.uuid = String(row.uuid);
    for (const f of this.fields(model)) {
      const value = row[f.name];
      if (value === null || value === undefined) continue; // absent → omit, matching the blob (missing) semantics
      out[f.name] = decodeValue(f.type, value);
    }
    const extra = row[OVERFLOW_COLUMN];
    if (extra != null) Object.assign(out, typeof extra === "string" ? (JSON.parse(extra) as JsonObject) : (extra as JsonObject));
    return out;
  }

  private orderClause(plan: QueryPlan): string {
    if (plan.order.length === 0) return "";
    const keys = plan.order.map(
      (k) => `${this.dialect.column(k.property)} ${k.descending ? "DESC" : "ASC"}${this.dialect.nullsOrder(k.descending)}`
    );
    return ` ORDER BY ${keys.join(", ")}`;
  }

  private pagingClause(plan: QueryPlan): string {
    const limit = plan.paging.end !== undefined ? plan.paging.end - plan.paging.start : null;
    return this.dialect.paging(limit, plan.paging.start);
  }

  private project(records: JsonObject[], fields: string[] | undefined): JsonObject[] {
    if (!fields) return records;
    const keep = ["uuid", ...fields.filter((f) => f !== "uuid")];
    return records.map((record) => Object.fromEntries(keep.filter((f) => f in record).map((f) => [f, record[f]])) as JsonObject);
  }
}

/** Encode a stored value for its column. Scalars go in typed columns; JSON-ish fields are text. */
function encodeValue(type: string, value: JsonValue | undefined, dialect: SqlDialect): unknown {
  if (value === undefined || value === null) return null;
  switch (type) {
    case "boolean":
      return dialect.name === "postgres" ? Boolean(value) : value ? 1 : 0;
    case "json": // the json() codec already produced a JSON string — keep it opaque
      return typeof value === "string" ? value : JSON.stringify(value);
    case "array": // native array → JSON string
    case "embedded": // native subdocument → JSON string (queryable via a JSON extraction)
    case "scalar": // custom stored type → JSON-encode so any JsonValue round-trips
      return JSON.stringify(value);
    default: // text / integer / float / date pass straight through
      return value;
  }
}

/** Decode a column value back to its stored form (the shape the repository's codec expects). */
function decodeValue(type: string, value: unknown): JsonValue {
  switch (type) {
    case "boolean":
      return typeof value === "boolean" ? value : value === 1 || value === "1" || value === "true";
    case "integer":
    case "float":
    case "date":
      return Number(value); // pg returns bigint as a string; every engine here decodes to a number
    case "array":
    case "embedded":
    case "scalar":
      return typeof value === "string" ? (JSON.parse(value) as JsonValue) : (value as JsonValue);
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value);
    default:
      return typeof value === "string" ? value : (value as JsonValue);
  }
}

/** Coerce filter params to driver-bindable values (booleans → 1/0, objects → JSON text). */
function coerce(params: JsonValue[]): unknown[] {
  return params.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value;
  });
}
