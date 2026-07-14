/**
 * MongoDB query-language compatibility facade (an opt-in migration on-ramp).
 *
 * Parses a MongoDB filter object (`{ age: { $gt: 30 }, $or: [...] }`) into this library's portable
 * expression AST — the *inverse* of `compileMongoFilter` — so an app written against Mongo's query
 * syntax can run **unchanged on any backend**: in-memory, IndexedDB, SQLite, Postgres, MySQL, or Mongo
 * itself. `mongoCollection(repo)` wraps a repository in a familiar `find()/findOne()/countDocuments()/
 * aggregate()` surface. Because it targets the same AST, results are identical across backends (with
 * the usual push-down-or-scan guarantee).
 *
 * Fidelity: this maps the common, portable subset. Anything it can't express exactly — arbitrary
 * regexes, `$where`, unsupported operators/stages — **throws** rather than guessing, so drift is loud.
 */
import type { JsonValue } from "../core/types.ts";
import type { Repository } from "../repository/Repository.ts";
import type { QueryCollection } from "../repository/QueryCollection.ts";
import type { InferModel, PropertyMap } from "../properties/infer.ts";
import { set, unset, inc, mul, push, addToSet, pull, type PatchSpec, type PatchSpecFor } from "../repository/patch.ts";
// `parseMongoFilter` lives in the expression layer (core-reachable, no Mongo-driver dependency); this
// facade re-exports it so `object-repository/compat/mongo` stays a one-stop surface for a Mongo-syntax migration.
import { parseMongoFilter, isOperatorObject, type MongoFilter } from "../expressions/mongoFilter.ts";

export { parseMongoFilter };
export type { MongoFilter };

// --- update mapping ($-operators → PatchOps) ---------------------------------------------------

/** A MongoDB update document — `{ $set: {…}, $inc: {…} }`. */
export type MongoUpdate = Record<string, unknown>;

/** Parse a Mongo update document into a `PatchSpec` (throws on a replacement doc or unsupported op). */
export function parseMongoUpdate(update: MongoUpdate): PatchSpec {
  const keys = Object.keys(update);
  if (keys.length === 0) throw new Error("Empty update document.");
  if (keys.some((key) => !key.startsWith("$"))) {
    throw new Error("A field-style update document replaces the record — use replaceOne(), or wrap fields in $set.");
  }
  const spec: PatchSpec = {};
  for (const [op, fields] of Object.entries(update)) {
    if (op === "$setOnInsert") continue; // only applies on insert (upsert); a no-op on an existing record
    for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
      // Mongo rejects two operators touching the same path in one update; don't silently drop one.
      if (Object.prototype.hasOwnProperty.call(spec, field)) {
        throw new Error(`Conflicting update operators on field "${field}" in one update.`);
      }
      spec[field] = updateOp(op, field, value);
    }
  }
  return spec;
}

function updateOp(op: string, field: string, value: unknown): PatchSpec[string] {
  switch (op) {
    case "$set":
      return set(value as JsonValue);
    case "$unset":
      return unset();
    case "$inc":
      return inc(Number(value));
    case "$mul":
      return mul(Number(value));
    case "$push":
      return push(...eachValues(value));
    case "$addToSet":
      return addToSet(...eachValues(value));
    case "$pull":
      if (isOperatorObject(value)) {
        // `$pull: { field: { $in: [...] } }` removes every element in the set — same as $pullAll.
        const cond = value as Record<string, unknown>;
        if (Array.isArray(cond.$in)) return pull(...(cond.$in as JsonValue[]));
        throw new Error(`$pull with a condition on "${field}" isn't supported — pull by value or $in.`);
      }
      return pull(value as JsonValue);
    case "$pullAll":
      // Remove every element equal to any listed value — exactly the portable `pull` op's semantics.
      if (!Array.isArray(value)) throw new Error(`$pullAll on "${field}" expects an array of values.`);
      return pull(...(value as JsonValue[]));
    case "$currentDate":
      // Set the field to "now". Mongo evaluates this server-side; the facade is in-process, so its
      // clock is the server clock. Accepts `true` or `{ $type: "date" | "timestamp" }`.
      return set(new Date() as unknown as JsonValue);
    default:
      throw new Error(`Unsupported update operator "${op}".`);
  }
}

