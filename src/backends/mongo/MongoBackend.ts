import type {
  AggregatingBackend,
  Backend,
  ChangeEvent,
  ChangeListener,
  CountingBackend,
  IndexSpec,
  MultiPatchingBackend,
  RawQueryable,
  SchemaAwareBackend,
  PatchOp,
  PatchingBackend,
  PersistResult,
  PersistedChange,
  Unsubscribe,
  UpsertingBackend
} from "../../core/Backend.ts";
import type { Capabilities, Context, JsonObject, JsonValue, Uuid } from "../../core/types.ts";
import type { QueryPlan, Comparator, AggregatePlan, AggregateResultRow, AggregateStage, ExpressionNode, DatePart, ValueNode, TextMode } from "../../core/QueryPlan.ts";
import { generateUuid } from "../../core/uuid.ts";
import type { Expression } from "../../expressions/Expression.ts";
import type { ExpressionVisitor } from "../../expressions/visitor.ts";
import type { ValueExpr, ValueVisitor } from "../../expressions/values.ts";
import type { ArithOp } from "../../core/QueryPlan.ts";
import { parse } from "../../expressions/parse.ts";
import { parseValue } from "../../expressions/values.ts";
import { UniqueConstraintError, uniqueKey, uniqueKeySets, sameBatchConflict } from "../util/unique.ts";

/** Backend-level options for `MongoBackend`. */
export interface MongoBackendOptions {
  /**
   * Run a pre-emptive `find` before a write to raise a friendly `UniqueConstraintError` (matching the
   * in-memory reference) instead of relying on the collection's unique index to throw. Off by default —
   * it costs one round-trip per model per unique key. Not a lock (Mongo has no transaction here), so a
   * concurrent inserter is still only caught by the unique index.
   */
  uniquePreCheck?: boolean;
}

/**
 * Minimal structural view of the `mongodb` driver, so the library carries no `mongodb` dependency;
 * the caller injects a `Db`. The real driver's `Collection`/`Db` match these shapes.
 */
export interface MongoFindOptions {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
  projection?: Record<string, 0 | 1>;
}
export interface MongoCursor {
  toArray(): Promise<Record<string, unknown>[]>;
}
export interface MongoCollection {
  find(filter: MongoFilter, options?: MongoFindOptions): MongoCursor;
  countDocuments(filter: MongoFilter): Promise<number>;
  aggregate(pipeline: object[]): MongoCursor;
  createIndex(keys: Record<string, unknown>, options?: object): Promise<unknown>;
  bulkWrite(operations: object[]): Promise<unknown>;
  updateOne(filter: MongoFilter, update: object, options?: { upsert?: boolean }): Promise<unknown>;
  updateMany(filter: MongoFilter, update: object): Promise<unknown>;
}
export interface MongoDatabase {
  collection(name: string): MongoCollection;
}

export type MongoFilter = Record<string, unknown>;

/**
 * How the ORM's string identity (`uuid`) maps to the document's stored key and to foreign-key fields
 * — the bridge for adopting an existing Mongo collection keyed on `ObjectId _id` (ARCHITECTURE.md §5).
 * The default keys on a plain `uuid` field (string identity, no `_id`). `objectIdIdentity` keys on
 * `_id` and maps designated reference fields, so model code sees hex strings while Mongo sees ObjectIds.
 */
export interface MongoIdentity {
  /** The Mongo field used as the document key — `"uuid"` (default) or `"_id"`. */
  field: string;
  /** Model id string → the stored key value (identity for `uuid`; an `ObjectId` for `_id`). */
  encode(id: string): unknown;
  /** Stored key value → model id string. */
  decode(stored: unknown): string;
  /** Per-model foreign-key fields whose stored values are ids, mapped like the key on read/write/filter. */
  references?: Record<string, readonly string[]>;
}

const UUID_IDENTITY: MongoIdentity = {
  field: "uuid",
  encode: (id) => id,
  decode: (stored) => String(stored)
};

