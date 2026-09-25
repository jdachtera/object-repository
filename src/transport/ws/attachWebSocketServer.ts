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
  on(event: "error", listener: (error: unknown) => void): void;
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
    // A socket emits `error` for a malformed frame or a broken connection, and an `error` event with no
    // listener is thrown — one bad client would crash the process and drop every other connection.
    socket.on("error", () => socket.close());

    // Listen from the start: frames that arrive while an async `context()` is still resolving are
    // held and answered once it has, rather than silently dropped (which left that client hanging).
    let ctx: Context | null = null;
    let closed = false;
    const early: string[] = [];
    let unsubscribe: (() => void) | null = null;
    // The change feed starts once the subscriber is admitted: at once when the server needs no schema
    // advertisement, else on a `subscribe` message carrying one it accepts.
    const admit = (schema: WireRequest["schema"], resolved: Context): boolean => {
      if (unsubscribe) return true;
      const refusal = adapter.admitSubscriber?.(schema) ?? null;
      if (refusal) return false;
      unsubscribe = adapter.subscribe((event) => {
        socket.send(JSON.stringify({ type: "event", event }));
      }, resolved);
      return true;
    };
    const receive = (data: string, resolved: Context): void => {
      const subscribe = subscribeMessage(data);
      if (subscribe) {
        if (!admit(subscribe.schema, resolved)) {
          const error = adapter.admitSubscriber?.(subscribe.schema);
          socket.send(JSON.stringify({ type: "error", error }));
        }
        return;
      }
      // Never let a malformed frame or a failed send become an unhandled rejection. Contain it.
      void handleMessage(adapter, socket, data, resolved).catch(() => {});
    };
    socket.on("message", (data) => {
      if (ctx) receive(String(data), ctx);
      else early.push(String(data));
    });
    socket.on("close", () => {
      closed = true;
      unsubscribe?.();
    });

    // Resolve the (possibly async) per-connection context before serving anything; a failure means
    // the connection couldn't be authenticated, so close it rather than run under a default.
    void Promise.resolve()
      .then(() => contextFor(request))
      .then((resolved) => {
        if (closed) return; // gone during authentication: subscribing now would leak the subscription
        ctx = resolved;
        admit(undefined, resolved);
        for (const data of early.splice(0)) receive(data, resolved);
      })
      .catch(() => socket.close());
  });
}

/** A `{ type: "subscribe", schema }` frame, or `null` for anything else. */
function subscribeMessage(data: string): { schema: WireRequest["schema"] } | null {
  try {
    const message = JSON.parse(data) as { type?: string; schema?: WireRequest["schema"] };
    return message?.type === "subscribe" ? { schema: message.schema } : null;
  } catch {
    return null;
  }
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
