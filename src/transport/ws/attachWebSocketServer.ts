import type { Context } from "../../core/types.ts";
import { SYSTEM_CONTEXT } from "../../core/types.ts";
import type { WireRequest } from "../../core/Transport.ts";
import type { BackendAdapter } from "../BackendAdapter.ts";

/** Minimal `ws`-style socket/server surfaces, so this stays free of a runtime `ws` dependency. */
interface SocketLike {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}
/** The upgrade request `ws` hands to the `connection` listener (an `http.IncomingMessage` at runtime) —
 *  structurally typed so `context()` can read a token/cookie without a hard `node:http` dependency. */
export interface UpgradeRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly url?: string;
}
interface ServerLike {
  on(event: "connection", listener: (socket: SocketLike, request: UpgradeRequest) => void): void;
}

export interface WebSocketServerOptions {
  /**
   * Build the request context from a new connection — the authentication seam (§8). Receives the WS
   * *upgrade request*, so a per-connection identity can be resolved from its headers/cookies/token
   * (parity with the HTTP listener). May be async. Defaults to the anonymous `SYSTEM_CONTEXT`.
   */
  context?: (request: UpgradeRequest) => Context | Promise<Context>;
}

/**
 * Attach a `BackendAdapter` to a `ws`-style WebSocket server (ARCHITECTURE.md §10). Each connection
 * gets a change-feed subscription pushed as `event` messages; incoming `request` messages are
 * dispatched to the adapter and answered with a correlated `response`. Typed against minimal
 * structural interfaces, so the library needs no runtime `ws` dependency.
 */
export function attachWebSocketServer(
  server: ServerLike,
  adapter: BackendAdapter,
  options: WebSocketServerOptions = {}
): void {
  const contextFor = options.context ?? ((): Context => SYSTEM_CONTEXT);

  server.on("connection", (socket, request) => {
    // Resolve the (possibly async) per-connection context before wiring anything up; a failure here
    // means we couldn't authenticate the connection, so close it rather than run under a default.
    void Promise.resolve(contextFor(request))
      .then((ctx) => {
        const unsubscribe = adapter.subscribe((event) => {
          socket.send(JSON.stringify({ type: "event", event }));
        }, ctx);

        socket.on("message", (data) => {
          // Never let a malformed frame or a failed send become an unhandled rejection — that would
          // crash the whole process (Node's default) and drop every *other* connection. Contain it.
          void handleMessage(adapter, socket, String(data), ctx).catch(() => {});
        });
        socket.on("close", unsubscribe);
      })
      .catch(() => socket.close());
  });
}

async function handleMessage(
  adapter: BackendAdapter,
  socket: SocketLike,
  data: string,
  ctx: Context
): Promise<void> {
  let message: { type?: string; id?: number; op?: WireRequest };
  try {
    message = JSON.parse(data) as typeof message;
  } catch {
    return; // garbage frame from some client — ignore it, don't take the server down
  }
  if (message.type === "request" && message.op) {
    // `adapter.handle` catches backend errors and returns an error response, so this won't throw for a
    // well-formed request; the outer `.catch` covers a send failure or a structurally invalid `op`.
    const response = await adapter.handle(message.op, ctx);
    socket.send(JSON.stringify({ type: "response", id: message.id, response }));
  }
}
