import type { Context } from "../core/types.ts";
import type {
  SyncChange,
  SyncCursor,
  SyncPullResult,
  SyncPushResult,
  SyncTarget
} from "../core/SyncTarget.ts";

/**
 * A reference `SyncTarget` server (ARCHITECTURE.md §9): an append-only changelog with last-write-
 * wins by HLC version. Useful as a test/demo "server" that two `SyncBackend` replicas sync through.
 * The cursor is simply the log length at pull time, so a client pulls only what it hasn't seen.
 */
export class InMemorySyncTarget implements SyncTarget {
  private readonly log: SyncChange[] = [];

  async pull(cursor: SyncCursor | null, _ctx: Context): Promise<SyncPullResult> {
    const from = cursor ? Number(cursor) : 0;
    return { changes: this.log.slice(from), cursor: String(this.log.length) };
  }

  async push(changes: SyncChange[], _ctx: Context): Promise<SyncPushResult> {
    const acknowledged: string[] = [];
    const conflicts: SyncChange[] = [];

    for (const change of changes) {
      // Field-level changes are never a whole-record conflict — a concurrent edit to a *different*
      // field must not be dropped. Append + acknowledge; clients merge per-field on pull.
      if (change.fieldVersions) {
        this.log.push(change);
        acknowledged.push(change.uuid);
        continue;
      }
      const current = this.latest(change.model, change.uuid);
      if (!current || change.version > current.version) {
        this.log.push(change);
        acknowledged.push(change.uuid);
      } else {
        // Server already holds a newer version — report it so the client adopts it.
        conflicts.push(current);
      }
    }
    return { acknowledged, conflicts };
  }

  /** The most recent logged change for a record, if any. */
  private latest(model: string, uuid: string): SyncChange | undefined {
    let result: SyncChange | undefined;
    for (const change of this.log) {
      if (change.model === model && change.uuid === uuid) {
        if (!result || change.version > result.version) result = change;
      }
    }
    return result;
  }
}
