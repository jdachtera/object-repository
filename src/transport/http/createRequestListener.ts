import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "../../core/types.ts";
import { SYSTEM_CONTEXT } from "../../core/types.ts";
import type { WireRequest } from "../../core/Transport.ts";
import type { TransportAdapter } from "../../core/Transport.ts";

export interface HttpServerOptions {
  /**
   * Build the request context (identity) from the HTTP request — this is the authentication seam
   * (ARCHITECTURE.md §8). Defaults to the system context.
   */
  context?: (request: IncomingMessage) => Context;
  rpcPath?: string;
  changesPath?: string;
  /** Reject a request body larger than this many bytes with 413 (default 1 MiB). Guards against OOM. */
  maxBodyBytes?: number;
}

/**
 * A `node:http`-compatible request listener that exposes a `BackendAdapter` over HTTP
 * (ARCHITECTURE.md §10): `POST /rpc` for request/response, `GET /changes` for the SSE change feed.
 * Only `node:http` *types* are imported (erased at build), so this stays free of a runtime Node
 * dependency; mount it with `http.createServer(listener)` or adapt it to any framework.
 */
export function createRequestListener(
  adapter: TransportAdapter,
  options: HttpServerOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const contextFor = options.context ?? (() => SYSTEM_CONTEXT);
  const rpcPath = options.rpcPath ?? "/rpc";
  const changesPath = options.changesPath ?? "/changes";
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  return (req, res) => {
    if (req.method === "POST" && req.url === rpcPath) {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > maxBodyBytes) {
          // Stop buffering and reject before the process runs out of memory.
          aborted = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: `Body exceeds ${maxBodyBytes} bytes.` } }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (aborted) return;
        void handleRpc(adapter, Buffer.concat(chunks).toString("utf8"), contextFor(req), res);
      });
      // A mid-request socket error would otherwise emit an unhandled 'error' event on the stream.
      req.on("error", () => {
        aborted = true;
      });
      return;
    }

    if (req.method === "GET" && req.url === changesPath) {
      // A pull/push-only adapter (e.g. a SyncTarget) has no change feed — there's nothing to stream.
      if (!adapter.subscribe) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "NO_CHANGE_FEED", message: "This endpoint has no change stream." } }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write(":ok\n\n"); // comment frame so the client knows the stream is open
      const unsubscribe = adapter.subscribe((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }, contextFor(req));
      req.on("close", unsubscribe);
      return;
    }

    res.writeHead(404);
    res.end();
  };
}

async function handleRpc(
  adapter: TransportAdapter,
  body: string,
  ctx: Context,
  res: ServerResponse
): Promise<void> {
  try {
    const request = JSON.parse(body) as WireRequest;
    const response = await adapter.handle(request, ctx);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: false, error: { code: "BAD_REQUEST", message: String(error) } })
    );
  }
}
