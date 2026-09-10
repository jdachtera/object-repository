import type { Context } from "../core/types.ts";
import type { SchemaAdvertisement, SchemaCompatibility } from "../core/schema.ts";
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

  /**
   * Ask the server whether this client's schema is still serveable. A server too old to know the
   * method answers `UNSUPPORTED_METHOD`, which is reported as unchecked rather than as a failure — an
   * upgraded client must still be able to sync with a server that has not been redeployed yet.
   */
  async handshake(client: SchemaAdvertisement, ctx: Context): Promise<SchemaCompatibility> {
    const response = await this.transport.request({ method: "handshake", params: { ...client } }, ctx);
    if (response.ok) return { compatible: true, basis: "version" };
    const code = response.error?.code;
    if (code === "SCHEMA_TOO_OLD" || code === "SCHEMA_TOO_NEW" || code === "SCHEMA_MISMATCH") {
      return { compatible: false, code, message: response.error?.message ?? code };
    }
    return { compatible: true, basis: "unchecked" };
  }
}
