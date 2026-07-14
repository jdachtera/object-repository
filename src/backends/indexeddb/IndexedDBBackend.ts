import type {
  Backend,
  ChangeEvent,
  ChangeListener,
  CountingBackend,
  IndexSpec,
  PersistResult,
  PersistedChange,
  SchemaAwareBackend,
  Unsubscribe
} from "../../core/Backend.ts";
import type { Capabilities, Context, JsonObject, JsonValue, Uuid } from "../../core/types.ts";
import type { QueryPlan, Comparator } from "../../core/QueryPlan.ts";
import { generateUuid } from "../../core/uuid.ts";
import type { Expression } from "../../expressions/Expression.ts";
import type { ExpressionVisitor } from "../../expressions/visitor.ts";
import { parse } from "../../expressions/parse.ts";
import { scan } from "../util/scan.ts";
import { pickFields } from "../memory/InMemoryBackend.ts";

const CAPABILITIES: Capabilities = {
  indexes: true,
  ranges: true,
  sortPushdown: false, // ordering/paging are applied in memory after fetch for now
  joins: false,
  transactions: true,
  changeFeed: true
};

export interface IndexedDBBackendOptions {
  /** Database name. */
  name?: string;
  /** IDBFactory to open with (defaults to the global `indexedDB`; inject `fake-indexeddb` in tests). */
  factory?: IDBFactory;
  /** IDBKeyRange constructor (defaults to the global; inject `fake-indexeddb`'s in tests). */
  keyRange?: typeof IDBKeyRange;
}

/**
 * A compiling backend over IndexedDB (ARCHITECTURE.md §3, roadmap step 7).
 *
 * This is the other end of the capability spectrum from the in-memory backend: it compiles a
 * filter into an `IDBKeyRange` over a primary key or secondary index (push-down), fetches the
 * narrowed candidate set, then refines with the full in-memory matcher and applies ordering and
 * paging via the shared `scan()` helper. Object stores and indexes are provisioned from the
 * `registerModel` calls the RepositoryManager makes during `define`.
 */
export class IndexedDBBackend implements Backend, SchemaAwareBackend, CountingBackend {
  readonly capabilities = CAPABILITIES;

  private readonly name: string;
  private readonly factory: IDBFactory;
  private readonly keyRange: typeof IDBKeyRange;
  private readonly models = new Map<string, IndexSpec[]>();

  private db: IDBDatabase | null = null;
  private openingPromise: Promise<IDBDatabase> | null = null;

  private saveQueue: PersistedChange[] = [];
  private removeQueue: PersistedChange[] = [];
  private readonly listeners = new Set<ChangeListener>();

  constructor(options: IndexedDBBackendOptions = {}) {
    this.name = options.name ?? "object-repository";
    this.factory = options.factory ?? globalThis.indexedDB;
    this.keyRange = options.keyRange ?? globalThis.IDBKeyRange;
  }

  /** Provision an object store (and its indexes) for a model. Idempotent. */
  registerModel(model: string, indexes: IndexSpec[]): void {
    if (!this.models.has(model)) {
      this.models.set(model, indexes);
    }
  }

  async query(plan: QueryPlan, _ctx: Context): Promise<JsonObject[]> {
    const db = await this.ensureOpen(plan.model);
    const expression = parse(plan.where);
    const hint = expression.compile(new IndexHintVisitor(this.indexedProperties(plan.model), this.keyRange));

    const tx = db.transaction(plan.model, "readonly");
    const store = tx.objectStore(plan.model);
    const source: IDBObjectStore | IDBIndex = hint && hint.index ? store.index(hint.index) : store;
    const candidates = await requestResult<JsonObject[]>(
      hint ? source.getAll(hint.range) : store.getAll()
    );
    await transactionDone(tx);

    // Push-down only narrows; re-apply the full filter, then order + page.
    const result = scan(candidates, plan);
    return plan.project ? result.map((record) => pickFields(record, plan.project!)) : result;
  }

