import type { Backend } from "../core/Backend.ts";
import { isAggregating, isCounting, isMultiPatching, isPatching, isUpserting, isWindowing } from "../core/Backend.ts";
import type { PatchOp } from "../core/Backend.ts";
import { applyPatch, normalizePatch, sameValue, type PatchSpec, type PatchSpecFor } from "./patch.ts";
import { neededFields, allScalarsSelection, type Selection } from "./projection.ts";
import { isValueExpr } from "../expressions/values.ts";
import { eq } from "../expressions/builders.ts";
import type { Context, JsonObject, JsonValue, SortKey, Uuid } from "../core/types.ts";
import type { QueryPlan, AggregatePlan, AggregateResultRow, WindowPlan } from "../core/QueryPlan.ts";
import { generateUuid } from "../core/uuid.ts";
import type { AnyProperty, InferModel, PropertyMap } from "../properties/infer.ts";
import { ValidationError } from "../properties/schema.ts";
import type { Expression } from "../expressions/Expression.ts";
import type { ExpressionNode } from "../core/QueryPlan.ts";
import { inList, contains, or, not, isNull } from "../expressions/builders.ts";
import { parse } from "../expressions/parse.ts";
import { QueryCache } from "./QueryCache.ts";
import { QueryCollection, type Queryable, type ReadOptions } from "./QueryCollection.ts";

/** Resolves a model name to its repository (the RepositoryManager registry). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RelationResolver = (model: string) => Repository<any> | undefined;

/**
 * Shared transaction mode, flipped by `RepositoryManager.transaction` and read by every repository it
 * owns, so an immediately-persisting write (`patch`/`patchWhere`/`upsert`) can refuse to *silently
 * escape* a transaction: `"batching"` means a non-transactional backend (its persist can't be rolled
 * back), `"interactive"` means a real DB transaction whose atomicity only the tx-scoped repositories
 * join. `"none"` outside any transaction.
 */
export type TransactionMode = "none" | "batching" | "interactive";
export interface TransactionState {
  mode: TransactionMode;
}

/** Instances are plain objects at runtime; this is their internal, untyped view. */
type Record_ = Record<string, unknown>;

/** The field names auto-managed by `timestamps: true`. */
export const TIMESTAMP_FIELDS = { createdAt: "createdAt", updatedAt: "updatedAt" } as const;
export type TimestampFields = { createdAt: string; updatedAt: string };

/** Soft-delete configuration (the marker column's name), or `null` when the model hard-deletes. */
export interface SoftDeleteConfig {
  field: string;
}

/**
 * Extract the inferred model type from a repository (the `z.infer` of this ORM):
 * `const users = orm.define({ … }); type User = Model<typeof users>;`.
 */
export type Model<R> = R extends Repository<infer P> ? InferModel<P> : never;

/**
 * A typed repository over a model definition (ARCHITECTURE.md §5–6).
 *
 * Ties the layers together: validates and (de)serializes instances through the property layer,
 * runs queries via `QueryCollection` → `Backend`, eager-loads relations through a shared identity
 * map (which also breaks reference cycles), and keeps a query cache invalidated by the backend's
 * change feed. The instance type is inferred from the property map.
 */
export class Repository<P extends PropertyMap> implements Queryable<InferModel<P>> {
  readonly modelName: string;
  readonly properties: P;

  private readonly backend: Backend;
  private readonly ctx: Context;
  private readonly resolve: RelationResolver;
  private readonly timestamps: TimestampFields | null;
  private readonly generateId: () => string;
  private readonly cache = new QueryCache<InferModel<P>>();
  private readonly unsubscribe: () => void;
  /**
   * Live-query listeners notified after a *relevant* committed change to this model. Each carries the
   * query's compiled filter (`matcher`); a change fires a listener only if the changed record matches
   * that filter before or after the write (see `subscribeChanges` / the change-feed handler). A listener
   * with no `matcher` (an unfiltered query) fires on every change.
   */
  private readonly liveListeners = new Set<{ notify: () => void; matcher: Expression | null }>();
  private readonly txState: TransactionState;
  private readonly scoped: boolean;
  private readonly softDelete: SoftDeleteConfig | null;
  /** Names of computed/virtual fields — never stored, so filtering/sorting by one is rejected early. */
  private readonly computedFields: ReadonlySet<string>;

  constructor(
    modelName: string,
    properties: P,
    backend: Backend,
    ctx: Context,
    resolve: RelationResolver,
    timestamps: TimestampFields | null = null,
    softDelete: SoftDeleteConfig | null = null,
    generateId: () => string = generateUuid,
    txGuard?: { state: TransactionState; scoped: boolean }
  ) {
    this.modelName = modelName;
    this.properties = properties;
    this.backend = backend;
    this.ctx = ctx;
    this.txState = txGuard?.state ?? { mode: "none" };
    this.scoped = txGuard?.scoped ?? false;
    this.resolve = resolve;
    this.timestamps = timestamps;
    this.softDelete = softDelete;
    this.generateId = generateId;
    this.computedFields = new Set(
      Object.keys(properties).filter((name) => (properties[name] as AnyProperty).kind === "computed")
    );

    // Reactive cache invalidation from the change feed (§7) — also catches writes flushed by a
    // sibling repository sharing this backend (e.g. cascaded relation saves). The same event
    // refreshes the write baseline used for dirty-field diffing (§12): a confirmed write is the
    // new "last known persisted" state for that uuid.
    this.unsubscribe = backend.changes((event) => {
      if (event.model !== this.modelName) return;
      // The record's stored form before this change (for the relevance test below) — captured before
      // we overwrite the baseline. `next` is the post-change form (absent on a delete).
      const previous = this.cache.getBaseline(event.uuid);
      const next = event.kind === "removed" ? undefined : event.record;
      this.cache.invalidateResults();
      if (event.kind === "removed") {
        this.cache.deleteInstance(event.uuid);
        this.cache.deleteBaseline(event.uuid);
      } else if (event.record) {
        this.cache.setBaseline(event.uuid, event.record);
        // A soft-delete lands as a `saved` with the marker set — evict it from the identity map so the
        // next `get()`/relation load re-queries and the default live filter excludes it.
        if (this.softDelete && event.record[this.softDelete.field] != null) {
          this.cache.deleteInstance(event.uuid);
        }
      }
      // Wake only the live queries this change can actually affect: a query re-runs iff the changed
      // record matches its filter before or after the write. An unfiltered query (`matcher === null`)
      // always re-runs. This is conservative-correct — a row outside a query's filter both before and
      // after a change cannot alter that query's result set (membership, order, count, or aggregate).
      for (const listener of this.liveListeners) {
        if (this.changeAffects(listener.matcher, previous, next)) listener.notify();
      }
    }, ctx);
  }