/**
 * Adopt an existing `ObjectId`-keyed collection: `_id` and the named foreign-key fields cross the
 * boundary as 24-hex strings (the model's `uuid`) and are stored as driver `ObjectId`s. Pass your
 * driver's `ObjectId` constructor (no `mongodb` dependency in the library). Pair with a matching
 * `generateId` on the `RepositoryManager` so new records mint `ObjectId`-shaped ids.
 */
export function objectIdIdentity(
  ObjectId: new (hex: string) => unknown,
  references?: Record<string, readonly string[]>
): MongoIdentity {
  return { field: "_id", encode: (id) => new ObjectId(id), decode: (stored) => String(stored), references };
}

/** Map a stored document to an ORM record: extract `uuid` from the key, decode FK ids, drop `_id`. */
function fromStored(doc: Record<string, unknown>, model: string, identity: MongoIdentity): JsonObject {
  const record: Record<string, unknown> = { ...doc, uuid: identity.decode(doc[identity.field]) };
  if (identity.field !== "uuid") delete record[identity.field];
  delete record._id; // BSON internal: the key for _id-identity (already extracted), or Mongo's auto id
  for (const ref of identity.references?.[model] ?? []) {
    if (record[ref] != null) record[ref] = identity.decode(record[ref]);
  }
  return record as JsonObject;
}

/** Map ORM-side fields to stored form: encode `uuid` into the key field and encode FK ids (partial-safe). */
function toStoredFields(
  fields: Record<string, unknown>,
  model: string,
  identity: MongoIdentity
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  if ("uuid" in out) {
    out[identity.field] = identity.encode(String(out.uuid));
    if (identity.field !== "uuid") delete out.uuid;
  }
  for (const ref of identity.references?.[model] ?? []) {
    if (out[ref] != null) out[ref] = identity.encode(String(out[ref]));
  }
  return out;
}

/** The `{ key: encodedId }` filter selecting one record by its model id. */
function keyFilter(id: string, identity: MongoIdentity): MongoFilter {
  return { [identity.field]: identity.encode(id) };
}

const CAPABILITIES: Capabilities = {
  indexes: true,
  ranges: true,
  sortPushdown: true,
  joins: false, // relations decompose-and-stitch; $lookup push-down is future
  transactions: false, // requires a replica set; persist uses an unordered bulkWrite
  changeFeed: true
};

/**
 * A compiling backend over MongoDB (ARCHITECTURE.md §3, §11). The expression AST compiles almost
 * 1:1 to a Mongo query filter, with sort/skip/limit and `countDocuments` pushed down to the server.
 *
 * Scaffold status: the query compiler and backend are complete and unit-tested against a faithful
 * in-memory filter evaluator; a live round-trip needs a running MongoDB (gate an integration test
 * on a MONGO_URL env var). The change feed is process-local for now — real Mongo change streams
 * (which need a replica set) are a follow-up.
 */
/**
 * A raw Mongo query the compiler can't express: an aggregation pipeline over one collection, run
 * as-is. This is the Mongo shape of `RawQueryable`'s `Q`.
 */
export interface MongoRawQuery {
  collection: string;
  pipeline: object[];
}