/** `$push`/`$addToSet` accept a single value or `{ $each: [...] }`. */
function eachValues(value: unknown): JsonValue[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "$each" in value) {
    return (value as { $each: JsonValue[] }).$each;
  }
  return [value as JsonValue];
}

/** Top-level equality fields of a filter — the seed for an upsert insert (like Mongo). */
function equalityFields(filter: MongoFilter): Record<string, JsonValue> {
  const seed: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("$") && !isOperatorObject(value)) seed[key] = value as JsonValue;
  }
  return seed;
}

function plainObject(value: unknown): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

// --- collection facade -------------------------------------------------------------------------

/** Sort/skip/limit options for `find` (mirrors the Mongo driver's shape). */
export interface MongoFindOptions {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
}

/** A minimal Mongo-style cursor: chain `sort`/`skip`/`limit`, then `toArray()`. */
export class MongoCursor<T> {
  private readonly sortKeys: Array<[string, 1 | -1]> = [];
  private skipN = 0;
  private limitN: number | undefined;

  constructor(private readonly base: QueryCollection<T>) {}

  sort(spec: Record<string, 1 | -1>): this {
    for (const [field, dir] of Object.entries(spec)) this.sortKeys.push([field, dir]);
    return this;
  }
  skip(n: number): this {
    this.skipN = n;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  async toArray(): Promise<T[]> {
    let query = this.base;
    // The facade accepts arbitrary Mongo field strings; the typed `sort` narrows to `keyof T`.
    for (const [field, dir] of this.sortKeys) query = query.sort(field as keyof T & string, dir === -1);
    if (this.skipN !== 0 || this.limitN !== undefined) {
      const end = this.limitN !== undefined ? this.skipN + this.limitN : undefined;
      query = query.slice(this.skipN, end);
    }
    return query.list();
  }
}

export interface UpdateResult {
  acknowledged: true;
  matchedCount: number;
  modifiedCount: number;
  upsertedId: string | null;
}
export interface DeleteResult {
  acknowledged: true;
  deletedCount: number;
}
export interface InsertOneResult {
  acknowledged: true;
  insertedId: string;
}
export interface InsertManyResult {
  acknowledged: true;
  insertedCount: number;
  insertedIds: string[];
}
export interface UpdateFacadeOptions {
  upsert?: boolean;
}
export interface FindOneAndUpdateOptions {
  upsert?: boolean;
  /** Which document to return — `after` (default here) or `before` (the native driver's default). */
  returnDocument?: "before" | "after";
}

/** A Mongo-driver-shaped view over a repository — the same syntax, running on whatever backend it uses. */
export interface MongoCollectionFacade<T> {
  // reads
  find(filter?: MongoFilter, options?: MongoFindOptions): MongoCursor<T>;
  findOne(filter?: MongoFilter): Promise<T | null>;
  countDocuments(filter?: MongoFilter): Promise<number>;
  aggregate(pipeline: MongoFilter[]): Promise<Record<string, unknown>[]>;
  // writes
  insertOne(doc: Partial<T>): Promise<InsertOneResult>;
  insertMany(docs: Partial<T>[]): Promise<InsertManyResult>;
  updateOne(filter: MongoFilter, update: MongoUpdate, options?: UpdateFacadeOptions): Promise<UpdateResult>;
  updateMany(filter: MongoFilter, update: MongoUpdate, options?: UpdateFacadeOptions): Promise<UpdateResult>;
  findOneAndUpdate(filter: MongoFilter, update: MongoUpdate, options?: FindOneAndUpdateOptions): Promise<T | null>;
  replaceOne(filter: MongoFilter, replacement: Partial<T>, options?: UpdateFacadeOptions): Promise<UpdateResult>;
  deleteOne(filter: MongoFilter): Promise<DeleteResult>;
  deleteMany(filter: MongoFilter): Promise<DeleteResult>;
}

/** Wrap a repository so a Mongo-syntax app can query *and mutate* it unchanged (on any backend). */
export function mongoCollection<P extends PropertyMap>(repo: Repository<P>): MongoCollectionFacade<InferModel<P>> {
  type T = InferModel<P>;
  const filtered = (filter: MongoFilter) => repo.all().filter(parseMongoFilter(filter));
  const uuidOf = (doc: T) => (doc as { uuid: string }).uuid;
  const findFirst = async (filter: MongoFilter): Promise<T | undefined> => (await filtered(filter).slice(0, 1).list())[0];
  // The Mongo bridge is the untyped escape hatch: a `$set`/`$inc` parsed from an arbitrary Mongo
  // update can't be statically checked against `T`, so cross into the typed `patch` API here.
  const typedUpdate = (update: MongoUpdate): PatchSpecFor<T> => parseMongoUpdate(update) as PatchSpecFor<T>;

  /** Insert the seed doc for an upsert (filter equality + $set + $setOnInsert). */
  const insertUpsert = async (filter: MongoFilter, update: MongoUpdate): Promise<T> => {
    const seed = { ...equalityFields(filter), ...plainObject(update.$set), ...plainObject(update.$setOnInsert) };
    const instance = repo.createInstance(seed as Partial<T>);
    repo.save(instance);
    await repo.persist();
    return instance;
  };

  return {
    find(filter = {}, options = {}) {
      const cursor = new MongoCursor(filtered(filter));
      if (options.sort) cursor.sort(options.sort);
      if (options.skip) cursor.skip(options.skip);
      if (options.limit !== undefined) cursor.limit(options.limit);
      return cursor;
    },
    async findOne(filter = {}) {
      return (await findFirst(filter)) ?? null;
    },
    countDocuments(filter = {}) {
      return filtered(filter).count();
    },
    aggregate(pipeline) {
      return runAggregate(repo, pipeline);
    },

    async insertOne(doc) {
      const instance = repo.createInstance(doc);
      repo.save(instance);
      await repo.persist();
      return { acknowledged: true, insertedId: uuidOf(instance) };
    },
    async insertMany(docs) {
      const instances = docs.map((doc) => repo.createInstance(doc));
      for (const instance of instances) repo.save(instance);
      await repo.persist();
      return { acknowledged: true, insertedCount: instances.length, insertedIds: instances.map(uuidOf) };
    },
    async updateOne(filter, update, options = {}) {
      const doc = await findFirst(filter);
      if (!doc) {
        if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: uuidOf(await insertUpsert(filter, update)) };
      }
      await repo.patch(uuidOf(doc), typedUpdate(update));
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
    },
    async updateMany(filter, update, options = {}) {
      const count = await repo.patchWhere(parseMongoFilter(filter), typedUpdate(update));
      if (count === 0 && options.upsert) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: uuidOf(await insertUpsert(filter, update)) };
      }
      return { acknowledged: true, matchedCount: count, modifiedCount: count, upsertedId: null };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      const before = await findFirst(filter);
      if (!before) {
        if (!options.upsert) return null;
        const inserted = await insertUpsert(filter, update);
        return options.returnDocument === "before" ? null : inserted;
      }
      const after = await repo.patch(uuidOf(before), typedUpdate(update));
      return options.returnDocument === "before" ? before : after;
    },
    async replaceOne(filter, replacement, options = {}) {
      const doc = await findFirst(filter);
      if (!doc) {
        if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
        const created = repo.createInstance(replacement);
        repo.save(created);
        await repo.persist();
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: uuidOf(created) };
      }
      const replaced = repo.createInstance({ ...replacement, uuid: uuidOf(doc) } as Partial<T>);
      repo.save(replaced);
      await repo.persist();
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
    },
    async deleteOne(filter) {
      const doc = await findFirst(filter);
      if (!doc) return { acknowledged: true, deletedCount: 0 };
      repo.remove(doc);
      await repo.persist();
      return { acknowledged: true, deletedCount: 1 };
    },
    async deleteMany(filter) {
      const docs = await filtered(filter).list();
      for (const doc of docs) repo.remove(doc);
      if (docs.length) await repo.persist();
      return { acknowledged: true, deletedCount: docs.length };
    }
  };
}

