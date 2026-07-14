import type {
  Backend,
  ChangeListener,
  IndexSpec,
  PersistResult,
  SchemaAwareBackend,
  Unsubscribe
} from "../core/Backend.ts";
import { isCounting, isSchemaAware } from "../core/Backend.ts";
import type { CountingBackend } from "../core/Backend.ts";
import type { Capabilities, Context, JsonObject, Uuid } from "../core/types.ts";
import type { QueryPlan } from "../core/QueryPlan.ts";
import type { ConflictPolicy, SyncChange, SyncCursor, SyncTarget } from "../core/SyncTarget.ts";
import { generateUuid } from "../core/uuid.ts";
import { eq, neq, and, all, inList } from "../expressions/builders.ts";
import { parse } from "../expressions/parse.ts";
import { HybridLogicalClock } from "./hlc.ts";

/** Field stamped onto stored records to carry their HLC version (invisible to model mapping). */
const VERSION_FIELD = "_version";
/** Field marking a soft-deleted (tombstoned) record so a remove can carry a comparable version. */
const TOMBSTONE_FIELD = "_deleted";
/** Field carrying the per-field HLC versions in field-level sync (field name → version). */
const FIELD_VERSIONS_FIELD = "_fieldVersions";
/** Reserved model the durable outbox is stored under, in the local backend. */
const OUTBOX_MODEL = "_outbox";
/** Reserved fields never treated as data (never merged, never per-field versioned). */
const RESERVED = new Set([VERSION_FIELD, TOMBSTONE_FIELD, FIELD_VERSIONS_FIELD]);

/** Last-write-wins by HLC version — the default conflict policy (ARCHITECTURE.md §9). */
export const lastWriteWins: ConflictPolicy = (local, remote) =>
  remote.version > local.version ? remote : local;

export interface SyncBackendOptions {
  local: Backend;
  remote: SyncTarget;
  /** Stable replica id, mixed into HLC timestamps to break ties deterministically. */
  nodeId?: string;
  conflict?: ConflictPolicy;
  /**
   * Enable **field-level** sync: concurrent edits to *different* fields of the same record both
   * survive (per-field last-write-wins), instead of the whole higher-versioned record clobbering the
   * other. Opt-in and deployment-wide — every replica AND the server must run field-level, because a
   * field-level change carries a `_fieldVersions` map the server must not reject as a whole-record
   * conflict; a mixed peer degrades safely to whole-record LWW. Default off preserves today's
   * behavior exactly. (MVP: full-record payloads + a session-scoped field-version cache; a cold
   * SyncBackend stamps a pre-existing record's present fields on its first edit — the durable outbox
   * still replays already-stamped changes, so nothing is lost.)
   */
  fieldLevel?: boolean;
}

/**
 * Offline-first sync as a composite backend (ARCHITECTURE.md §9).
 *
 * Implements `Backend` by delegating reads/writes to a `local` backend, while buffering outbound
 * changes for a `remote` `SyncTarget`. It is a stateful decorator: reads are local (offline-first),
 * writes are optimistic-local + queued, and `reconcile()` pulls remote changes (merging via the
 * conflict policy) and pushes the outbox. Records are stamped with an HLC version so concurrent
 * edits order deterministically.
 *
 * Limitation (matches §9): the reference local backend hard-deletes, so removals propagate but a
 * remove-vs-concurrent-edit conflict can't be fully arbitrated without tombstones — a documented
 * follow-up.
 */
export class SyncBackend implements Backend, SchemaAwareBackend, CountingBackend {
  readonly capabilities: Capabilities;

  private readonly local: Backend;
  private readonly remote: SyncTarget;
  private readonly conflict: ConflictPolicy;
  private readonly hlc: HybridLogicalClock;
  private readonly fieldLevel: boolean;
  /** Session-scoped cache of the last-known per-field versions, keyed `model\0uuid` (field-level mode). */
  private readonly fieldVersions = new Map<string, Record<string, string>>();

  private cursor: SyncCursor | null = null;

