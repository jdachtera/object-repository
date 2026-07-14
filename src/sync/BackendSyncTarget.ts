import type { Backend } from "../core/Backend.ts";
import type { Context, JsonObject } from "../core/types.ts";
import type {
  SyncChange,
  SyncCursor,
  SyncPullResult,
  SyncPushResult,
  SyncTarget
} from "../core/SyncTarget.ts";
import { RepositoryManager } from "../repository/RepositoryManager.ts";
import type { Repository } from "../repository/Repository.ts";
import { text, integer, json } from "../properties/factories.ts";
import { and, eq, gt } from "../expressions/builders.ts";

export interface BackendSyncTargetOptions {
  /** Model/table name for the durable changelog (default `"__sync_changes__"`). */
  changelogModel?: string;
}

/** A stored changelog row — one per accepted change (append-only). */
interface ChangeRow {
  uuid: string;
  seq: number;
  srcModel: string;
  srcUuid: string;
  kind: "saved" | "removed";
  record: JsonObject | null;
  version: string;
  fieldVersions: Record<string, string> | null;
}

/**
 * A **durable** `SyncTarget` server: the same append-only-changelog / last-write-wins protocol as
 * `InMemorySyncTarget`, but persisted in an injected `Backend` — so a real deployment can run the sync
 * hub over SQLite, Postgres, MySQL, or Mongo instead of losing the log on restart. Point a
 * `SyncTargetAdapter` at one to expose it over a transport; clients reach it with a `RemoteSyncTarget`.
 *
 * The changelog lives in its own model (`__sync_changes__` by default) on the given backend, alongside
 * whatever else that store holds. The **pull cursor** is a server-assigned append sequence (`seq`),
 * *not* the HLC `version`: a change pushed with a lagging clock still lands at the end of the log and is
 * delivered to every client, exactly as the in-memory reference does. `version` is used only for LWW
 * conflict arbitration.
 *
 * Concurrency: `push` is serialized (one batch at a time) so `seq` assignment and the read-then-append
 * conflict check are atomic within this process. Across *multiple* server processes sharing one store,
 * put a real sequence/lock in front (or run a single hub); the single-process guarantee holds otherwise.
 */
export class BackendSyncTarget implements SyncTarget {
  private readonly changes: Repository<never>;
  private seq = 0;
  private ready: Promise<void> | null = null;
  private pushChain: Promise<unknown> = Promise.resolve();

  constructor(backend: Backend, options: BackendSyncTargetOptions = {}) {
    const orm = new RepositoryManager({ backend });
    this.changes = orm.define({
      name: options.changelogModel ?? "__sync_changes__",
      properties: {
        seq: integer({ index: true }),
        srcModel: text({ index: true }),
        srcUuid: text({ index: true }),
        kind: text(),
        record: json<JsonObject | null>(),
        version: text(),
        fieldVersions: json<Record<string, string> | null>()
      }
    }) as unknown as Repository<never>;
  }

  /** Seed the in-memory `seq` counter from the persisted max, once — so it survives a restart. */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const top = await this.changes.all().sort("seq", true).page({ limit: 1 });
        const row = top.items[0] as ChangeRow | undefined;
        this.seq = row ? row.seq : 0;
      })();
    }
    return this.ready;
  }

  async pull(cursor: SyncCursor | null, _ctx: Context): Promise<SyncPullResult> {
    await this.ensureReady();
    const from = cursor ? Number(cursor) : 0;
    const rows = (await this.changes.all().filter(gt("seq", from)).sort("seq").list()) as unknown as ChangeRow[];
    const next = rows.length ? rows[rows.length - 1]!.seq : from;
    return { changes: rows.map(toChange), cursor: String(next) };
  }

  async push(changes: SyncChange[], _ctx: Context): Promise<SyncPushResult> {
    // Serialize pushes: seq assignment + the read-then-append conflict check must not interleave.
    const run = this.pushChain.then(() => this.applyPush(changes));
    // Keep the chain alive even if this batch throws, so a later push isn't blocked forever.
    this.pushChain = run.catch(() => undefined);
    return run;
  }

  private async applyPush(changes: SyncChange[]): Promise<SyncPushResult> {
    await this.ensureReady();
    const acknowledged: string[] = [];
    const conflicts: SyncChange[] = [];

    for (const change of changes) {
      // Field-level changes are never a whole-record conflict — a concurrent edit to a *different*
      // field must survive. Append + acknowledge; clients merge per-field on pull (matches the reference).
      if (change.fieldVersions) {
        this.append(change);
        acknowledged.push(change.uuid);
        continue;
      }
      const current = await this.latest(change.model, change.uuid);
      if (!current || change.version > current.version) {
        this.append(change);
        acknowledged.push(change.uuid);
      } else {
        conflicts.push(toChange(current));
      }
    }
    await this.changes.persist();
    return { acknowledged, conflicts };
  }

  /** Queue an appended changelog row with a fresh server sequence (persisted by the caller). */
  private append(change: SyncChange): void {
    const row: ChangeRow = {
      uuid: `${++this.seq}`,
      seq: this.seq,
      srcModel: change.model,
      srcUuid: change.uuid,
      kind: change.kind,
      record: change.record ?? null,
      version: change.version,
      fieldVersions: change.fieldVersions ?? null
    };
    this.changes.save(this.changes.createInstance(row as never));
  }

  /** The most recent logged change for a record (highest HLC version), if any. */
  private async latest(model: string, uuid: string): Promise<ChangeRow | undefined> {
    const page = await this.changes
      .all()
      .filter(and(eq("srcModel", model), eq("srcUuid", uuid)))
      .sort("version", true)
      .page({ limit: 1 });
    return page.items[0] as ChangeRow | undefined;
  }
}

function toChange(row: ChangeRow): SyncChange {
  return {
    model: row.srcModel,
    uuid: row.srcUuid,
    kind: row.kind,
    record: row.record ?? undefined,
    version: row.version,
    fieldVersions: row.fieldVersions ?? undefined
  };
}