/** Field reference `"$region"` → `"region"`. */
function fieldRef(value: unknown): string {
  return typeof value === "string" && value.startsWith("$") ? value.slice(1) : String(value);
}

/** Run a `$match` → `$group` pipeline (the common shape) against a repository, in Mongo output form. */
async function runAggregate<P extends PropertyMap>(repo: Repository<P>, pipeline: MongoFilter[]): Promise<Record<string, unknown>[]> {
  // Stages before `$group` shape the row stream (mapped onto the query builder); `$group` produces the
  // summary; stages after it reshape that result set in memory. `$sort`/`$skip`/`$limit`/`$count` work
  // on either side; `$match`/`$group` only before.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = repo.all();
  let skip = 0;
  let limit: number | undefined;
  let group: Record<string, unknown> | null = null;
  const postGroup: MongoFilter[] = [];

  for (const stage of pipeline) {
    const op = Object.keys(stage)[0];
    if (group !== null) {
      postGroup.push(stage);
      continue;
    }
    switch (op) {
      case "$match":
        query = query.filter(parseMongoFilter(stage.$match as MongoFilter));
        break;
      case "$sort":
        for (const [f, dir] of Object.entries(stage.$sort as Record<string, number>)) query = query.sort(f as never, dir === -1);
        break;
      case "$skip":
        skip += Number(stage.$skip);
        break;
      case "$limit": {
        const n = Number(stage.$limit);
        limit = limit === undefined ? n : Math.min(limit, n);
        break;
      }
      case "$count":
        return [{ [stage.$count as string]: await windowed(query, skip, limit).count() }];
      case "$group":
        group = stage.$group as Record<string, unknown>;
        break;
      default:
        throw new Error(`Unsupported aggregate stage "${op ?? "(empty)"}".`);
    }
  }

  if (!group) return (await windowed(query, skip, limit).list()) as unknown as Record<string, unknown>[];

  const { _id, ...accumulators } = group;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const build = (a: any): Record<string, unknown> => {
    const spec: Record<string, unknown> = {};
    for (const [name, acc] of Object.entries(accumulators)) spec[name] = accumulate(a, acc);
    return spec;
  };
  let result: Record<string, unknown>[];
  if (_id === null || _id === undefined) {
    result = [{ _id: null, ...(await query.aggregate(build)) }];
  } else {
    const groups = await query.groupBy(fieldRef(_id), build);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = groups.map(({ key: keyValue, ...values }: any) => ({ _id: keyValue, ...values }));
  }
  return applyPostGroup(result, postGroup);
}