  constructor(options: SyncBackendOptions) {
    this.local = options.local;
    this.remote = options.remote;
    this.conflict = options.conflict ?? lastWriteWins;
    this.hlc = new HybridLogicalClock(options.nodeId ?? generateUuid().slice(0, 8));
    this.fieldLevel = options.fieldLevel ?? false;
    this.capabilities = this.local.capabilities;
    if (isSchemaAware(this.local)) this.local.registerModel(OUTBOX_MODEL, []);
  }

  registerModel(model: string, indexes: IndexSpec[]): void {
    if (isSchemaAware(this.local)) this.local.registerModel(model, indexes);
  }

  // Reads are offline-first: always local, with tombstones filtered out by query rewriting.
  query(plan: QueryPlan, ctx: Context): Promise<JsonObject[]> {
    return this.local.query(this.excludeTombstones(plan), ctx);
  }
  queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    return this.local.queryUuids(this.excludeTombstones(plan), ctx);
  }

  async count(plan: QueryPlan, ctx: Context): Promise<number> {
    const live = this.excludeTombstones(plan);
    if (isCounting(this.local)) return this.local.count(live, ctx);
    return (await this.local.query(live, ctx)).length;
  }

  save(model: string, record: JsonObject, ctx: Context, dirty?: readonly string[]): void {
    if (typeof record.uuid !== "string" || record.uuid.length === 0) {
      record.uuid = generateUuid();
    }
    const uuid = String(record.uuid);
    const version = this.hlc.now();

    if (this.fieldLevel) {
      const key = `${model} ${uuid}`;
      const prior = this.fieldVersions.get(key);
      // No prior versions cached → treat as an insert and version every present field. With a prior,
      // bump only the changed fields (`dirty`; undefined = a no-op save = nothing changed), carrying
      // the rest forward — so a stale value never re-clobbers a concurrent edit to another field.
      const fv: Record<string, string> = prior ? { ...prior } : {};
      const changed = prior ? (dirty ?? []) : Object.keys(record).filter((k) => !RESERVED.has(k));
      for (const field of changed) fv[field] = version;
      this.fieldVersions.set(key, fv);
      const maxVersion = maxOf(fv) ?? version;
      const stamped: JsonObject = { ...record, [VERSION_FIELD]: maxVersion, [FIELD_VERSIONS_FIELD]: fv };
      this.local.save(model, stamped, ctx, dirty && [...dirty, VERSION_FIELD, FIELD_VERSIONS_FIELD]);
      this.enqueue({ model, uuid, kind: "saved", record: stamped, version: maxVersion, fieldVersions: fv }, ctx);
      return;
    }

    const stamped: JsonObject = { ...record, [VERSION_FIELD]: version };
    // `_version` isn't a Repository-declared field, so it never appears in `dirty` — but it changes
    // on every save. Widen the hint so a scoped write downstream still persists the new version.
    this.local.save(model, stamped, ctx, dirty && [...dirty, VERSION_FIELD]);
    this.enqueue({ model, uuid, kind: "saved", record: stamped, version }, ctx);
  }

  remove(model: string, record: JsonObject, ctx: Context): void {
    const version = this.hlc.now();
    const uuid = String(record.uuid);
    // Store a tombstone (a versioned soft-delete) rather than hard-deleting, so a later
    // remove-vs-edit conflict can be arbitrated by comparing versions.
    const tombstone: JsonObject = { uuid, [VERSION_FIELD]: version, [TOMBSTONE_FIELD]: true };
    this.local.save(model, tombstone, ctx);
    this.enqueue({ model, uuid, kind: "removed", record: tombstone, version }, ctx);
  }

  /** Append a change to the durable outbox (a record in the local backend), so it survives restart. */
  private enqueue(change: SyncChange, ctx: Context): void {
    this.local.save(OUTBOX_MODEL, { uuid: generateUuid(), change } as unknown as JsonObject, ctx);
  }

  persist(ctx: Context): Promise<PersistResult> {
    return this.local.persist(ctx);
  }

  changes(listener: ChangeListener, ctx: Context): Unsubscribe {
    // Tombstones are stored as saves; surface them to consumers as removals so caches stay correct.
    return this.local.changes((event) => {
      if (event.kind === "saved" && event.record?.[TOMBSTONE_FIELD] === true) {
        listener({ model: event.model, uuid: event.uuid, kind: "removed" });
      } else {
        listener(event);
      }
    }, ctx);
  }

  /** Pull remote changes (merging by conflict policy) then push the local outbox. */
  async reconcile(ctx: Context): Promise<void> {
    await this.pull(ctx);
    await this.push(ctx);
  }

  private async pull(ctx: Context): Promise<void> {
    const { changes, cursor } = await this.remote.pull(this.cursor, ctx);
    // Load every incoming change's current local record up front — one `uuid IN (…)` per model
    // instead of a query per change. Local writes here only queue (they persist after the loop), so
    // every `applyIncoming` sees the same pre-pull state whether read one-by-one or in a batch.
    const localByKey = await this.loadLocalRecords(changes, ctx);
    let applied = 0;
    for (const incoming of changes) {
      const local = localByKey.get(`${incoming.model} ${incoming.uuid}`) ?? null;
      if (await this.applyIncoming(incoming, local, ctx)) applied += 1;
    }
    this.cursor = cursor;
    if (applied > 0) await this.local.persist(ctx);
  }

  /** Batch-load the current local record for every incoming change, keyed by `model\0uuid`. */
  private async loadLocalRecords(changes: SyncChange[], ctx: Context): Promise<Map<string, JsonObject>> {
    const byModel = new Map<string, Set<Uuid>>();
    for (const change of changes) {
      const set = byModel.get(change.model) ?? new Set<Uuid>();
      set.add(change.uuid);
      byModel.set(change.model, set);
    }
    const records = new Map<string, JsonObject>();
    for (const [model, uuids] of byModel) {
      const rows = await this.local.query(
        { model, where: inList("uuid", [...uuids]).serialize(), order: [], paging: { start: 0 } },
        ctx
      );
      for (const row of rows) records.set(`${model} ${String(row.uuid)}`, row);
    }
    return records;
  }

  private async push(ctx: Context): Promise<void> {
    // Flush any pending local writes (including just-enqueued outbox entries) so the durable
    // outbox is the source of truth, then read it back.
    await this.local.persist(ctx);
    const entries = await this.local.query(
      { model: OUTBOX_MODEL, where: all().serialize(), order: [], paging: { start: 0 } },
      ctx
    );
    if (entries.length === 0) return;

    const batch = entries.map((entry) => entry.change as unknown as SyncChange);
    const { conflicts } = await this.remote.push(batch, ctx);

    // The remote rejected some in favour of a newer version — adopt it locally. (Conflicts are few,
    // so resolving each one's local record individually is fine.)
    for (const conflict of conflicts) {
      await this.applyIncoming(conflict, await this.localRecord(conflict.model, conflict.uuid, ctx), ctx);
    }
    // Drop the pushed entries (acknowledged or superseded — either way resolved).
    for (const entry of entries) {
      this.local.remove(OUTBOX_MODEL, { uuid: String(entry.uuid) }, ctx);
    }
    await this.local.persist(ctx);
  }

  /** Apply a remote change locally if the conflict policy says it wins. Returns whether it applied.
   *  `localRecord` is the current local state (batch-loaded by the caller), or null if absent. */
  private async applyIncoming(incoming: SyncChange, localRecord: JsonObject | null, ctx: Context): Promise<boolean> {
    this.hlc.update(incoming.version);

    // Field-level merge: when both sides carry per-field versions and neither is a tombstone, keep the
    // higher-versioned value per field, so concurrent edits to different fields both survive. A missing
    // side (new record), a tombstone, or a non-field-level peer falls through to whole-record LWW.
    const localFv = localRecord?.[FIELD_VERSIONS_FIELD] as Record<string, string> | undefined;
    if (this.fieldLevel && incoming.record && incoming.fieldVersions && localRecord && localFv && incoming.kind === "saved" && localRecord[TOMBSTONE_FIELD] !== true) {
      const merged = mergeByField(localRecord, localFv, incoming.record, incoming.fieldVersions);
      if (merged === null) return false; // merge is identical to local → nothing to apply
      this.fieldVersions.set(`${incoming.model} ${incoming.uuid}`, merged[FIELD_VERSIONS_FIELD] as Record<string, string>);
      this.local.save(incoming.model, merged, ctx);
      return true;
    }

    if (localRecord) {
      const localChange: SyncChange = {
        model: incoming.model,
        uuid: incoming.uuid,
        kind: "saved",
        record: localRecord,
        version: String(localRecord[VERSION_FIELD] ?? "")
      };
      if (this.conflict(localChange, incoming) !== incoming) return false; // local wins
    }

    if (incoming.record) {
      // For both saves and tombstoned removes the record carries the version — store it so future
      // conflicts compare correctly. (A versionless legacy remove falls back to a hard delete.)
      this.local.save(incoming.model, incoming.record, ctx);
      if (this.fieldLevel && incoming.fieldVersions) {
        this.fieldVersions.set(`${incoming.model} ${incoming.uuid}`, { ...incoming.fieldVersions });
      }
    } else if (incoming.kind === "removed") {
      this.local.remove(incoming.model, { uuid: incoming.uuid }, ctx);
    }
    return true;
  }

  private excludeTombstones(plan: QueryPlan): QueryPlan {
    const live = neq(TOMBSTONE_FIELD, true);
    const where = plan.where.type === "all" ? live : and(parse(plan.where), live);
    return { ...plan, where: where.serialize() };
  }

  private async localRecord(model: string, uuid: Uuid, ctx: Context): Promise<JsonObject | null> {
    const rows = await this.local.query(
      { model, where: eq("uuid", uuid).serialize(), order: [], paging: { start: 0 } },
      ctx
    );
    return rows[0] ?? null;
  }
}