export class MongoBackend
  implements
    Backend,
    SchemaAwareBackend,
    CountingBackend,
    PatchingBackend,
    MultiPatchingBackend,
    UpsertingBackend,
    AggregatingBackend,
    RawQueryable<MongoRawQuery>
{
  readonly capabilities = CAPABILITIES;

  private readonly db: MongoDatabase;
  private readonly identity: MongoIdentity;
  private readonly uniquePreCheck: boolean;
  private readonly uniqueKeys = new Map<string, string[][]>();
  private saveQueue: PersistedChange[] = [];
  private removeQueue: PersistedChange[] = [];
  private readonly listeners = new Set<ChangeListener>();

  constructor(database: MongoDatabase, identity: MongoIdentity = UUID_IDENTITY, options: MongoBackendOptions = {}) {
    this.db = database;
    this.identity = identity;
    this.uniquePreCheck = options.uniquePreCheck ?? false;
  }

  private filter(model: string, where: ExpressionNode): MongoFilter {
    return compileMongoFilter(where, this.identity, model);
  }

  registerModel(model: string, indexes: IndexSpec[]): void {
    if (this.uniquePreCheck) this.uniqueKeys.set(model, uniqueKeySets(indexes));
    const collection = this.db.collection(model);
    for (const index of indexes) {
      const keys = Object.fromEntries(
        index.fields.map((f) => [
          f.path === "uuid" ? this.identity.field : f.path,
          index.text ? "text" : f.descending ? -1 : 1
        ])
      );
      const options: Record<string, unknown> = { name: index.name };
      if (index.unique) options.unique = true;
      if (index.sparse) options.sparse = true;
      if (index.ttlSeconds !== undefined) options.expireAfterSeconds = index.ttlSeconds;
      if (index.where) options.partialFilterExpression = this.filter(model, index.where);
      void collection.createIndex(keys, options); // provisioning; fire-and-forget
    }
  }

  async query(plan: QueryPlan, _ctx: Context): Promise<JsonObject[]> {
    const docs = await this.db
      .collection(plan.model)
      .find(this.filter(plan.model, plan.where), findOptions(plan, this.identity))
      .toArray();
    return docs.map((doc) => fromStored(doc, plan.model, this.identity));
  }

  /**
   * Escape hatch for an aggregation pipeline the compiler can't express (`$lookup`, `$facet`,
   * `$graphLookup`, …). Runs on the injected `Db` and returns the pipeline's output documents
   * untouched — no identity mapping, since the shape is the caller's.
   */
  async raw<R extends Record<string, unknown> = Record<string, unknown>>(
    query: MongoRawQuery,
    _ctx: Context
  ): Promise<R[]> {
    return (await this.db.collection(query.collection).aggregate(query.pipeline).toArray()) as R[];
  }

  async queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    return (await this.query(plan, ctx)).map((doc) => String(doc.uuid));
  }

  count(plan: QueryPlan, _ctx: Context): Promise<number> {
    return this.db.collection(plan.model).countDocuments(this.filter(plan.model, plan.where));
  }

  async aggregate(plan: AggregatePlan, _ctx: Context): Promise<AggregateResultRow[]> {
    const group: Record<string, unknown> = { _id: groupId(plan.groupBy) };
    for (const agg of plan.aggregates) group[agg.name] = aggregateAccumulator(agg);
    const pipeline = [{ $match: this.filter(plan.model, plan.where) }, { $group: group }];
    const docs = await this.db.collection(plan.model).aggregate(pipeline).toArray();
    return docs.map((doc) => ({
      key: keyOf(doc._id, plan.groupBy),
      values: Object.fromEntries(
        plan.aggregates.map((agg) => {
          // countDistinct returned the `$addToSet` array — size it, skipping null (matches COUNT(DISTINCT)).
          if (agg.op === "countDistinct") {
            const set = (doc[agg.name] as unknown[] | undefined) ?? [];
            return [agg.name, set.filter((v) => v !== null && v !== undefined).length];
          }
          // A null/absent accumulator (empty group via $min/$max/$avg) coalesces to 0, matching the reference.
          return [agg.name, Number(doc[agg.name] ?? 0)];
        })
      )
    }));
  }

  async patch(model: string, uuid: string, ops: Record<string, PatchOp>, _ctx: Context): Promise<void> {
    await this.db.collection(model).updateOne(keyFilter(uuid, this.identity), compileMongoUpdate(ops));
  }

  async patchMany(model: string, where: ExpressionNode, ops: Record<string, PatchOp>, _ctx: Context): Promise<number> {
    const result = await this.db.collection(model).updateMany(this.filter(model, where), compileMongoUpdate(ops));
    return Number((result as { modifiedCount?: number }).modifiedCount ?? 0);
  }

  async upsert(model: string, where: ExpressionNode, set: JsonObject, setOnInsert: JsonObject, _ctx: Context): Promise<void> {
    const update: Record<string, object> = {};
    const mappedSet = toStoredFields(set, model, this.identity);
    const mappedInsert = toStoredFields(setOnInsert, model, this.identity);
    if (Object.keys(mappedSet).length) update.$set = mappedSet;
    if (Object.keys(mappedInsert).length) update.$setOnInsert = mappedInsert;
    await this.db.collection(model).updateOne(this.filter(model, where), update, { upsert: true });
  }

  save(model: string, record: JsonObject, _ctx: Context, dirty?: readonly string[]): void {
    this.saveQueue.push({ model, record, dirty });
  }

  remove(model: string, record: JsonObject, _ctx: Context): void {
    this.removeQueue.push({ model, record });
  }

  /**
   * Pre-write uniqueness check (opt-in): catch same-batch duplicates in memory, then `find` a
   * pre-existing document colliding on any unique key (excluding the batch's own saved/removed ids).
   * Throws `UniqueConstraintError` before the `bulkWrite`, mirroring the in-memory reference.
   */
  private async precheckUnique(saved: PersistedChange[], removed: PersistedChange[]): Promise<void> {
    const byModel = new Map<string, PersistedChange[]>();
    for (const change of saved) {
      const list = byModel.get(change.model);
      if (list) list.push(change);
      else byModel.set(change.model, [change]);
    }
    for (const [model, changes] of byModel) {
      const keySets = this.uniqueKeys.get(model);
      if (!keySets || keySets.length === 0) continue;

      const dup = sameBatchConflict(changes, keySets);
      if (dup) throw new UniqueConstraintError(model, dup);

      const freed = new Set(changes.map((c) => String(c.record.uuid)));
      for (const change of removed) if (change.model === model) freed.add(String(change.record.uuid));
      const idField = this.identity.field;
      const filterField = (f: string) => (f === "uuid" ? idField : f);
      const encodeVal = (f: string, v: unknown): unknown => (f === "uuid" ? this.identity.encode(String(v)) : v);

      const collection = this.db.collection(model);
      for (const fields of keySets) {
        const tuples = changes
          .filter((c) => uniqueKey(c.record, fields) !== null)
          .map((c) => fields.map((f) => c.record[f]));
        if (tuples.length === 0) continue;

        const keyPredicate: MongoFilter =
          fields.length === 1
            ? { [filterField(fields[0]!)]: { $in: tuples.map((t) => encodeVal(fields[0]!, t[0])) } }
            : { $or: tuples.map((t) => Object.fromEntries(fields.map((f, i) => [filterField(f), encodeVal(f, t[i])]))) };
        const notFreed: MongoFilter = { [idField]: { $nin: [...freed].map((u) => this.identity.encode(u)) } };
        const found = await collection.find({ $and: [notFreed, keyPredicate] }, { limit: 1 }).toArray();
        if (found.length > 0) throw new UniqueConstraintError(model, fields);
      }
    }
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

    if (this.uniquePreCheck) await this.precheckUnique(saved, removed);

    const byModel = new Map<string, object[]>();
    const push = (model: string, op: object) => {
      const ops = byModel.get(model) ?? [];
      ops.push(op);
      byModel.set(model, ops);
    };
    for (const change of saved) {
      const id = String(change.record.uuid);
      // With a `dirty` hint (§12), $set/$unset only the fields that actually changed instead of the
      // whole document — `record` always carries the complete row regardless, so this is purely an
      // optimization: a field absent from `dirty` keeps whatever value the document already has.
      const fields = change.dirty
        ? Object.fromEntries(change.dirty.filter((f) => f in change.record).map((f) => [f, change.record[f]]))
        : change.record;
      const removed = change.dirty?.filter((f) => change.record[f] === undefined) ?? [];
      const update: Record<string, object> = { $set: toStoredFields(fields, change.model, this.identity) };
      if (removed.length) update.$unset = Object.fromEntries(removed.map((f) => [f, ""]));
      push(change.model, {
        updateOne: { filter: keyFilter(id, this.identity), update, upsert: true }
      });
    }
    for (const change of removed) {
      push(change.model, { deleteOne: { filter: keyFilter(String(change.record.uuid), this.identity) } });
    }
    for (const [model, ops] of byModel) {
      if (ops.length) await this.db.collection(model).bulkWrite(ops);
    }

    for (const change of saved) {
      this.emit({ model: change.model, uuid: String(change.record.uuid), kind: "saved", record: change.record });
    }
    for (const change of removed) {
      this.emit({ model: change.model, uuid: String(change.record.uuid), kind: "removed" });
    }
    return { saved, removed };
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
}

