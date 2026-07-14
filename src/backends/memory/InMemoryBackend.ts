import type {
  Backend,
  ChangeEvent,
  ChangeListener,
  IndexSpec,
  PersistResult,
  PersistedChange,
  SchemaAwareBackend,
  Unsubscribe
} from "../../core/Backend.ts";
import type { Capabilities, Context, JsonObject, JsonValue, Uuid } from "../../core/types.ts";
import type { QueryPlan } from "../../core/QueryPlan.ts";
import { generateUuid } from "../../core/uuid.ts";
import { scan } from "../util/scan.ts";
import { UniqueConstraintError, uniqueKey, uniqueKeySets } from "../util/unique.ts";

// Re-exported so existing importers (`backends/index.ts` and consumers) are unaffected by the move.
export { UniqueConstraintError } from "../util/unique.ts";

const CAPABILITIES: Capabilities = {
  indexes: false,
  ranges: false,
  sortPushdown: false,
  joins: false,
  transactions: true,
  changeFeed: true
};

/**
 * The reference backend (ARCHITECTURE.md §3, roadmap step 5).
 *
 * A scan-only store: it keeps records as plain JSON keyed by model + uuid and executes queries
 * with the in-memory `scan()` evaluator (no push-down). It is the simplest end of the capability
 * spectrum and the proof that a `QueryPlan` runs end to end against the `Backend` contract.
 *
 * Writes follow the unit-of-work pattern: `save`/`remove` queue, `persist` flushes atomically
 * and emits change events. (Real tombstones land with the sync seam, step 8; today `remove`
 * deletes and emits a `removed` event.)
 */
export class InMemoryBackend implements Backend, SchemaAwareBackend {
  readonly capabilities = CAPABILITIES;

  private readonly store = new Map<string, Map<Uuid, JsonObject>>();
  /** Per model, the field-tuples that must be unique (single-field hints + compound `unique` indexes). */
  private readonly uniqueKeys = new Map<string, string[][]>();
  /** Live value→uuid index per unique key-set (`uniqueIndex[model][keySetIndex]`), maintained on
   *  persist so `checkUnique` is an O(batch) lookup instead of an O(store) rescan every flush. */
  private readonly uniqueIndex = new Map<string, Map<number, Map<string, Uuid>>>();
  private saveQueue: PersistedChange[] = [];
  private removeQueue: PersistedChange[] = [];
  private readonly listeners = new Set<ChangeListener>();

  /** Learn which fields carry a unique constraint so `persist` can enforce it (the reference backend). */
  registerModel(model: string, indexes: IndexSpec[]): void {
    const keys = uniqueKeySets(indexes);
    this.uniqueKeys.set(model, keys);
    // (Re)build the value→uuid index from whatever is already stored (usually empty at define time).
    const perKeySet = new Map<number, Map<string, Uuid>>();
    keys.forEach((_, ki) => perKeySet.set(ki, new Map()));
    for (const [uuid, record] of this.modelStore(model)) {
      keys.forEach((fields, ki) => {
        const key = uniqueKey(record, fields);
        if (key !== null) perKeySet.get(ki)!.set(key, uuid);
      });
    }
    this.uniqueIndex.set(model, perKeySet);
  }

  async query(plan: QueryPlan, _ctx: Context): Promise<JsonObject[]> {
    // Scan the live records (the matcher/order/paging only *read* them), then clone just the rows
    // that survive — filtering before cloning turns an O(table) deep-clone into O(page).
    const matched = scan([...this.modelStore(plan.model).values()], plan);
    return matched.map((record) => {
      const isolated = clone(record);
      return plan.project ? pickFields(isolated, plan.project!) : isolated;
    });
  }

  async queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    const items = await this.query(plan, ctx);
    return items.map((item) => String(item.uuid));
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

    // Enforce unique constraints *before* mutating the store, so a violation leaves it untouched.
    this.checkUnique(saved, removed);

