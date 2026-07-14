import type { Context } from "../core/types.ts";
import type { TransportAdapter, WireRequest, WireResponse } from "../core/Transport.ts";
import type { SyncChange, SyncCursor, SyncTarget } from "../core/SyncTarget.ts";

/**
 * Server-side bridge that exposes a `SyncTarget` over a transport (the sync counterpart of
 * `BackendAdapter`). It handles the `pull`/`push` wire methods and nothing else, so it can be served by
 * the same `createRequestListener` / `InProcessTransport` plumbing as a backend adapter. Wrap the target
 * in a `PolicyBackend`-style guard *before* handing it here if you need per-request authorization;
 * authentication comes from the `Context` the transport supplies.
 */
export class SyncTargetAdapter implements TransportAdapter {
  constructor(private readonly target: SyncTarget) {}

  async handle(request: WireRequest, ctx: Context): Promise<WireResponse> {
    try {
      switch (request.method) {
        case "pull": {
          const { cursor } = (request.params ?? {}) as { cursor?: SyncCursor | null };
          return { ok: true, result: await this.target.pull(cursor ?? null, ctx) };
        }
        case "push": {
          const { changes } = (request.params ?? {}) as { changes?: SyncChange[] };
          return { ok: true, result: await this.target.push(changes ?? [], ctx) };
        }
        default:
          return {
            ok: false,
            error: { code: "UNSUPPORTED_METHOD", message: `SyncTargetAdapter handles pull/push, not "${request.method}".` }
          };
      }
    } catch (error) {
      return { ok: false, error: { code: "SYNC_ERROR", message: String((error as Error)?.message ?? error) } };
    }
  }
}
