import type { Context, SchemaVersioning } from "../core/types.ts";
import { checkSchemaCompatibility, enforceSchema, type SchemaAdvertisement } from "../core/schema.ts";
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
  constructor(
    private readonly target: SyncTarget,
    /**
     * The server's declared schema versions. Supplying them lets a client discover it is too old to
     * sync — the alternative is that it silently pulls records in a shape it cannot interpret and
     * pushes records the server no longer understands.
     */
    private readonly schema?: SchemaVersioning,
    /** The server's schema fingerprint, used when either end declares no version. */
    private readonly fingerprint?: string
  ) {}

  private advertisement(): SchemaAdvertisement {
    return { ...(this.fingerprint === undefined ? {} : { fingerprint: this.fingerprint }), ...(this.schema ?? {}) };
  }

  async handle(request: WireRequest, ctx: Context): Promise<WireResponse> {
    try {
      if (request.method !== "handshake") {
        // The handshake lets a client fail early; this is what protects the server. A client that
        // skipped it, or a redeploy that raised the floor mid-session, is refused here.
        const refusal = enforceSchema(request.schema, this.advertisement());
        if (refusal && !refusal.compatible) return { ok: false, error: { code: refusal.code, message: refusal.message } };
      }
      switch (request.method) {
        case "pull": {
          const { cursor } = (request.params ?? {}) as { cursor?: SyncCursor | null };
          return { ok: true, result: await this.target.pull(cursor ?? null, ctx) };
        }
        case "push": {
          const { changes } = (request.params ?? {}) as { changes?: SyncChange[] };
          return { ok: true, result: await this.target.push(changes ?? [], ctx) };
        }
        case "handshake": {
          const client = (request.params ?? {}) as SchemaAdvertisement;
          const server = this.advertisement();
          const verdict = checkSchemaCompatibility(client, server);
          if (!verdict.compatible) return { ok: false, error: { code: verdict.code, message: verdict.message } };
          return { ok: true, result: { ...verdict, server } };
        }
        default:
          return {
            ok: false,
            error: {
              code: "UNSUPPORTED_METHOD",
              message: `SyncTargetAdapter handles pull/push/handshake, not "${request.method}".`
            }
          };
      }
    } catch (error) {
      return { ok: false, error: { code: "SYNC_ERROR", message: String((error as Error)?.message ?? error) } };
    }
  }
}
