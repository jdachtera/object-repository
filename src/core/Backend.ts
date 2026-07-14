import type { Capabilities, Context, JsonObject, JsonValue, Uuid } from "./types.ts";
import type { QueryPlan, AggregatePlan, AggregateResultRow, WindowPlan, ExpressionNode, ValueNode } from "./QueryPlan.ts";

/**
 * The spine of the whole library (ARCHITECTURE.md §2).
 *
 * Every layer — real stores (InMemory, IndexedDB, SQL, Mongo), decorators (PolicyBackend,
 * SyncBackend), and network proxies (HttpClientBackend) — implements this one contract. The
 * Repository only ever talks to "a backend" and never knows how deep the stack goes.
 *
 * Records cross this boundary as plain JSON objects (`JsonObject`). Mapping to/from model
 * instances is the Repository's job, above this seam, so the contract stays serializable and
 * usable as the network protocol.
 *
 * `T` is reserved for a future typed-record refinement; today records are `JsonObject`.
 */
export interface Backend<_T = JsonObject> {
  /** What this backend can do natively; used by the query planner to push down vs. fall back. */
  readonly capabilities: Capabilities;

  // --- reads -------------------------------------------------------------------------------

  /** Execute a query plan. Backends compile `plan.where` natively or evaluate it in memory. */
  query(plan: QueryPlan, ctx: Context): Promise<JsonObject[]>;

  /** Return only the matching uuids (used by relation decompose-and-stitch, §6). */
  queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]>;

  // --- writes (unit of work) ---------------------------------------------------------------
  //
  // A backend may hold many models (queries carry `plan.model`), so writes name their model too.

  /**
   * Queue a record to be written to `model` on the next `persist()`. `dirty`, when present, names
   * the top-level fields that actually changed since the caller's last-known-persisted state (an
   * optimization hint, computed by `Repository` from its write baseline — ARCHITECTURE.md §12): a
   * backend *may* use it to write only those fields instead of the whole record, but `record` is
   * always the complete, authoritative row, so ignoring `dirty` is always correct.
   */
  save(model: string, record: JsonObject, ctx: Context, dirty?: readonly string[]): void;

  /** Queue a removal from `model` (soft-delete/tombstone for sync, §9) for the next `persist()`. */
  remove(model: string, record: JsonObject, ctx: Context): void;

  /** Flush queued writes/removes. Resolves with what changed (drives cache + changelog). */
  persist(ctx: Context): Promise<PersistResult>;

  /**
   * Drop queued-but-unpersisted writes/removes without applying them — the rollback path for
   * `RepositoryManager.transaction` when its callback throws before the flush. Optional; a backend
   * that buffers a unit of work implements it.
   */
  discardPending?(): void;

  // --- reactivity --------------------------------------------------------------------------

  /**
   * Subscribe to changes. Required because sync is *push*, not just pull (§7): the
   * request/response methods can only answer "the value now". Backends that cannot emit a
   * feed (`capabilities.changeFeed === false`) return a no-op unsubscribe.
   */
  changes(listener: ChangeListener, ctx: Context): Unsubscribe;
}

export interface PersistResult {
  saved: PersistedChange[];
  removed: PersistedChange[];
}

/** A record that was written or removed, paired with the model it belongs to. */
export interface PersistedChange {
  model: string;
  record: JsonObject;
  /** See `Backend.save`'s `dirty` param — carried through the queue so `persist()` can use it. */
  dirty?: readonly string[];
}

/** One field of an index, with sort direction. */
export interface IndexField {
  path: string;
  descending?: boolean;
}

/**
 * A secondary index a backend should build for a model — derived from property `index`/`unique`
 * hints (single-field) or declared at the model level (`define({ indexes })`). A backend builds what
 * it can and ignores the rest: SQLite/IndexedDB do compound + unique (+ direction); `ttlSeconds`,
 * `text`, and `where` (partial) are Mongo features the others skip without loss of correctness.
 */
export interface IndexSpec {
  name: string;
  /** One entry = single-field; several = compound. */
  fields: IndexField[];
  unique?: boolean;
  sparse?: boolean;
  /** Mongo TTL — expire documents `ttlSeconds` after the (single, date) field's value. */
  ttlSeconds?: number;
  /** Mongo text index over the fields. */
  text?: boolean;
  /** Partial index predicate (Mongo `partialFilterExpression`). */
  where?: ExpressionNode;
}