  /** True if a filter is affected by a change from `previous` → `next` (either state matches it). */
  private changeAffects(matcher: Expression | null, previous?: JsonObject, next?: JsonObject): boolean {
    if (!matcher) return true; // unfiltered query — any change to the model is relevant
    return (next != null && matcher.match(next)) || (previous != null && matcher.match(previous));
  }

  /**
   * Register a listener fired after a *relevant* committed change — the reactive hook
   * `liveQuery`/`QueryCollection.subscribe` re-run on. A change to *this* model fires the listener only
   * when the changed record matches `options.where` before or after the write (omit `where` to fire on
   * every change). If the filter reaches across a **reference relation** (`customer.country`), the
   * listener also fires on any change to the referenced target model — a change to a `customer` re-runs
   * an `orders` query filtered by customer fields. Fires on local writes and on changes over the feed
   * (cascades, remote/sync writes). Returns an unsubscribe that detaches every registration.
   */
  subscribeChanges(listener: () => void, options?: { where?: ExpressionNode }): () => void {
    const where = options?.where;
    const relatedModels = new Set<string>();
    if (where) this.collectRelationTargets(where, relatedModels);

    // Own-model relevance: precise only for a plain filter. A ref-relation path (`customer.country`)
    // can't be evaluated by `match()` on the raw stored record (the relation is a bare uuid there), so
    // fall back to "always relevant" on own-model changes rather than risk wrongly skipping one.
    const precise = where && where.type !== "all" && relatedModels.size === 0;
    const entry = { notify: listener, matcher: precise ? parse(where!) : null };
    this.liveListeners.add(entry);

    const unsubscribes: Array<() => void> = [() => this.liveListeners.delete(entry)];
    // Cross-model: re-run on any change to a referenced relation target (coarse on that model — we
    // can't cheaply tell which target rows a given query depends on). Self-relations are already
    // covered by the (now conservative) own-model registration above.
    for (const model of relatedModels) {
      const target = this.resolve(model);
      if (target && target !== (this as unknown as Repository<PropertyMap>)) {
        unsubscribes.push(target.subscribeChanges(listener));
      }
    }
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  /**
   * Collect the target models of every **reference relation** a filter reaches across (the head of a
   * dotted `compare`/`in`/`contains`/`between` path that is a `relationToOne`/`relationToMany`, not an
   * embedded or scalar field) — mirrors `preprocessWhere`'s relation rewrite. Embedded-relation and
   * plain nested paths resolve on the record itself, so they add nothing here.
   */
  private collectRelationTargets(node: ExpressionNode, acc: Set<string>): void {
    switch (node.type) {
      case "compare":
      case "in":
      case "nin":
      case "contains":
      case "between": {
        const dot = node.property.indexOf(".");
        if (dot < 0) return;
        const relation = this.properties[node.property.slice(0, dot)] as AnyProperty | undefined;
        if (
          relation &&
          (relation.kind === "relationToOne" || relation.kind === "relationToMany") &&
          relation.storage !== "embed"
        ) {
          acc.add(relation.targetModel);
        }
        return;
      }
      case "and":
      case "or":
        for (const child of node.expressions) this.collectRelationTargets(child, acc);
        return;
      case "not":
        this.collectRelationTargets(node.expression, acc);
        return;
      case "any":
        this.collectRelationTargets(node.predicate, acc);
        return;
      default:
        return;
    }
  }

  // --- unit of work: create / read / save / patch / upsert -----------------------------------

  /** Build a validated, uuid-stamped instance (not yet persisted — call `save` + `persist`). */
  createInstance(data: Partial<InferModel<P>> = {}): InferModel<P> {
    const source = data as Record_;
    const uuid =
      typeof source.uuid === "string" && source.uuid.length > 0 ? source.uuid : this.generateId();
    const instance: Record_ = { uuid };

    for (const name of Object.keys(this.properties)) {
      const property = this.properties[name] as AnyProperty;
      if (property.kind === "scalar") {
        if (name in source) instance[name] = property.validate(source[name]);
        else if (property.hasDefault) instance[name] = property.makeDefault();
      } else if (property.kind === "computed") {
        // Derived on read — filled by applyComputed below, never from `source`.
        continue;
      } else if (property.kind === "relationToMany") {
        instance[name] = name in source ? (source[name] ?? []) : [];
      } else {
        instance[name] = name in source ? source[name] : null;
      }
    }

    this.applyComputed(instance);
    this.cache.setInstance(uuid, instance as InferModel<P>);
    return instance as InferModel<P>;
  }

  all(): QueryCollection<InferModel<P>> {
    return new QueryCollection<InferModel<P>>(this);
  }

  async get(uuid: Uuid): Promise<InferModel<P> | null> {
    const cached = this.cache.getInstance(uuid);
    if (cached) {
      // A cached instance may be soft-deleted (materialized via an `includeDeleted` read) — exclude it
      // from a default `get`, consistent with `list()`.
      if (this.softDelete && (cached as Record_)[this.softDelete.field] != null) return null;
      return cached;
    }
    const instance = await this.loadOne(uuid);
    return instance as InferModel<P> | null;
  }

  async getMany(uuids: Uuid[]): Promise<InferModel<P>[]> {
    const instances = await this.loadMany(uuids);
    return instances as InferModel<P>[];
  }

  /** Queue an instance (and, via back-references, related instances) for the next `persist`. */
  save(instance: InferModel<P>): this {
    this.enqueueSave(instance as Record_, new Set());
    return this;
  }

  /**
   * Queue an instance for removal on the next `persist`. On a soft-delete model this stamps the
   * `deletedAt` marker and routes through the normal save path (so the whole record is preserved and
   * every read hides it by default); pass `{ hard: true }` to bypass soft-delete and truly delete it.
   */
  remove(instance: InferModel<P>, options?: { hard?: boolean }): this {
    const record = instance as Record_;
    if (this.softDelete && !options?.hard) {
      record[this.softDelete.field] = new Date();
      this.enqueueSave(record, new Set());
    } else {
      this.backend.remove(this.modelName, { uuid: record.uuid as Uuid }, this.ctx);
    }
    return this;
  }

  /**
   * Restore a soft-deleted record — clears its `deletedAt` marker so default reads see it again.
   * Loads the row including soft-deleted, so pass a uuid (soft-deleted rows aren't returned by default).
   * Returns the restored instance, or `null` if no such record exists. Throws if soft-delete is off.
   */
  async restore(uuid: Uuid): Promise<InferModel<P> | null> {
    if (!this.softDelete) throw new Error(`restore() requires softDelete on "${this.modelName}".`);
    const [row] = await this.loadMany([uuid], { includeDeleted: true });
    if (!row) return null;
    (row as Record_)[this.softDelete.field] = null;
    this.enqueueSave(row as Record_, new Set());
    await this.persist();
    return row as InferModel<P>;
  }

  async persist(): Promise<this> {
    await this.backend.persist(this.ctx);
    return this;
  }

  /**
   * AND the live filter (`deletedAt IS NULL`) into a plan's `where` when soft-delete is on and the
   * caller didn't ask to include deleted rows — the one place every read excludes soft-deleted rows.
   * `isNull` is null-or-absent, so a legacy/never-touched row (marker absent) reads as live too.
   */
  private liveWhere(where: ExpressionNode, includeDeleted?: boolean): ExpressionNode {
    if (!this.softDelete || includeDeleted) return where;
    const live = isNull(this.softDelete.field).serialize();
    return where.type === "all" ? live : { type: "and", expressions: [where, live] };
  }

  /**
   * Atomically mutate fields of one record — `patch(uuid, { balance: inc(10), tier: set("gold") })`.
   * Uses the backend's native atomic update ($inc/$mul, SQL arithmetic) when available, else falls
   * back to read-modify-write. Applied immediately (not queued); returns the refreshed instance.
   */
  /**
   * Refuse an immediately-persisting write (`patch`/`patchWhere`/`upsert`) that would silently escape a
   * transaction — its flush commits at once and can't be rolled back with the surrounding unit of work.
   * On a non-transactional backend it can never be atomic; on a real DB transaction only the tx-scoped
   * repository joins it. Surfacing this as an error beats the prior behavior of committing regardless.
   */
  private assertImmediateWriteAllowed(op: string): void {
    if (this.txState.mode === "batching") {
      throw new Error(
        `${op} cannot run inside a transaction on a non-transactional backend — its write commits immediately and won't roll back. Use save()/remove() inside the transaction, or run on a transactional backend (Postgres/MySQL/SQLite via a real tx).`
      );
    }
    if (this.txState.mode === "interactive" && !this.scoped) {
      throw new Error(
        `${op} on the outer repository inside a transaction would commit outside it. Call it on the transaction-scoped repository — tx.repository("${this.modelName}").`
      );
    }
  }

  async patch(uuid: Uuid, spec: PatchSpecFor<InferModel<P>>): Promise<InferModel<P> | null> {
    this.assertImmediateWriteAllowed("patch()");
    const ops = normalizePatch(spec);
    this.stampUpdatedAt(ops);
    if (isPatching(this.backend)) {
      await this.backend.patch(this.modelName, uuid, ops, this.ctx);
    } else {
      const [row] = await this.backend.query(this.planFor(eq("uuid", uuid)), this.ctx);
      if (!row) return null;
      applyPatch(row, ops);
      this.backend.save(this.modelName, row, this.ctx);
      await this.backend.persist(this.ctx);
    }
    // The patch bypassed the change feed (native path) or replaced the record — refresh caches.
    this.cache.invalidateResults();
    this.cache.deleteInstance(uuid);
    return this.get(uuid);
  }

  /**
   * Atomically mutate every record matching `filter` — `patchWhere(lt("stock", 1), { status: set("oos") })`.
   * Uses the backend's native set-update (`updateMany` / SQL `UPDATE ... WHERE`) when available, else
   * falls back to query-then-write. Returns the number of records matched. `filter` is preprocessed so
   * policy/relation rewrites apply exactly as they do for a normal query.
   */
  async patchWhere(filter: Expression, spec: PatchSpecFor<InferModel<P>>): Promise<number> {
    this.assertImmediateWriteAllowed("patchWhere()");
    const ops = normalizePatch(spec);
    this.stampUpdatedAt(ops);
    const pre = await this.preprocessWhere(filter.serialize());
    const plan: QueryPlan = { model: this.modelName, where: pre.node, order: [], paging: { start: 0 } };

    let uuids: Uuid[];
    if (isMultiPatching(this.backend)) {
      // Ids only (cheap) — for precise cache invalidation and the matched-count return; the heavy
      // field rewrite stays server-side in `patchMany`.
      uuids = await this.backend.queryUuids(plan, this.ctx);
      if (uuids.length) await this.backend.patchMany(this.modelName, pre.node, ops, this.ctx);
    } else {
      const rows = await this.backend.query(plan, this.ctx);
      uuids = rows.map((row) => String(row.uuid));
      for (const row of rows) {
        applyPatch(row, ops);
        this.backend.save(this.modelName, row, this.ctx);
      }
      if (rows.length) await this.backend.persist(this.ctx);
    }

    this.cache.invalidateResults();
    for (const uuid of uuids) this.cache.deleteInstance(uuid);
    return uuids.length;
  }

  /**
   * Insert-or-update by a key filter — `upsert(eq("email", e), { set: { name }, setOnInsert: { email: e } })`.
   * If a record matches `match`, its `set` fields are applied (and `updatedAt` bumped); otherwise a new
   * record is created from `setOnInsert` + `set` (with `createdAt` auto-stamped when `timestamps` is on).
   * `setOnInsert` is ignored on update — the `$setOnInsert` semantics. Returns the resulting instance.
   *
   * Read-then-write: the reference semantics, correct on every backend. For racing writers, make the
   * key a `unique` field so the store rejects a duplicate insert (native atomic upsert is a follow-up).
   */
  async upsert(
    match: Expression,
    data: { set?: Partial<InferModel<P>>; setOnInsert?: Partial<InferModel<P>> }
  ): Promise<InferModel<P>> {
    this.assertImmediateWriteAllowed("upsert()");
    const set = data.set ?? {};
    const setOnInsert = data.setOnInsert ?? {};
    const pre = await this.preprocessWhere(match.serialize());
    const plan: QueryPlan = { model: this.modelName, where: pre.node, order: [], paging: { start: 0, end: 1 } };

    // Native atomic upsert when the backend supports it and the data is scalar-only (relations need
    // the read-then-write path to cascade). Otherwise: read-then-write — correct, just not atomic.
    if (isUpserting(this.backend) && this.scalarOnly(set) && this.scalarOnly(setOnInsert)) {
      const encodedSet = this.encodeFields(set);
      const encodedInsert = this.encodeFields(setOnInsert);
      encodedInsert.uuid = this.generateId();
      if (this.timestamps) {
        const now = new Date().getTime(); // stored form of a date is epoch ms
        encodedInsert[this.timestamps.createdAt] = now;
        encodedSet[this.timestamps.updatedAt] = now;
      }
      await this.backend.upsert(this.modelName, pre.node, encodedSet, encodedInsert, this.ctx);
      this.cache.invalidateResults();
    } else {
      const [existing] = await this.execute(plan);
      if (existing) {
        this.applyFields(existing as Record_, set);
        this.save(existing);
      } else {
        this.save(this.createInstance({ ...setOnInsert, ...set } as Partial<InferModel<P>>));
      }
      await this.persist();
    }

    // Return the freshly persisted instance (re-read so relations/decoding are consistent).
    const [result] = await this.runQuery(plan);
    return result as InferModel<P>;
  }

  private scalarOnly(data: Partial<InferModel<P>>): boolean {
    return Object.keys(data as Record_).every((name) => {
      const property = this.properties[name] as AnyProperty | undefined;
      return !property || property.kind === "scalar";
    });
  }

  /** Validate + encode the provided scalar fields to their stored JSON form. */
  private encodeFields(data: Partial<InferModel<P>>): JsonObject {
    const source = data as Record_;
    const encoded: JsonObject = {};
    for (const name of Object.keys(source)) {
      const property = this.properties[name] as AnyProperty | undefined;
      if (property?.kind === "scalar") encoded[name] = property.encode(property.validate(source[name])) as JsonValue;
    }
    return encoded;
  }

  /** Validate + assign the provided fields onto an instance (scalars validated; relations assigned). */
  private applyFields(instance: Record_, data: Partial<InferModel<P>>): void {
    const source = data as Record_;
    for (const name of Object.keys(source)) {
      const property = this.properties[name] as AnyProperty | undefined;
      if (!property) continue;
      instance[name] = property.kind === "scalar" ? property.validate(source[name]) : source[name];
    }
  }

  dispose(): void {
    this.unsubscribe();
  }

  // --- Queryable -----------------------------------------------------------------------------

  /**
   * Reject a sort by a computed/virtual field early: it isn't in any stored row on any backend, so
   * ordering by it would be a silent no-op (every row compares equal). A filter by one is likewise a
   * no-op but caught in `preprocessWhere`. This keeps the footgun a clear error, not a mystery.
   */
  private guardOrder(order: readonly SortKey[]): void {
    if (this.computedFields.size === 0) return;
    for (const key of order) {
      if (this.computedFields.has(key.property)) {
        throw new Error(
          `Cannot sort "${this.modelName}" by computed field "${key.property}" — it is not stored. ` +
            `Sort by a stored field, or compute the ordering in memory after the query.`
        );
      }
    }
  }

  async runQuery(plan: QueryPlan, options?: ReadOptions): Promise<InferModel<P>[]> {
    this.guardOrder(plan.order);
    plan = { ...plan, where: this.liveWhere(plan.where, options?.includeDeleted) };
    const pre = await this.preprocessWhere(plan.where);
    if (pre.rewritten) {
      return this.execute({ ...plan, where: pre.node }); // relational query: not result-cached
    }

    const hash = planHash(plan);
    const cached = this.cache.getResult(hash);
    if (cached) return cached;

    const typed = await this.execute(plan);
    this.cache.setResult(hash, typed);
    return typed;
  }

  async runQueryUuids(plan: QueryPlan, options?: ReadOptions): Promise<Uuid[]> {
    this.guardOrder(plan.order);
    plan = { ...plan, where: this.liveWhere(plan.where, options?.includeDeleted) };
    return this.backend.queryUuids(await this.effectivePlan(plan), this.ctx);
  }

  async runCount(plan: QueryPlan, options?: ReadOptions): Promise<number> {
    plan = { ...plan, where: this.liveWhere(plan.where, options?.includeDeleted) };
    const effective = await this.effectivePlan(plan);
    if (isCounting(this.backend)) return this.backend.count(effective, this.ctx);
    return (await this.backend.query(effective, this.ctx)).length; // fallback: count without hydrating
  }

  /**
   * Push a grouped aggregate down to the backend when it can do it natively; `null` signals the
   * caller (`QueryCollection`) to reduce in memory instead. The `where` is preprocessed first so
   * policy/relation rewrites apply exactly as they do for a normal query.
   */
  async runAggregate(plan: AggregatePlan, options?: ReadOptions): Promise<AggregateResultRow[] | null> {
    if (!isAggregating(this.backend)) return null;
    plan = { ...plan, where: this.liveWhere(plan.where, options?.includeDeleted) };
    const pre = await this.preprocessWhere(plan.where);
    const effective = pre.rewritten ? { ...plan, where: pre.node } : plan;
    return this.backend.aggregate(effective, this.ctx);
  }

  /**
   * Push a ranking window down to the backend when it can; `null` signals `QueryCollection` to compute
   * it in memory. Backend rows come back in stored form (like a query) with the window columns merged;
   * materialize the scalars to a runtime instance and carry the window columns through untouched.
   */
  async runWindow(plan: WindowPlan, options?: ReadOptions): Promise<InferModel<P>[] | null> {
    this.guardOrder(plan.order);
    if (!isWindowing(this.backend)) return null;
    plan = { ...plan, where: this.liveWhere(plan.where, options?.includeDeleted) };
    const pre = await this.preprocessWhere(plan.where);
    const effective = pre.rewritten ? { ...plan, where: pre.node } : plan;
    const rows = await this.backend.window(effective, this.ctx);
    if (!rows) return null;
    return rows.map((row) => {
      const instance = this.decodeScalars(row) as Record_;
      for (const fn of plan.functions) instance[fn.name] = row[fn.name];
      return instance as InferModel<P>;
    });
  }

  /** Encode a scalar's runtime value to its stored, comparable form (uuid/unknown pass through). */
  encodeKey(property: string, value: unknown): JsonValue {
    const property_ = this.properties[property] as AnyProperty | undefined;
    if (property_?.kind === "scalar") return property_.encode(property_.validate(value)) as JsonValue;
    return value as JsonValue;
  }

  /** Run a (already-preprocessed) plan: fetch, materialize into the identity map, load relations. */
  private async execute(plan: QueryPlan): Promise<InferModel<P>[]> {
    const rows = await this.backend.query(plan, this.ctx);
    // Two phases so every result is in the identity map before any relation loading begins —
    // that is what makes the eager cross-repository loading below cycle-safe.
    const instances = rows.map((row) => this.materialize(row));
    await this.loadRelationsForBatch(instances, rows);
    return instances as InferModel<P>[];
  }

  private async effectivePlan(plan: QueryPlan): Promise<QueryPlan> {
    const pre = await this.preprocessWhere(plan.where);
    return pre.rewritten ? { ...plan, where: pre.node } : plan;
  }

  // --- projection-driven loading (for select) ------------------------------------------------
  //
  // Builds untracked instances that load ONLY the relations named in the include tree, recursing
  // just as deep as the selection goes. Because the tree is finite there are no cycles, and because
  // the instances aren't put in the identity map there's no partial-load cache pollution.

  async runProject(plan: QueryPlan, selection: Selection, options?: ReadOptions): Promise<unknown[]> {
    plan = { ...plan, where: this.liveWhere(plan.where, options?.includeDeleted) };
    const effective = await this.effectivePlan(plan);
    const rows = await this.backend.query({ ...effective, project: neededFields(selection) }, this.ctx);
    return this.loadProjectedBatch(rows, selection);
  }

  /**
   * Build projected instances for a whole page of rows, loading each relation named in the selection
   * **once across the batch** (one `WHERE uuid IN (…)` per relation level) rather than once per row —
   * the projection-path analogue of `loadRelationsForBatch`, so nested `select`s cost O(relations ×
   * depth) queries, not O(rows). Instances are untracked (not in the identity map), so no partial-load
   * cache pollution; the selection tree is finite, so the recursion is cycle-free.
   */
  private async loadProjectedBatch(rows: JsonObject[], selection: Selection): Promise<Record_[]> {
    const instances = rows.map((row) => this.decodeScalars(row)); // uuid + scalars only
    for (const [name, sel] of Object.entries(selection)) {
      if (isValueExpr(sel)) continue; // computed: evaluated later by projectValue
      const property = this.properties[name] as AnyProperty | undefined;
      // scalar (incl. nested json) is already in the row; computed isn't projectable in v1 (opaque closure).
      if (!property || property.kind === "scalar" || property.kind === "computed") continue;
      const target = this.targetFor(property.targetModel, name);
      const sub: Selection = sel === true ? allScalarsSelection(target.properties) : sel;

      if (property.kind === "relationToOne") {
        if (property.storage === "embed") {
          const nested = rows.map((row) => (isRecord(row[name]) ? (row[name] as JsonObject) : null));
          const loaded = await target.loadProjectedBatch(nested.filter((n): n is JsonObject => n !== null), sub);
          let i = 0;
          instances.forEach((instance, idx) => (instance[name] = nested[idx] ? loaded[i++]! : null));
        } else {
          const refs = rows.map((row) => (typeof row[name] === "string" && row[name] ? String(row[name]) : null));
          const byId = await target.loadProjectedByUuids([...new Set(refs.filter((r): r is string => r !== null))], sub);
          instances.forEach((instance, idx) => (instance[name] = refs[idx] ? (byId.get(refs[idx]!) ?? null) : null));
        }
      } else if (property.storage === "embed") {
        const childLists = rows.map((row) => (Array.isArray(row[name]) ? (row[name] as JsonObject[]) : []));
        const loaded = await target.loadProjectedBatch(childLists.flat(), sub);
        let i = 0;
        instances.forEach((instance, idx) => (instance[name] = childLists[idx]!.map(() => loaded[i++]!)));
      } else {
        const refLists = rows.map((row) => (Array.isArray(row[name]) ? (row[name] as Uuid[]) : []));
        const byId = await target.loadProjectedByUuids([...new Set(refLists.flat())], sub);
        instances.forEach(
          (instance, idx) =>
            (instance[name] = refLists[idx]!.map((u) => byId.get(u)).filter((x): x is Record_ => x !== undefined))
        );
      }
    }
    return instances;
  }

  /** Load records by uuid and project them, keyed by uuid for distribution back to the parent batch. */
  private async loadProjectedByUuids(uuids: Uuid[], selection: Selection): Promise<Map<string, Record_>> {
    if (uuids.length === 0) return new Map();
    // A projected relation load excludes soft-deleted targets by default (like the eager path).
    const where = this.liveWhere(inList("uuid", uuids).serialize());
    const plan = { model: this.modelName, where, order: [] as SortKey[], paging: { start: 0 }, project: neededFields(selection) };
    const rows = await this.backend.query(plan, this.ctx);
    const loaded = await this.loadProjectedBatch(rows, selection);
    return new Map(loaded.map((instance) => [String(instance.uuid), instance]));
  }

  // --- filter rewriting (cross-relation predicates) ------------------------------------------

  /**
   * Rewrite filters that reach across a *reference* relation (ARCHITECTURE.md §6): a `customer.country`
   * predicate on Order is resolved by sub-querying the Customer repository for matching uuids and
   * rewriting to a local uuid filter (`in`/`contains`). Portable — it runs on every backend; a
   * native JOIN/$lookup would be the per-backend optimization of this same rewrite. Embedded paths
   * and nested scalar paths pass through untouched (the backend handles them).
   */
  private async preprocessWhere(
    node: ExpressionNode
  ): Promise<{ node: ExpressionNode; rewritten: boolean }> {
    switch (node.type) {
      case "compare":
      case "in":
      case "contains":
      case "between": {
        // A computed/virtual field is in no stored row, so a filter on it would silently match
        // nothing on every backend — reject it early with a clear error instead.
        if (this.computedFields.has(node.property.split(".")[0]!)) {
          throw new Error(
            `Cannot filter "${this.modelName}" by computed field "${node.property}" — it is not stored. ` +
              `Filter by a stored field, or filter in memory after the query.`
          );
        }
        // Array-element equality: on a declared `array()` field, `eq(field, scalar)` means "the array
        // *contains* scalar" (Mongo's `{ field: scalar }` semantics) — whole-array-vs-scalar equality
        // never matches. Rewrite to `contains` (and `!=` to its negation) so it's correct on every
        // backend; scalar-typed fields are untouched, so their equality still pushes down.
        if (
          node.type === "compare" &&
          (node.comparator === "=" || node.comparator === "!=") &&
          !node.property.includes(".") &&
          node.value !== null &&
          !Array.isArray(node.value)
        ) {
          const prop = this.properties[node.property] as AnyProperty | undefined;
          if (prop?.kind === "scalar" && prop.type === "array") {
            const membership = contains(node.property, node.value);
            const rewritten = node.comparator === "=" ? membership : not(membership);
            return { node: rewritten.serialize(), rewritten: true };
          }
        }
        const dot = node.property.indexOf(".");
        if (dot < 0) return { node, rewritten: false };
        const local = node.property.slice(0, dot);
        const rest = node.property.slice(dot + 1);
        const relation = this.properties[local] as AnyProperty | undefined;
        if (!relation || relation.kind === "scalar" || relation.kind === "computed" || relation.storage === "embed") {
          return { node, rewritten: false };
        }
        const target = this.targetFor(relation.targetModel, local);
        const subFilter = parse({ ...node, property: rest } as ExpressionNode);
        const uuids = await target.all().filter(subFilter).listUuids();
        const rewritten =
          relation.kind === "relationToOne"
            ? inList(local, uuids).serialize()
            : or(...uuids.map((uuid) => contains(local, uuid))).serialize();
        return { node: rewritten, rewritten: true };
      }
      case "and":
      case "or": {
        const children = await Promise.all(node.expressions.map((child) => this.preprocessWhere(child)));
        if (!children.some((child) => child.rewritten)) return { node, rewritten: false };
        return { node: { type: node.type, expressions: children.map((child) => child.node) }, rewritten: true };
      }
      case "not": {
        const inner = await this.preprocessWhere(node.expression);
        return inner.rewritten
          ? { node: { type: "not", expression: inner.node }, rewritten: true }
          : { node, rewritten: false };
      }
      default:
        return { node, rewritten: false };
    }
  }

  // --- relation loading (cross-repository entry points) --------------------------------------

  /** Load one related record by uuid (identity-cache first, then the backend). */
  private async loadOne(uuid: Uuid, options?: ReadOptions): Promise<Record_ | null> {
    const [first] = await this.loadMany([uuid], options);
    return first ?? null;
  }

  /**
   * Load related records by uuid. Cached instances are reused as-is (shared references), so a
   * relation pointing back at an instance already being loaded resolves from the cache instead of
   * recursing forever. On a soft-delete model, deleted rows are excluded by default (both from the
   * backend query and a cached-but-deleted instance) unless `includeDeleted` is set.
   */
  private async loadMany(uuids: Uuid[], options?: ReadOptions): Promise<Record_[]> {
    if (uuids.length === 0) return [];

    const resolved = new Map<Uuid, Record_>();
    const missing: Uuid[] = [];
    for (const uuid of uuids) {
      const cached = this.cache.getInstance(uuid) as Record_ | undefined;
      if (cached) {
        if (this.softDelete && !options?.includeDeleted && cached[this.softDelete.field] != null) continue; // deleted → excluded
        resolved.set(uuid, cached);
      } else missing.push(uuid);
    }

    if (missing.length > 0) {
      const where = this.liveWhere(inList("uuid", missing).serialize(), options?.includeDeleted);
      const rows = await this.backend.query({ model: this.modelName, where, order: [], paging: { start: 0 } }, this.ctx);
      const created = rows.map((row) => this.materialize(row));
      await this.loadRelationsForBatch(created, rows);
      for (const instance of created) resolved.set(String(instance.uuid), instance);
    }

    // Preserve the requested order; drop uuids that no longer exist.
    return uuids.map((uuid) => resolved.get(uuid)).filter((x): x is Record_ => x !== undefined);
  }

  // --- (de)serialization ---------------------------------------------------------------------

  /** Build (or refresh) an instance's scalar fields and cache it, without loading relations. */
  private materialize(row: JsonObject): Record_ {
    const uuid = String(row.uuid);
    let instance = this.cache.getInstance(uuid) as Record_ | undefined;
    if (!instance) {
      instance = { uuid };
      this.cache.setInstance(uuid, instance as InferModel<P>);
    }
    // A freshly-loaded row is confirmed backend truth — record it as the write baseline (§12) even
    // when no change event fired for it (e.g. its first-ever load in this process).
    this.cache.setBaseline(uuid, row);

    for (const name of Object.keys(this.properties)) {
      const property = this.properties[name] as AnyProperty;
      if (property.kind === "scalar") {
        const value = row[name];
        if (value !== undefined) instance[name] = property.decode(value);
      } else if (property.kind === "computed") {
        continue; // derived below, after all scalars are decoded
      } else if (!(name in instance)) {
        instance[name] = property.kind === "relationToMany" ? [] : null;
      }
    }
    this.applyComputed(instance);
    return instance;
  }

  /**
   * Derive every computed/virtual field from the instance's already-decoded scalar fields
   * (ARCHITECTURE.md §5). Runs on every full read (`materialize`) and at `createInstance`; the value
   * is a normal own property but is never serialized (see `serialize`), so it never reaches a backend.
   */
  private applyComputed(instance: Record_): void {
    for (const name of Object.keys(this.properties)) {
      const property = this.properties[name] as AnyProperty;
      if (property.kind === "computed") instance[name] = property.compute(instance);
    }
  }

  /** Decode just the scalar fields of a row into a fresh, untracked object (for projection). */
  private decodeScalars(row: JsonObject): Record_ {
    const instance: Record_ = { uuid: String(row.uuid) };
    for (const name of Object.keys(this.properties)) {
      const property = this.properties[name] as AnyProperty;
      if (property.kind === "scalar") {
        const value = row[name];
        if (value !== undefined) instance[name] = property.decode(value);
      }
    }
    return instance;
  }

  /**
   * Load every relation for a *batch* of sibling instances, one relation at a time — collecting the
   * refs across the whole batch into a single `WHERE uuid IN (…)` load per relation instead of one
   * query per row (the N+1 fix). Reference relations fetch through the target's `loadMany` (which
   * itself batches its own relations, so the whole tree costs O(depth × relations), not O(rows));
   * embedded relations materialize inline and recurse batched. The identity map keeps it cycle-safe.
   */
  private async loadRelationsForBatch(instances: Record_[], rows: JsonObject[]): Promise<void> {
    if (instances.length === 0) return;
    const relations = Object.keys(this.properties).filter((name) => {
      const kind = (this.properties[name] as AnyProperty).kind;
      return kind === "relationToOne" || kind === "relationToMany";
    });
    await Promise.all(relations.map((name) => this.loadRelationBatched(name, instances, rows)));
  }

  /** Load a single named relation across the batch — one query for reference relations. */
  private async loadRelationBatched(name: string, instances: Record_[], rows: JsonObject[]): Promise<void> {
    const property = this.properties[name] as AnyProperty;
    const target = this.targetFor((property as { targetModel: string }).targetModel, name);

    if (property.kind === "relationToOne") {
      if (property.storage === "embed") {
        const children: Record_[] = [];
        const childRows: JsonObject[] = [];
        instances.forEach((instance, i) => {
          const nested = rows[i]![name];
          if (isRecord(nested)) {
            const child = target.materialize(nested);
            instance[name] = child;
            children.push(child);
            childRows.push(nested);
          } else {
            instance[name] = null;
          }
        });
        await target.loadRelationsForBatch(children, childRows);
      } else {
        const refs = rows.map((row) => row[name]);
        const unique = [...new Set(refs.filter((r): r is string => typeof r === "string" && r.length > 0))];
        const byId = indexByUuid(await target.loadMany(unique));
        instances.forEach((instance, i) => {
          const ref = rows[i]![name];
          instance[name] = typeof ref === "string" && ref ? (byId.get(ref) ?? null) : null;
        });
      }
      return;
    }
    if (property.kind !== "relationToMany") return; // (only relation names reach here)

    if (property.storage === "embed") {
      const children: Record_[] = [];
      const childRows: JsonObject[] = [];
      instances.forEach((instance, i) => {
        const nested = Array.isArray(rows[i]![name]) ? (rows[i]![name] as JsonObject[]) : [];
        instance[name] = nested.map((child) => {
          const built = target.materialize(child);
          children.push(built);
          childRows.push(child);
          return built;
        });
      });
      await target.loadRelationsForBatch(children, childRows);
    } else {
      const allRefs = new Set<Uuid>();
      const perInstance = rows.map((row) => {
        const refs = Array.isArray(row[name]) ? (row[name] as Uuid[]) : [];
        for (const ref of refs) allRefs.add(ref);
        return refs;
      });
      const byId = indexByUuid(await target.loadMany([...allRefs]));
      instances.forEach((instance, i) => {
        instance[name] = perInstance[i]!.map((ref) => byId.get(ref)).filter((x): x is Record_ => x !== undefined);
      });
    }
  }

  private serialize(instance: Record_): JsonObject {
    const json: JsonObject = { uuid: instance.uuid as JsonValue };
    for (const name of Object.keys(this.properties)) {
      const property = this.properties[name] as AnyProperty;
      if (property.kind === "computed") {
        continue; // virtual — never stored (the hinge that keeps it off every backend + out of _extra)
      } else if (property.kind === "scalar") {
        const value = instance[name];
        if (value !== undefined) json[name] = property.encode(value);
      } else if (property.kind === "relationToOne") {
        const related = instance[name] as Record_ | null | undefined;
        if (property.storage === "embed") {
          json[name] = related ? this.targetFor(property.targetModel, name).serialize(related) : null;
        } else {
          json[name] = related ? (related.uuid as JsonValue) : null;
        }
      } else {
        const related = Array.isArray(instance[name]) ? (instance[name] as Record_[]) : [];
        if (property.storage === "embed") {
          const target = this.targetFor(property.targetModel, name);
          json[name] = related.map((item) => target.serialize(item));
        } else {
          json[name] = related.map((item) => item.uuid as JsonValue);
        }
      }
    }
    return json;
  }

  // --- writes (with inverse maintenance) -----------------------------------------------------

  /** Queue `instance`, keeping declared inverse relations in sync, guarded against cycles. */
  private enqueueSave(instance: Record_, visited: Set<object>): void {
    if (visited.has(instance)) return;
    visited.add(instance);

    this.applyTimestamps(instance);
    this.enforceScalars(instance);
    const uuid = instance.uuid as Uuid;
    this.cache.setInstance(uuid, instance as InferModel<P>);
    this.maintainInverse(instance, visited);
    const record = this.serialize(instance);
    this.backend.save(this.modelName, record, this.ctx, this.computeDirty(uuid, record));
  }

  /**
   * Which top-level fields of `record` actually changed since the write baseline (§12) — `undefined`
   * when there's no known baseline (never loaded/persisted: a genuine insert) or nothing changed
   * (treated the same as "no hint" rather than an empty field list, which would leave a backend's
   * scoped `UPDATE`/`SET` clause with nothing to set).
   */
  private computeDirty(uuid: Uuid, record: JsonObject): readonly string[] | undefined {
    const baseline = this.cache.getBaseline(uuid);
    if (!baseline) return undefined;
    const dirty: string[] = [];
    for (const key of new Set([...Object.keys(baseline), ...Object.keys(record)])) {
      if (key !== "uuid" && !sameValue(baseline[key], record[key])) dirty.push(key);
    }
    return dirty.length ? dirty : undefined;
  }

  /**
   * On write, fill any absent field that declares a `default`, then reject a still-absent/null
   * `required` field — so validation is enforced even for instances not built via `createInstance`.
   */
  private enforceScalars(instance: Record_): void {
    for (const name of Object.keys(this.properties)) {
      const property = this.properties[name] as AnyProperty;
      if (property.kind !== "scalar") continue;
      if (instance[name] === undefined && property.hasDefault) instance[name] = property.makeDefault();
      if ((instance[name] === undefined || instance[name] === null) && property.required) {
        throw new ValidationError([{ message: `Field "${name}" is required on "${this.modelName}".`, path: [name] }]);
      }
    }
  }

  /** Set `createdAt` once (first save) and `updatedAt` on every save (when `timestamps` is on). */
  private applyTimestamps(instance: Record_): void {
    if (!this.timestamps) return;
    const now = new Date();
    if (instance[this.timestamps.createdAt] == null) instance[this.timestamps.createdAt] = now;
    instance[this.timestamps.updatedAt] = now;
  }

  /** Add an `updatedAt` set to a patch (stored epoch ms) unless the caller set it explicitly. */
  private stampUpdatedAt(ops: Record<string, PatchOp>): void {
    if (this.timestamps && !(this.timestamps.updatedAt in ops)) {
      ops[this.timestamps.updatedAt] = { kind: "set", value: new Date().getTime() };
    }
  }

  private maintainInverse(instance: Record_, visited: Set<object>): void {
    for (const name of Object.keys(this.properties)) {
      const property = this.properties[name] as AnyProperty;
      if (property.kind === "scalar" || property.kind === "computed") continue;
      // Embedded children are owned and saved inline with the parent — no inverse, no cascade.
      if (property.storage === "embed" || !property.remoteProperty) continue;

      const target = this.targetFor(property.targetModel, name);
      const remoteName = property.remoteProperty;
      const remote = target.properties[remoteName] as AnyProperty | undefined;
      const related =
        property.kind === "relationToOne"
          ? instance[name]
            ? [instance[name] as Record_]
            : []
          : Array.isArray(instance[name])
            ? (instance[name] as Record_[])
            : [];

      for (const y of related) {
        if (remote?.kind === "relationToMany") {
          let arr = y[remoteName] as Record_[] | undefined;
          if (!Array.isArray(arr)) {
            arr = [];
            y[remoteName] = arr;
          }
          if (!arr.some((o) => o.uuid === instance.uuid)) arr.push(instance);
        } else if (remote?.kind === "relationToOne") {
          y[remoteName] = instance;
        }
        target.enqueueSave(y, visited);
      }
    }
  }

  // --- helpers -------------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private targetFor(model: string, propertyName: string): Repository<any> {
    const target = this.resolve(model);
    if (!target) {
      throw new Error(
        `Relation "${this.modelName}.${propertyName}" targets unknown model "${model}". ` +
          `Define it on the same RepositoryManager.`
      );
    }
    return target;
  }

  private planFor(where: Expression): QueryPlan {
    return { model: this.modelName, where: where.serialize(), order: [], paging: { start: 0 } };
  }
}

function planHash(plan: QueryPlan): string {
  return JSON.stringify({ where: plan.where, order: plan.order, paging: plan.paging });
}

/** Index loaded records by uuid, for distributing a batched relation load back to each parent. */
function indexByUuid(records: Record_[]): Map<Uuid, Record_> {
  return new Map(records.map((record) => [String(record.uuid), record]));
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