/** The lexicographically-largest HLC string in a per-field version map, or `undefined` when empty. */
function maxOf(versions: Record<string, string>): string | undefined {
  let max: string | undefined;
  for (const v of Object.values(versions)) if (max === undefined || v > max) max = v;
  return max;
}

/**
 * Merge two versions of a record field-by-field: for every data field on either side, keep the value
 * from whichever side has the higher per-field HLC version (deterministic — HLC strings embed a nodeId,
 * so every replica picks the same winner). Reserved fields are recomputed (`_version` = max, merged
 * `_fieldVersions`). Returns the merged record, or `null` when it is identical to `local` (nothing to
 * apply — avoids a redundant write and re-sync).
 */
function mergeByField(
  local: JsonObject,
  localFv: Record<string, string>,
  incoming: JsonObject,
  incomingFv: Record<string, string>
): JsonObject | null {
  const merged: JsonObject = {};
  const mergedFv: Record<string, string> = {};
  const fields = new Set([...Object.keys(local), ...Object.keys(incoming)].filter((k) => !RESERVED.has(k)));
  let changedFromLocal = false;
  for (const field of fields) {
    const lv = localFv[field] ?? "";
    const iv = incomingFv[field] ?? "";
    const takeIncoming = iv > lv;
    if (takeIncoming) {
      if (field in incoming) merged[field] = incoming[field]!;
      changedFromLocal = true;
    } else if (field in local) {
      merged[field] = local[field]!;
    }
    const winnerV = takeIncoming ? iv : lv;
    if (winnerV) mergedFv[field] = winnerV;
  }
  if (!changedFromLocal) return null; // local already dominates every field
  merged[FIELD_VERSIONS_FIELD] = mergedFv;
  merged[VERSION_FIELD] = maxOf(mergedFv) ?? String(local[VERSION_FIELD] ?? "");
  return merged;
}