function findOptions(plan: QueryPlan, identity: MongoIdentity): MongoFindOptions {
  const options: MongoFindOptions = {};
  if (plan.order.length) {
    options.sort = Object.fromEntries(
      plan.order.map((key) => [key.property === "uuid" ? identity.field : key.property, key.descending ? -1 : 1])
    );
  }
  if (plan.paging.start > 0) options.skip = plan.paging.start;
  if (plan.paging.end !== undefined) options.limit = plan.paging.end - plan.paging.start;
  if (plan.project) {
    // Keep the key field so `fromStored` can recover `uuid`: `_id` when that's the key, else drop `_id`.
    options.projection = identity.field === "uuid" ? { _id: 0, uuid: 1 } : { _id: 1 };
    for (const field of plan.project) if (field !== "uuid") options.projection[field] = 1;
  }
  return options;
}

// --- Mongo filter compilation (the ExpressionVisitor seam, ARCHITECTURE.md §3) --------------

const MONGO_OP: Record<Exclude<Comparator, "=">, string> = {
  "!=": "$ne",
  ">": "$gt",
  "<": "$lt",
  ">=": "$gte",
  "<=": "$lte"
};

/** True for a Mongo query-operator body like `{ $gt: 5 }` (every key is `$`-prefixed) — vs a plain value. */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