    // Update the unique index in two passes so a value *swap* between two records in one batch is
    // handled: drop every touched record's OLD key first (read from the store before it's mutated),
    // then add the saved records' NEW keys after.
    for (const change of [...saved, ...removed]) this.removeFromUniqueIndex(change.model, String(change.record.uuid));

    for (const change of saved) {
      this.modelStore(change.model).set(change.record.uuid as Uuid, clone(change.record));
    }
    for (const change of removed) {
      this.modelStore(change.model).delete(String(change.record.uuid));
    }

    for (const change of saved) this.addToUniqueIndex(change.model, change.record);

    for (const change of saved) {
      this.emit({
        model: change.model,
        uuid: String(change.record.uuid),
        kind: "saved",
        record: clone(change.record)
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

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Validate the batch's unique constraints against the store and against itself, throwing on the
   * first conflict. A key with any null/absent component is not enforced (NULLs distinct, like a plain
   * SQL unique index); a save whose uuid matches an existing record updates it (no self-conflict).
   */
  private checkUnique(saved: PersistedChange[], removed: PersistedChange[]): void {
    const byModel = new Map<string, PersistedChange[]>();
    for (const change of saved) {
      const list = byModel.get(change.model);
      if (list) list.push(change);
      else byModel.set(change.model, [change]);
    }
    for (const [model, changes] of byModel) {
      const keySets = this.uniqueKeys.get(model);
      if (!keySets || keySets.length === 0) continue;
      const index = this.uniqueIndex.get(model)!;
      // Records this batch rewrites or removes are freeing their old value, so an existing index entry
      // owned by one of them isn't a real conflict.
      const freed = new Set(changes.map((c) => String(c.record.uuid)));
      for (const change of removed) if (change.model === model) freed.add(String(change.record.uuid));
      keySets.forEach((fields, ki) => {
        const stored = index.get(ki)!; // key → uuid for records already in the store
        const seen = new Map<string, Uuid>(); // key → uuid within this batch
        for (const change of changes) {
          const key = uniqueKey(change.record, fields);
          if (key === null) continue;
          const uuid = String(change.record.uuid);
          const owner = stored.get(key);
          if (owner !== undefined && owner !== uuid && !freed.has(owner)) {
            throw new UniqueConstraintError(model, fields);
          }
          const batchOwner = seen.get(key);
          if (batchOwner !== undefined && batchOwner !== uuid) {
            throw new UniqueConstraintError(model, fields);
          }
          seen.set(key, uuid);
        }
      });
    }
  }

  /** Drop a record's current index entries (read from the store before it is mutated/removed). */
  private removeFromUniqueIndex(model: string, uuid: Uuid): void {
    const index = this.uniqueIndex.get(model);
    const old = this.modelStore(model).get(uuid);
    if (!index || !old) return;
    this.uniqueKeys.get(model)!.forEach((fields, ki) => {
      const key = uniqueKey(old, fields);
      const map = index.get(ki)!;
      if (key !== null && map.get(key) === uuid) map.delete(key); // only if still ours
    });
  }

  /** Add a saved record's index entries under its new values. */
  private addToUniqueIndex(model: string, record: JsonObject): void {
    const index = this.uniqueIndex.get(model);
    if (!index) return;
    const uuid = String(record.uuid);
    this.uniqueKeys.get(model)!.forEach((fields, ki) => {
      const key = uniqueKey(record, fields);
      if (key !== null) index.get(ki)!.set(key, uuid);
    });
  }

  private modelStore(model: string): Map<Uuid, JsonObject> {
    let store = this.store.get(model);
    if (!store) {
      store = new Map();
      this.store.set(model, store);
    }
    return store;
  }
}

function clone(record: JsonObject): JsonObject {
  return structuredClone(record);
}

/** Keep only the named fields (plus uuid) — the in-memory projection. */
export function pickFields(record: JsonObject, fields: string[]): JsonObject {
  const picked: JsonObject = {};
  for (const field of ["uuid", ...fields]) {
    const value = record[field];
    if (value !== undefined) picked[field] = value;
  }
  return picked;
}
