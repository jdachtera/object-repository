import type { Context } from "../core/types.ts";
import type { Transport } from "../core/Transport.ts";
import type {
  SyncChange,
  SyncCursor,
  SyncPullResult,
  SyncPushResult,
  SyncTarget
} from "../core/SyncTarget.ts";

/**
 * A client `SyncTarget` that proxies `pull`/`push` to a server over a `Transport` — the sync
 * counterpart of `RemoteBackend`. Point it at any transport the server's `SyncTargetAdapter` is served
 * behind (`HttpTransport`, `InProcessTransport`, …) and hand it to a `SyncBackend` as its `remote`:
 *
 * ```ts
 * const remote = new RemoteSyncTarget(new HttpTransport("https://api.example.com/sync"));
 * const backend = new SyncBackend({ local: new IndexedDBBackend(), remote, nodeId });
 * ```
 */
export class RemoteSyncTarget implements SyncTarget {
  constructor(private readonly transport: Transport) {}

  async pull(cursor: SyncCursor | null, ctx: Context): Promise<SyncPullResult> {
    const response = await this.transport.request({ method: "pull", params: { cursor } }, ctx);
    if (!response.ok) throw new Error(response.error?.message ?? "Sync pull failed.");
    return response.result as SyncPullResult;
  }

  async push(changes: SyncChange[], ctx: Context): Promise<SyncPushResult> {
    const response = await this.transport.request({ method: "push", params: { changes } }, ctx);
    if (!response.ok) throw new Error(response.error?.message ?? "Sync push failed.");
    return response.result as SyncPushResult;
  }
}