class MongoVisitor implements ExpressionVisitor<MongoFilter> {
  constructor(
    private readonly identity: MongoIdentity = UUID_IDENTITY,
    private readonly refs: ReadonlySet<string> = new Set()
  ) {}

  // Map the model's `uuid` to the stored key field, and encode id-typed values (uuid + FK refs).
  private prop(property: string): string {
    return property === "uuid" ? this.identity.field : property;
  }
  private val(property: string, value: JsonValue): unknown {
    return property === "uuid" || this.refs.has(property) ? this.identity.encode(String(value)) : value;
  }

  all(): MongoFilter {
    return {};
  }
  compare(property: string, comparator: Comparator, value: JsonValue): MongoFilter {
    const prop = this.prop(property);
    // Null equality: the reference matches an *explicit* null only (a missing field is `undefined`,
    // not `null`). Plain `{x: null}` in Mongo also matches missing, and `{x: {$ne: null}}` fails to
    // match a missing field — both inverted from the reference. `$type: "null"` matches the BSON null
    // type only (never missing), so it (and its negation) restores exact parity.
    if (value === null && comparator === "=") return { [prop]: { $type: "null" } };
    if (value === null && comparator === "!=") return { [prop]: { $not: { $type: "null" } } };
    const v = this.val(property, value);
    if (comparator === "=") return { [prop]: v };
    return { [prop]: { [MONGO_OP[comparator]]: v } };
  }
  expr(left: ValueExpr, comparator: Comparator, right: ValueExpr): MongoFilter {
    // Computed comparisons use the aggregation-expression form via $expr.
    return { $expr: { [MONGO_CMP[comparator]]: [left.compile(MONGO_VALUES), right.compile(MONGO_VALUES)] } };
  }
  any(property: string, predicate: Expression): MongoFilter {
    // The predicate's field conditions are matched against each array element via $elemMatch. The
    // sub-predicate is element-scoped, so it compiles with a plain visitor (no key/FK remapping).
    const compiled = predicate.compile(new MongoVisitor());
    // A predicate on the `value` sentinel targets the *scalar element itself*. `$elemMatch` requires an
    // object, so a bare value (`{value: "de"}` → `"de"`) must be wrapped as `{$eq: "de"}` — a raw
    // `{$elemMatch: "de"}` is rejected by Mongo. An operator body (`{$gt: 5}`) is already valid.
    const elementMatch =
      "value" in compiled ? (isOperatorObject(compiled.value) ? compiled.value : { $eq: compiled.value }) : compiled;
    return { [this.prop(property)]: { $elemMatch: elementMatch } };
  }
  in(property: string, values: JsonValue[]): MongoFilter {
    return { [this.prop(property)]: { $in: values.map((value) => this.val(property, value)) } };
  }
  nin(property: string, values: JsonValue[]): MongoFilter {
    return { [this.prop(property)]: { $nin: values.map((value) => this.val(property, value)) } };
  }
  contains(property: string, value: JsonValue): MongoFilter {
    // Equality against an array field matches documents whose array contains the value.
    return { [this.prop(property)]: this.val(property, value) };
  }
  between(property: string, lowerEnd: JsonValue, upperEnd: JsonValue): MongoFilter {
    return { [this.prop(property)]: { $gte: this.val(property, lowerEnd), $lte: this.val(property, upperEnd) } };
  }
  exists(property: string, shouldExist: boolean): MongoFilter {
    return { [this.prop(property)]: { $exists: shouldExist } };
  }
  isNull(property: string, negated: boolean): MongoFilter {
    // Mongo `{field: null}` matches a null value OR a missing field (exactly null-or-absent); `$ne: null`
    // matches present-and-not-null (it excludes both null and missing), mirroring the reference.
    return { [this.prop(property)]: negated ? { $ne: null } : null };
  }
  size(property: string, length: number): MongoFilter {
    return { [this.prop(property)]: { $size: length } };
  }
  textmatch(property: string, value: string, mode: TextMode, caseInsensitive: boolean): MongoFilter {
    if (value === "") return { [this.prop(property)]: { $type: "string" } }; // empty matches any string
    // Case folding is baked into the pattern (ASCII char classes), not `$options: "i"` (Unicode) —
    // so it matches the in-memory / SQL ASCII-only semantics exactly.
    return { [this.prop(property)]: { $regex: textRegexSource(value, mode, caseInsensitive) } };
  }
  and(expressions: readonly Expression[]): MongoFilter {
    return { $and: expressions.map((expression) => expression.compile(this)) };
  }
  or(expressions: readonly Expression[]): MongoFilter {
    return { $or: expressions.map((expression) => expression.compile(this)) };
  }
  not(expression: Expression): MongoFilter {
    return { $nor: [expression.compile(this)] };
  }
}