/** One scalar field of a model, with its stored type — enough for a backend to build a real column. */
export interface FieldSpec {
  name: string;
  /** The stored-type tag (`text` / `integer` / `float` / `boolean` / `date` / `json` / `array` / `scalar`). */
  type: string;
}

/**
 * Optional capability for backends with an explicit schema (IndexedDB object stores, SQL tables).
 * The RepositoryManager calls `registerModel` during `define` so the backend can provision stores
 * and indexes. `fields` (the scalar columns, in declaration order) lets a backend build a real
 * columnar table; backends that store a document/blob simply ignore it. Schemaless backends
 * (in-memory, document stores) don't implement this interface at all.
 */
export interface SchemaAwareBackend {
  registerModel(model: string, indexes: IndexSpec[], fields?: FieldSpec[]): void | Promise<void>;
}

/** Narrow a backend to the schema-aware interface. */
export function isSchemaAware(backend: object): backend is SchemaAwareBackend {
  return typeof (backend as Partial<SchemaAwareBackend>).registerModel === "function";
}

/**
 * Optional capability: count matching rows natively (ARCHITECTURE.md §11). A store that can count
 * without materializing rows (IndexedDB `count`, SQL `COUNT(*)`) implements this; otherwise the
 * engine falls back to fetching and counting in memory. Same result either way — only faster.
 */
export interface CountingBackend {
  count(plan: QueryPlan, ctx: Context): Promise<number>;
}

/** Narrow a backend to the counting interface. */
export function isCounting(backend: object): backend is CountingBackend {
  return typeof (backend as Partial<CountingBackend>).count === "function";
}

/**
 * Optional capability: compute grouped aggregates natively (ARCHITECTURE.md §11) — SQL `GROUP BY`,
 * Mongo `$group`. A backend that can implements this; otherwise the engine fetches the filtered set
 * and reduces it in memory (the reference semantics), so the result is identical, only slower. This
 * is what removes the "aggregate over an unbounded set" cliff for capable stores.
 */
export interface AggregatingBackend {
  aggregate(plan: AggregatePlan, ctx: Context): Promise<AggregateResultRow[]>;
}

/** Narrow a backend to the aggregating interface. */
export function isAggregating(backend: object): backend is AggregatingBackend {
  return typeof (backend as Partial<AggregatingBackend>).aggregate === "function";
}

/**
 * Optional capability: compute ranking window functions natively (SQL `ROW_NUMBER()/RANK()/DENSE_RANK()
 * OVER (PARTITION BY … ORDER BY …)`, Mongo `$setWindowFields`). Returns the filtered rows (decoded
 * columns) each with the plan's window columns merged in, or `null` when this plan can't be pushed down
 * (e.g. a partition/order key that isn't a real column) — the engine then computes it over the fetched
 * set with the shared reference (`computeWindow`), so the result is identical, only slower.
 */
export interface WindowingBackend {
  window(plan: WindowPlan, ctx: Context): Promise<JsonObject[] | null>;
}

/** Narrow a backend to the windowing interface. */
export function isWindowing(backend: object): backend is WindowingBackend {
  return typeof (backend as Partial<WindowingBackend>).window === "function";
}

/** A single field mutation in an atomic patch (ARCHITECTURE.md §11, DB-side arithmetic). */
export type PatchOp =
  | { kind: "set"; value: JsonValue }
  // Set a field to a *computed* value expression evaluated server-side (Mongo update pipeline,
  // SQL `SET x = <expr>`). All expressions in one patch see the pre-update record (snapshot).
  | { kind: "setExpr"; value: ValueNode }
  | { kind: "unset" }
  | { kind: "inc"; by: number }
  | { kind: "mul"; by: number }
  // Array mutations (Mongo `$push`/`$addToSet`/`$pullAll`). `push` appends; `addToSet` appends only
  // values not already present; `pull` removes every element equal to any of `values`.
  | { kind: "push"; values: JsonValue[] }
  | { kind: "addToSet"; values: JsonValue[] }
  | { kind: "pull"; values: JsonValue[] };

/**
 * Optional capability: apply field mutations to one record atomically, server-side — an `inc`/`mul`
 * avoids the read-modify-write race a whole-record upsert has. Backends that can't (in-memory,
 * IndexedDB) omit it, and the Repository falls back to read-modify-write.
 */