  async queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    const items = await this.query(plan, ctx);
    return items.map((item) => String(item.uuid));
  }

  /**
   * Native count (ARCHITECTURE.md §11): `count()` over the whole store, or `count(range)` over an
   * index when the filter is a single fully-covered comparison. Anything with a residual predicate
   * falls back to a precise in-memory count, so the result is always exact.
   */
  async count(plan: QueryPlan, ctx: Context): Promise<number> {
    const cover = this.coverableRange(plan);
    if (plan.where.type !== "all" && !cover) {
      return (await this.query(plan, ctx)).length;
    }
    const db = await this.ensureOpen(plan.model);
    const tx = db.transaction(plan.model, "readonly");
    const store = tx.objectStore(plan.model);
    const source: IDBObjectStore | IDBIndex = cover && cover.index ? store.index(cover.index) : store;
    const total = await requestResult<number>(cover ? source.count(cover.range) : store.count());
    await transactionDone(tx);
    return total;
  }

  /** An index range that *fully* represents the filter (a lone covered comparison), else null. */
  private coverableRange(plan: QueryPlan): { index: string | null; range: IDBKeyRange } | null {
    const node = plan.where;
    const indexed = this.indexedProperties(plan.model);
    if (node.type === "compare" && indexed.has(node.property)) {
      const range = rangeFor(node.comparator, node.value as IDBValidKey, this.keyRange);
      return range ? { index: indexName(node.property), range } : null;
    }
    if (node.type === "between" && indexed.has(node.property)) {
      return {
        index: indexName(node.property),
        range: this.keyRange.bound(node.lowerEnd as IDBValidKey, node.upperEnd as IDBValidKey, false, false)
      };
    }
    return null;
  }

  save(model: string, record: JsonObject, _ctx: Context, dirty?: readonly string[]): void {
    this.registerModel(model, []);
    this.saveQueue.push({ model, record, dirty });
  }

  remove(model: string, record: JsonObject, _ctx: Context): void {
    this.registerModel(model, []);
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

    const models = unique([...saved, ...removed].map((change) => change.model));
    if (models.length > 0) {
      const db = await this.ensureOpen(...models);
      const tx = db.transaction(models, "readwrite");
      for (const change of saved) {
        tx.objectStore(change.model).put(change.record);
      }
      for (const change of removed) {
        tx.objectStore(change.model).delete(String(change.record.uuid));
      }
      await transactionDone(tx);
    }

    for (const change of saved) {
      this.emit({
        model: change.model,
        uuid: String(change.record.uuid),
        kind: "saved",
        record: structuredClone(change.record)
      });
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

  changes(listener: ChangeListener, _ctx: Context): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Close the database connection. */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private indexedProperties(model: string): Set<string> {
    const set = new Set<string>(["uuid"]); // primary key is always range-queryable
    for (const index of this.models.get(model) ?? []) {
      // Only single-field indexes whose name matches the field push down a range (`store.index(field)`);
      // compound / custom-named indexes are still built but not used for range narrowing.
      if (index.fields.length === 1 && index.fields[0]!.path === index.name) set.add(index.name);
    }
    return set;
  }

  // --- connection management -----------------------------------------------------------------

  private ensureOpen(...required: string[]): Promise<IDBDatabase> {
    for (const model of required) this.registerModel(model, []);
    if (this.db && this.hasAllStores(this.db)) {
      return Promise.resolve(this.db);
    }
    if (!this.openingPromise) {
      this.openingPromise = this.reopen().finally(() => {
        this.openingPromise = null;
      });
    }
    return this.openingPromise;
  }

  private hasAllStores(db: IDBDatabase): boolean {
    return [...this.models.keys()].every((model) => db.objectStoreNames.contains(model));
  }

  private async reopen(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = await this.open();
    }
    if (!this.hasAllStores(this.db)) {
      const nextVersion = this.db.version + 1;
      this.db.close();
      this.db = await this.open(nextVersion);
    }
    return this.db;
  }

  private open(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request =
        version === undefined ? this.factory.open(this.name) : this.factory.open(this.name, version);

      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction;
        for (const [model, indexes] of this.models) {
          const store = db.objectStoreNames.contains(model)
            ? tx!.objectStore(model)
            : db.createObjectStore(model, { keyPath: "uuid" });
          for (const index of indexes) {
            if (index.text || index.ttlSeconds !== undefined) continue; // not expressible in IndexedDB
            if (!store.indexNames.contains(index.name)) {
              // Compound → an array keyPath; single-field → the field path.
              const keyPath = index.fields.length === 1 ? index.fields[0]!.path : index.fields.map((f) => f.path);
              store.createIndex(index.name, keyPath, { unique: index.unique ?? false });
            }
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    });
  }
}

/** Compiles an expression to an `IDBKeyRange` over an index when one applies (ARCHITECTURE.md §3). */
interface IndexHint {
  /** Index name, or `null` to range over the primary key (uuid). */
  index: string | null;
  range: IDBKeyRange;
}

class IndexHintVisitor implements ExpressionVisitor<IndexHint | null> {
  constructor(
    private readonly indexed: Set<string>,
    private readonly keyRange: typeof IDBKeyRange
  ) {}

  all(): IndexHint | null {
    return null;
  }

  compare(property: string, comparator: Comparator, value: JsonValue): IndexHint | null {
    if (!this.indexed.has(property)) return null;
    const range = rangeFor(comparator, value as IDBValidKey, this.keyRange);
    return range ? { index: indexName(property), range } : null;
  }

  between(property: string, lowerEnd: JsonValue, upperEnd: JsonValue): IndexHint | null {
    if (!this.indexed.has(property)) return null;
    return {
      index: indexName(property),
      range: this.keyRange.bound(lowerEnd as IDBValidKey, upperEnd as IDBValidKey, false, false)
    };
  }

  // `in`/`contains`/`or`/`not`/`expr` aren't a single contiguous range — fall back to a scan.
  in(): IndexHint | null {
    return null;
  }
  nin(): IndexHint | null {
    return null;
  }
  expr(): IndexHint | null {
    return null;
  }
  any(): IndexHint | null {
    return null;
  }
  contains(): IndexHint | null {
    return null;
  }
  exists(): IndexHint | null {
    return null;
  }
  isNull(): IndexHint | null {
    return null; // no single-range hint; the shared scan() refines with IsNull.match
  }
  size(): IndexHint | null {
    return null;
  }
  textmatch(): IndexHint | null {
    return null;
  }
  or(): IndexHint | null {
    return null;
  }
  not(): IndexHint | null {
    return null;
  }

  // For AND, any one indexable conjunct narrows the candidate set; the rest is refined in memory.
  and(expressions: readonly Expression[]): IndexHint | null {
    for (const expression of expressions) {
      const hint = expression.compile(this);
      if (hint) return hint;
    }
    return null;
  }
}

function indexName(property: string): string | null {
  return property === "uuid" ? null : property;
}

function rangeFor(
  comparator: Comparator,
  value: IDBValidKey,
  keyRange: typeof IDBKeyRange
): IDBKeyRange | null {
  switch (comparator) {
    case "=":
      return keyRange.only(value);
    case ">":
      return keyRange.lowerBound(value, true);
    case ">=":
      return keyRange.lowerBound(value, false);
    case "<":
      return keyRange.upperBound(value, true);
    case "<=":
      return keyRange.upperBound(value, false);
    case "!=":
      return null; // not a contiguous range
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
