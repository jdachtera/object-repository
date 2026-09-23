import type { Context } from "../core/types.ts";
import { isSchemaRefusal, type SchemaAdvertisement, type SchemaCompatibility } from "../core/schema.ts";
import type { Transport, WireRequest, WireResponse } from "../core/Transport.ts";
import { SyncSchemaError } from "./SyncBackend.ts";
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
  /** Sent with every request, so a versioned server can judge each one (set by `handshake`). */
  private advertisement: SchemaAdvertisement | undefined;

  constructor(private readonly transport: Transport) {}

  async pull(cursor: SyncCursor | null, ctx: Context): Promise<SyncPullResult> {
    return expect(await this.send({ method: "pull", params: { cursor } }, ctx), "Sync pull failed.") as SyncPullResult;
  }

  async push(changes: SyncChange[], ctx: Context): Promise<SyncPushResult> {
    return expect(await this.send({ method: "push", params: { changes } }, ctx), "Sync push failed.") as SyncPushResult;
  }

  /**
   * Ask the server whether this client's schema is still serveable. Only a server too old to know the
   * method (`UNSUPPORTED_METHOD`) is reported as unchecked — an upgraded client must still be able to
   * sync with a server that has not been redeployed yet. Any other failure (an authorization error, a
   * gateway's 401) is an error, not a pass: failing open here would be remembered for the session.
   */
  async handshake(client: SchemaAdvertisement, ctx: Context): Promise<SchemaCompatibility> {
    this.advertisement = { ...client };
    const response = await this.transport.request({ method: "handshake", params: { ...client } }, ctx);
    if (response.ok) {
      const basis = (response.result as { basis?: unknown } | null)?.basis;
      return { compatible: true, basis: basis === "fingerprint" || basis === "unchecked" ? basis : "version" };
    }
    const code = response.error?.code;
    if (isSchemaRefusal(code)) return { compatible: false, code, message: response.error?.message ?? code };
    if (code === "UNSUPPORTED_METHOD") return { compatible: true, basis: "unchecked" };
    throw new Error(`Schema handshake failed: ${code ?? "error"}: ${response.error?.message ?? ""}`);
  }

  private send(request: WireRequest, ctx: Context): Promise<WireResponse> {
    return this.transport.request(this.advertisement ? { ...request, schema: this.advertisement } : request, ctx);
  }
}

/** The result, or — for a schema refusal on any request, not only the handshake — a `SyncSchemaError`. */
function expect(response: WireResponse, fallback: string): unknown {
  if (response.ok) return response.result;
  const code = response.error?.code;
  if (isSchemaRefusal(code)) throw new SyncSchemaError(code, response.error?.message ?? code);
  throw new Error(response.error?.message ?? fallback);
}