/** Apply an accumulated skip/limit window to the query builder. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function windowed(query: any, skip: number, limit: number | undefined): any {
  if (skip === 0 && limit === undefined) return query;
  return query.slice(skip, limit === undefined ? undefined : skip + limit);
}

/** Reshape a post-`$group` result set in memory — `$sort`/`$skip`/`$limit`/`$count` over the summaries. */
function applyPostGroup(rows: Record<string, unknown>[], stages: MongoFilter[]): Record<string, unknown>[] {
  let result = rows;
  for (const stage of stages) {
    const op = Object.keys(stage)[0];
    switch (op) {
      case "$sort": {
        const keys = Object.entries(stage.$sort as Record<string, number>);
        result = [...result].sort((a, b) => {
          for (const [f, dir] of keys) {
            const c = compareUnknown(a[f], b[f]);
            if (c !== 0) return dir === -1 ? -c : c;
          }
          return 0;
        });
        break;
      }
      case "$skip":
        result = result.slice(Number(stage.$skip));
        break;
      case "$limit":
        result = result.slice(0, Number(stage.$limit));
        break;
      case "$count":
        return [{ [stage.$count as string]: result.length }];
      default:
        throw new Error(`Unsupported aggregate stage "${op ?? "(empty)"}" after $group.`);
    }
  }
  return result;
}

function compareUnknown(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

/** Map a Mongo accumulator (`{ $sum: "$amount" }`, `{ $sum: 1 }`, `{ $avg: … }`) to an aggregator call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function accumulate(a: any, acc: unknown): unknown {
  if (typeof acc !== "object" || acc === null) throw new Error("A $group accumulator must be an object like { $sum: '$field' }.");
  const [op, operand] = Object.entries(acc)[0]!;
  switch (op) {
    case "$sum":
      return typeof operand === "number" ? a.count() : a.sum(fieldRef(operand));
    case "$avg":
      return a.avg(fieldRef(operand));
    case "$min":
      return a.min(fieldRef(operand));
    case "$max":
      return a.max(fieldRef(operand));
    case "$count":
      return a.count();
    default:
      throw new Error(`Unsupported $group accumulator "${op}".`);
  }
}
