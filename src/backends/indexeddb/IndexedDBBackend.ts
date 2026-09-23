import type {
  Backend,
  LeasingBackend,
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
import type { MigrationOp } from "../../migrations/types.ts";
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

/** `DOMStringList` predates the iteration protocol and isn't spreadable under this package's lib set. */
function nameList(list: DOMStringList): string[] {
  const names: string[] = [];
  for (let i = 0; i < list.length; i++) names.push(list.item(i)!);
  return names;
}

/**
 * Thrown when a schema upgrade can't proceed because another connection (typically a second tab) still
 * holds the database open at the previous version. IndexedDB fires `blocked` and then simply waits, so
 * without this the open request never settles and every awaiting read/write hangs forever.
 */
export class SchemaUpgradeBlockedError extends Error {
  constructor(
    readonly database: string,
    readonly version: number | undefined
  ) {
    super(
      `Upgrading IndexedDB database "${database}"${version === undefined ? "" : ` to version ${version}`} is blocked by another open connection. Close other tabs using this database and retry.`
    );
    this.name = "SchemaUpgradeBlockedError";
  }
}

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
export class IndexedDBBackend implements Backend, SchemaAwareBackend, CountingBackend, LeasingBackend {
  readonly capabilities = CAPABILITIES;

  private readonly name: string;
  private readonly factory: IDBFactory;
  private readonly keyRange: typeof IDBKeyRange;
  private readonly models = new Map<string, IndexSpec[]>();

  private db: IDBDatabase | null = null;
  /** Indexes a migration dropped (`model\0name`): deleted at the next upgrade, never re-created. */
  private readonly droppedIndexes = new Set<string>();
  /**
   * Unique indexes an upgrade failed to build (`model\0name\0signature`) — most often because the data
   * already holds duplicates. Demanding them again would re-run the same failing upgrade on every
   * operation, on every model; so the failure is reported once and they are no longer required.
   */
  private readonly unbuildable = new Set<string>();
  private openingPromise: Promise<IDBDatabase> | null = null;
  /** Index names per object store in the currently-open database (see `snapshotIndexes`). */
  /** Per store, each present index's name → its definition signature (see `indexSignature`). */
  private presentIndexes = new Map<string, Map<string, string>>();

  private saveQueue: PersistedChange[] = [];
  private removeQueue: PersistedChange[] = [];
  private readonly listeners = new Set<ChangeListener>();

  constructor(options: IndexedDBBackendOptions = {}) {
    this.name = options.name ?? "object-repository";
    this.factory = options.factory ?? globalThis.indexedDB;
    this.keyRange = options.keyRange ?? globalThis.IDBKeyRange;
  }

  /**
   * Provision an object store (and its indexes) for a model. Idempotent, and order-independent: a
   * write can land before `define()` does, and `save`/`remove` register the model with an empty index
   * list to guarantee the store exists. First-registration-wins would let that bare call freeze the
   * model at zero indexes and silently discard the real specs `define()` supplies moments later, so
   * later registrations merge by index name and an empty list never downgrades a populated one.
   */
  registerModel(model: string, indexes: IndexSpec[]): void {
    // Declaring an index again is asking for it back, after a migration dropped it.
    for (const index of indexes) this.droppedIndexes.delete(`${model}\0${index.name}`);
    const existing = this.models.get(model);
    if (!existing) {
      this.models.set(model, indexes);
      return;
    }
    if (!indexes.length) return;
    const byName = new Map(existing.map((index) => [index.name, index]));
    for (const index of indexes) byName.set(index.name, index);
    this.models.set(model, [...byName.values()]);
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
      try {
        const db = await this.ensureOpen(...models);
        const tx = db.transaction(models, "readwrite");
        for (const change of saved) {
          tx.objectStore(change.model).put(change.record);
        }
        for (const change of removed) {
          tx.objectStore(change.model).delete(String(change.record.uuid));
        }
        await transactionDone(tx);
      } catch (error) {
        // Nothing was written (the transaction is all-or-nothing). A blocked upgrade is transient, so put
        // the batch back, ahead of anything queued since, for the retry the error asks for. Anything else
        // — a unique-index conflict, say — would fail the same way every time: requeued, it would ride
        // along with, and sink, every later persist.
        if (error instanceof SchemaUpgradeBlockedError) {
          this.saveQueue = [...saved, ...this.saveQueue];
          this.removeQueue = [...removed, ...this.removeQueue];
        }
        throw error;
      }
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

  /** Read and claim inside one readwrite transaction, which IndexedDB serializes against every other. */
  async acquireLease(model: string, key: string, owner: string, now: number, ttlMs: number, _ctx: Context): Promise<boolean> {
    const db = await this.ensureOpen(model);
    const tx = db.transaction(model, "readwrite");
    const store = tx.objectStore(model);
    const held = await requestResult<JsonObject | undefined>(store.get(key));
    const free = !held || String(held.owner) === owner || Number(held.expiresAt ?? 0) <= now;
    if (free) store.put({ ...held, uuid: key, owner, expiresAt: now + ttlMs });
    await transactionDone(tx);
    return free;
  }

  async releaseLease(model: string, key: string, owner: string, _ctx: Context): Promise<void> {
    const db = await this.ensureOpen(model);
    const tx = db.transaction(model, "readwrite");
    const store = tx.objectStore(model);
    const held = await requestResult<JsonObject | undefined>(store.get(key));
    if (held && String(held.owner) === owner) store.delete(key);
    await transactionDone(tx);
  }

  /**
   * `dropIndex`, the one migration operation that needs native help here: registration only ever adds
   * indexes, so the reference executor alone would leave the index — and its constraint — in place.
   * The index is deleted in a version-change upgrade, the only place IndexedDB allows it.
   */
  async lowerMigrationOp(op: MigrationOp, _ctx: Context): Promise<{ rows: number } | null> {
    if (op.kind !== "dropIndex") return null;
    this.models.set(op.model, (this.models.get(op.model) ?? []).filter((index) => index.name !== op.index));
    this.droppedIndexes.add(`${op.model}\0${op.index}`);
    await this.ensureOpen(op.model);
    return { rows: 0 };
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

  /**
   * Is the open database already provisioned for everything declared? Stores *and* indexes: comparing
   * store names alone means an index added to an existing model never triggers a version bump, so it
   * is never created and every query that would have used it silently falls back to a full scan.
   *
   * Compares against `presentIndexes`, snapshotted at open time, so this hot-path check needs no
   * transaction of its own.
   */
  private hasAllStores(db: IDBDatabase): boolean {
    for (const [model, indexes] of this.models) {
      if (!db.objectStoreNames.contains(model)) return false;
      const present = this.presentIndexes.get(model);
      for (const name of present?.keys() ?? []) if (this.droppedIndexes.has(`${model}\0${name}`)) return false;
      for (const index of indexes) {
        if (index.text || index.ttlSeconds !== undefined) continue; // not expressible in IndexedDB
        // A definition changed under the same name (`unique` switched on) counts as missing, so the
        // index is rebuilt rather than left enforcing the old definition.
        const signature = indexSignature(indexKeyPath(index), index.unique ?? false);
        if (this.unbuildable.has(`${model}\0${index.name}\0${signature}`)) continue;
        if (present?.get(index.name) !== signature) return false;
      }
    }
    return true;
  }

  /** Record which indexes each store actually has, so `hasAllStores` can answer synchronously. */
  private snapshotIndexes(db: IDBDatabase): void {
    this.presentIndexes = new Map();
    const stores = nameList(db.objectStoreNames);
    if (!stores.length) return;
    const tx = db.transaction(stores, "readonly");
    for (const store of stores) {
      const objectStore = tx.objectStore(store);
      this.presentIndexes.set(
        store,
        new Map(
          nameList(objectStore.indexNames).map((name) => {
            const index = objectStore.index(name);
            return [name, indexSignature(index.keyPath, index.unique)];
          })
        )
      );
    }
  }

  private async reopen(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = await this.open();
    }
    if (!this.hasAllStores(this.db)) {
      const nextVersion = this.db.version + 1;
      this.db.close();
      // Cleared before awaiting: if the upgrade fails, a closed handle must not stay behind as `this.db`
      // — a closed database still lists its stores, so it would keep passing `hasAllStores`.
      this.forget();
      this.db = await this.open(nextVersion);
    }
    return this.db;
  }

  /** Drop the current connection's state, so the next operation opens afresh. */
  private forget(): void {
    this.db = null;
    this.presentIndexes = new Map();
  }

  private open(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request =
        version === undefined ? this.factory.open(this.name) : this.factory.open(this.name, version);

      const attempted: string[] = [];
      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction;
        for (const [model, indexes] of this.models) {
          const store = db.objectStoreNames.contains(model)
            ? tx!.objectStore(model)
            : db.createObjectStore(model, { keyPath: "uuid" });
          for (const name of nameList(store.indexNames)) {
            if (this.droppedIndexes.has(`${model}\0${name}`)) store.deleteIndex(name);
          }
          for (const index of indexes) {
            if (index.text || index.ttlSeconds !== undefined) continue; // not expressible in IndexedDB
            const keyPath = indexKeyPath(index);
            const signature = indexSignature(keyPath, index.unique ?? false);
            const key = `${model}\0${index.name}\0${signature}`;
            if (this.unbuildable.has(key)) continue; // failed before: leave whatever is there alone
            if (store.indexNames.contains(index.name)) {
              const existing = store.index(index.name);
              if (indexSignature(existing.keyPath, existing.unique) === signature) continue;
              store.deleteIndex(index.name); // redefined under the same name: rebuild it
            }
            store.createIndex(index.name, keyPath, { unique: index.unique ?? false });
            if (index.unique) attempted.push(key);
          }
        }
      };
      // `blocked` fires when another connection still holds the previous version. IndexedDB then just
      // waits — so without this the request never settles and every caller awaiting it hangs.
      let settled = false;
      request.onblocked = () => {
        settled = true;
        reject(new SchemaUpgradeBlockedError(this.name, version));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          // The caller was already told this open was blocked. When the blocker finally lets go the
          // request still succeeds — close that late connection instead of leaking it or letting it
          // overwrite the state of whatever connection is current by now.
          db.close();
          return;
        }
        settled = true;
        // Symmetrically: don't be the connection that blocks someone else's upgrade. A peer tab
        // bumping the version fires `versionchange` here; closing lets it proceed, and forgetting the
        // handle makes the next operation here reopen at the new version instead of failing on a
        // closed connection until the page reloads.
        const release = () => {
          db.close();
          if (this.db === db) this.forget();
        };
        db.onversionchange = release;
        db.onclose = release;
        this.snapshotIndexes(db);
        resolve(db);
      };
      request.onerror = () => {
        settled = true;
        const error = request.error ?? new Error("Failed to open IndexedDB");
        if (attempted.length) {
          // The upgrade aborted as a whole; a unique index over already-duplicate data is what does
          // that. Stop requiring those indexes, so the next operation opens instead of failing the
          // same way — and say which ones, since the constraint is now not in force.
          for (const key of attempted) this.unbuildable.add(key);
          const names = attempted.map((key) => key.split("\0").slice(0, 2).join("."));
          reject(new Error(`IndexedDB upgrade failed building unique index(es) ${names.join(", ")} — likely duplicate values. They are not enforced until the data is fixed. (${String((error as Error).message ?? error)})`));
          return;
        }
        reject(error);
      };
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

/** Compound → an array keyPath; single-field → the field path. */
function indexKeyPath(index: IndexSpec): string | string[] {
  return index.fields.length === 1 ? index.fields[0]!.path : index.fields.map((field) => field.path);
}

/** What makes two index definitions the same index: the key path and uniqueness. */
function indexSignature(keyPath: string | string[], unique: boolean): string {
  return `${JSON.stringify(keyPath)}|${unique ? "unique" : ""}`;
}