export interface PatchingBackend {
  patch(model: string, uuid: Uuid, ops: Record<string, PatchOp>, ctx: Context): Promise<void>;
}

/** Narrow a backend to the patching interface. */
export function isPatching(backend: object): backend is PatchingBackend {
  return typeof (backend as Partial<PatchingBackend>).patch === "function";
}

/**
 * Optional capability: apply field mutations to *every* record matching a filter, server-side
 * (Mongo `updateMany`, SQL `UPDATE ... WHERE`). The peer of `PatchingBackend` for the set-based
 * case; backends that can't omit it and the Repository falls back to query-then-write. Returns the
 * number of records the store reports as modified.
 */
export interface MultiPatchingBackend {
  patchMany(model: string, where: ExpressionNode, ops: Record<string, PatchOp>, ctx: Context): Promise<number>;
}

/** Narrow a backend to the multi-patching interface. */
export function isMultiPatching(backend: object): backend is MultiPatchingBackend {
  return typeof (backend as Partial<MultiPatchingBackend>).patchMany === "function";
}

/**
 * Optional capability: an atomic insert-or-update by a key filter (Mongo `updateOne` with
 * `upsert: true`). `set` applies on both insert and update; `setOnInsert` only on insert. A store
 * that can do this race-free implements it; otherwise the Repository falls back to read-then-write
 * (correct, but not atomic). Records are the stored JSON form.
 */
export interface UpsertingBackend {
  upsert(
    model: string,
    where: ExpressionNode,
    set: JsonObject,
    setOnInsert: JsonObject,
    ctx: Context
  ): Promise<void>;
}

/** Narrow a backend to the upserting interface. */
export function isUpserting(backend: object): backend is UpsertingBackend {
  return typeof (backend as Partial<UpsertingBackend>).upsert === "function";
}

/**
 * Optional capability: run a backend-native query the compiler can't express — a typed escape hatch
 * that still goes through the ORM's own connection/pool (and decorator stack) instead of reaching for
 * the raw driver. `Q` is the backend-native query shape (SQL backends take `{ sql, params }`; Mongo
 * takes `{ collection, pipeline }`) and `R` the row shape; both default to opaque. Rows come back
 * untouched — the caller owns the query, so mapping to model instances is out of scope. Decorators
 * that can't rewrite the opaque query (e.g. row-level policy) forward it as-is (see `RawQueryable`
 * uses for the caveats).
 */
export interface RawQueryable<Q = unknown, R = Record<string, unknown>> {
  raw(query: Q, ctx: Context): Promise<R[]>;
}

/** Narrow a backend to the raw-query interface. */
export function isRawQueryable(backend: object): backend is RawQueryable {
  return typeof (backend as Partial<RawQueryable>).raw === "function";
}

/**
 * Optional capability: run `fn` inside a real, *interactive* backend transaction. `fn` receives a
 * tx-scoped `Backend` — writes it persists are visible to reads it issues on that same scoped backend
 * *before* commit, which the plain write-batching `persist` can't do (its writes only land at flush).
 * `fn` returning commits; throwing rolls back and re-throws. Backends without engine-level isolation
 * (in-memory, IndexedDB) omit this and the manager falls back to write-batching.
 */
export interface TransactionalBackend {
  transaction<T>(fn: (tx: Backend) => Promise<T>, ctx: Context): Promise<T>;
}

/** Narrow a backend to the transactional interface. */
export function isTransactional(backend: object): backend is TransactionalBackend {
  return typeof (backend as Partial<TransactionalBackend>).transaction === "function";
}

export interface ChangeEvent {
  model: string;
  uuid: Uuid;
  kind: "saved" | "removed";
  /** Present for `saved`; absent for `removed`. */
  record?: JsonObject;
}

export type ChangeListener = (event: ChangeEvent) => void;
export type Unsubscribe = () => void;

/**
 * Optional capability for stores that can resolve a filter against their own AST natively.
 * Compiling backends (SQL, Mongo, IndexedDB) implement this; scan-only backends omit it and
 * the planner falls back to in-memory `match()` (ARCHITECTURE.md §3).
 *
 * `R` is the backend-native query representation (a SQL string + params, a Mongo filter
 * object, an IDBKeyRange, ...).
 */
export interface CompilingBackend<R> {
  compile(plan: QueryPlan): R;
}
