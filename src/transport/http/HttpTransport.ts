import type { Context } from "../../core/types.ts";
import type { Transport, WireRequest, WireResponse, WireUnsubscribe } from "../../core/Transport.ts";

export interface HttpTransportOptions {
  /** Fetch implementation (defaults to the global). */
  fetch?: typeof fetch;
  /** Path for request/response RPC (default `/rpc`). */
  rpcPath?: string;
  /** Path for the SSE change feed (default `/changes`). */
  changesPath?: string;
}

/**
 * HTTP client transport (ARCHITECTURE.md §10). Request/response ops go over `POST /rpc`; the
 * change feed rides Server-Sent Events on `GET /changes` (server→client push over plain HTTP — a
 * WebSocket transport would implement the same `subscribe` contract). Works in the browser and in
 * Node ≥ 18 via the global `fetch`/`ReadableStream`/`AbortController`.
 */
export class HttpTransport implements Transport {
  private readonly fetchImpl: typeof fetch;
  private readonly rpcPath: string;
  private readonly changesPath: string;

  constructor(
    private readonly baseUrl: string,
    options: HttpTransportOptions = {}
  ) {
    // Bind to `globalThis`: the browser's `fetch` throws "Illegal invocation" if called as a method
    // of any other object (which `this.fetchImpl(...)` would be). A caller-supplied fetch is used as-is.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.rpcPath = options.rpcPath ?? "/rpc";
    this.changesPath = options.changesPath ?? "/changes";
  }

  async request(op: WireRequest, _ctx: Context): Promise<WireResponse> {
    const response = await this.fetchImpl(this.baseUrl + this.rpcPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(op)
    });
    return (await response.json()) as WireResponse;
  }

  subscribe(_op: WireRequest, onEvent: (event: unknown) => void, _ctx: Context): WireUnsubscribe {
    const controller = new AbortController();
    void this.stream(controller.signal, onEvent);
    return () => controller.abort();
  }

  private async stream(signal: AbortSignal, onEvent: (event: unknown) => void): Promise<void> {
    try {
      const response = await this.fetchImpl(this.baseUrl + this.changesPath, {
        headers: { accept: "text/event-stream" },
        signal
      });
      const body = response.body;
      if (!body) return;

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5).trim()));
          }
        }
      }
    } catch {
      // Aborted by the caller or the connection closed — nothing to do.
    }
  }
}