/** Compile a serialized expression AST to a MongoDB query filter (identity-aware for `uuid`/FK fields). */
export function compileMongoFilter(
  where: QueryPlan["where"],
  identity: MongoIdentity = UUID_IDENTITY,
  model?: string
): MongoFilter {
  const refs = new Set(model ? (identity.references?.[model] ?? []) : []);
  return parse(where).compile(new MongoVisitor(identity, refs));
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

/** A regex source matching `value` literally, with ASCII letters as `[aA]` classes when case-insensitive. */
function textRegexSource(value: string, mode: TextMode, caseInsensitive: boolean): string {
  const body = [...value]
    .map((char) => {
      if (caseInsensitive && /[a-zA-Z]/.test(char)) return `[${char.toLowerCase()}${char.toUpperCase()}]`;
      return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
    })
    .join("");
  return mode === "prefix" ? `^${body}` : mode === "suffix" ? `${body}$` : body;
}

/**
 * Compile patch ops to a Mongo update (shared by `patch`/`patchMany`). With no computed `setExpr`
 * this is a classic update document; when a `setExpr` is present the whole update becomes an
 * aggregation pipeline whose single `$set` stage evaluates every field against the input document —
 * so derived fields see the pre-update record (snapshot semantics), matching SQL and the reference.
 */
function compileMongoUpdate(ops: Record<string, PatchOp>): object {
  if (!Object.values(ops).some((op) => op.kind === "setExpr")) {
    const update: Record<string, Record<string, unknown>> = {};
    const at = (operator: string): Record<string, unknown> => (update[operator] ??= {});
    for (const [field, op] of Object.entries(ops)) {
      switch (op.kind) {
        case "set":
          at("$set")[field] = op.value;
          break;
        case "unset":
          at("$unset")[field] = ""; // value ignored by convention
          break;
        case "inc":
          at("$inc")[field] = op.by;
          break;
        case "mul":
          at("$mul")[field] = op.by;
          break;
        case "push":
          at("$push")[field] = { $each: op.values };
          break;
        case "addToSet":
          at("$addToSet")[field] = { $each: op.values };
          break;
        case "pull":
          at("$pullAll")[field] = op.values;
          break;
        case "setExpr":
          break; // unreachable here (no computed op in this branch)
      }
    }
    return update;
  }

  const setStage: Record<string, unknown> = {};
  const unsetFields: string[] = [];
  for (const [field, op] of Object.entries(ops)) {
    switch (op.kind) {
      case "set":
        setStage[field] = { $literal: op.value };
        break;
      case "setExpr":
        setStage[field] = parseValue(op.value).compile(MONGO_VALUES);
        break;
      case "inc":
        setStage[field] = { $add: [{ $ifNull: [`$${field}`, 0] }, op.by] };
        break;
      case "mul":
        setStage[field] = { $multiply: [{ $ifNull: [`$${field}`, 0] }, op.by] };
        break;
      case "unset":
        unsetFields.push(field);
        break;
    }
  }
  const pipeline: object[] = [];
  if (Object.keys(setStage).length) pipeline.push({ $set: setStage });
  if (unsetFields.length) pipeline.push({ $unset: unsetFields });
  return pipeline;
}

// --- Aggregation ($group) compilation (ARCHITECTURE.md §11) ---------------------------------

const AGG_ACCUMULATOR: Record<Exclude<AggregateStage["op"], "count" | "countDistinct">, string> = {
  sum: "$sum",
  avg: "$avg",
  min: "$min",
  max: "$max"
};

/** The `_id` of a `$group`: `null` for a global aggregate, the key expr for one key, else a sub-doc. */
function groupId(groupBy: ValueNode[]): unknown {
  if (groupBy.length === 0) return null;
  if (groupBy.length === 1) return parseValue(groupBy[0]!).compile(MONGO_VALUES);
  return Object.fromEntries(groupBy.map((node, i) => [`g${i}`, parseValue(node).compile(MONGO_VALUES)]));
}

/** Recover the group-key values (parallel to `groupBy`) from a `$group` document's `_id`. */
function keyOf(id: unknown, groupBy: ValueNode[]): JsonValue[] {
  if (groupBy.length === 0) return [];
  if (groupBy.length === 1) return [id as JsonValue];
  const obj = id as Record<string, JsonValue>;
  return groupBy.map((_, i) => obj[`g${i}`] as JsonValue);
}

/** One `$group` accumulator: `count` → `{ $sum: 1 }`; the rest reduce a value (aggregation) expression. */
function aggregateAccumulator(agg: AggregateStage): Record<string, unknown> {
  if (agg.op === "count") return { $sum: 1 };
  // countDistinct pushes down as `$addToSet` (server-side dedup); the client sizes the returned set.
  if (agg.op === "countDistinct") return { $addToSet: parseValue(agg.value!).compile(MONGO_VALUES) };
  return { [AGG_ACCUMULATOR[agg.op]]: parseValue(agg.value!).compile(MONGO_VALUES) };
}

/** Aggregation comparison operators, used inside `$expr`. */
const MONGO_CMP: Record<Comparator, string> = {
  "=": "$eq",
  "!=": "$ne",
  ">": "$gt",
  "<": "$lt",
  ">=": "$gte",
  "<=": "$lte"
};

const ARITH_MONGO: Record<ArithOp, string> = {
  "+": "$add",
  "-": "$subtract",
  "*": "$multiply",
  "/": "$divide",
  "%": "$mod"
};

type MongoExpr = unknown;

/** Compiles value expressions to MongoDB aggregation expressions (ARCHITECTURE.md §11). */
const MONGO_VALUES: ValueVisitor<MongoExpr> = {
  field: (path) => `$${path}`,
  lit: (value) => ({ $literal: value }),
  arith: (op, operands) => {
    // The reference coerces a null/missing operand to 0 (`num()`), so `$ifNull` each — a bare `$add`
    // returns null if any operand is null, diverging from in-memory.
    const parts = operands.map((operand) => ({ $ifNull: [operand.compile(MONGO_VALUES), 0] }));
    if ((op === "/" || op === "%") && parts.length === 2) {
      // Reference returns 0 for a zero divisor; a bare `$divide`/`$mod` *aborts the whole aggregation*
      // on a 0 divisor. Guard with `$cond` for exact parity and no crash.
      return { $cond: [{ $eq: [parts[1], 0] }, 0, { [ARITH_MONGO[op]]: parts }] };
    }
    return { [ARITH_MONGO[op]]: parts };
  },
  neg: (operand) => ({ $multiply: [{ $ifNull: [operand.compile(MONGO_VALUES), 0] }, -1] }),
  concat: (operands) => ({ $concat: operands.map((operand) => ({ $ifNull: [operand.compile(MONGO_VALUES), ""] })) }),
  coalesce: (operands) => {
    // $ifNull is binary; fold right so coalesce(a, b, c) -> $ifNull[a, $ifNull[b, c]].
    const compiled = operands.map((operand) => operand.compile(MONGO_VALUES));
    return compiled.reduceRight((rest, head) => ({ $ifNull: [head, rest] }));
  },
  datepart: (part, operand, timezone) => {
    // Stored as epoch ms → `$toDate` rehydrates a Date; the date operators default to UTC, and Mongo's
    // 1-based $month and 1–7 $dayOfWeek already match the in-memory reference. A timezone is passed
    // through to the operator's `{ date, timezone }` form (Mongo evaluates the offset, DST-aware).
    const date = { $toDate: operand.compile(MONGO_VALUES) };
    return { [MONGO_DATE_OP[part]]: timezone ? { date, timezone } : date };
  },
  datestring: (format, operand, timezone) => ({
    $dateToString: { format, date: { $toDate: operand.compile(MONGO_VALUES) }, ...(timezone ? { timezone } : {}) }
  }),
  vcompare: (op, left, right) => ({ [MONGO_CMP[op]]: [left.compile(MONGO_VALUES), right.compile(MONGO_VALUES)] }),
  vand: (operands) => ({ $and: operands.map((operand) => operand.compile(MONGO_VALUES)) }),
  vor: (operands) => ({ $or: operands.map((operand) => operand.compile(MONGO_VALUES)) }),
  vnot: (operand) => ({ $not: [operand.compile(MONGO_VALUES)] }),
  cond: (test, then, otherwise) => ({
    $cond: [test.compile(MONGO_VALUES), then.compile(MONGO_VALUES), otherwise.compile(MONGO_VALUES)]
  }),
  switch: (branches, otherwise) => ({
    $switch: {
      branches: branches.map((branch) => ({
        case: branch.when.compile(MONGO_VALUES),
        then: branch.then.compile(MONGO_VALUES)
      })),
      default: otherwise.compile(MONGO_VALUES)
    }
  })
};

const MONGO_DATE_OP: Record<DatePart, string> = {
  year: "$year",
  month: "$month",
  dayOfMonth: "$dayOfMonth",
  dayOfWeek: "$dayOfWeek",
  hour: "$hour",
  minute: "$minute",
  second: "$second"
};
