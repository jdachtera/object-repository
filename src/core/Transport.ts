import type { Context } from "./types.ts";

/**
 * Transport-as-backend boundary (ARCHITECTURE.md §10).
 *
 * The `Backend` contract is serializable, so it doubles as the network protocol. A transport
 * carries a serialized backend operation across a process boundary and returns the response.
 * The same backend stack runs:
 *
 *   - embedded            → `InProcessTransport` (direct call, no serialization, fully testable)
 *   - client/server       → `HttpTransport`      (request/response: query/save/pull/push)
 *   - with live updates   → `WsTransport`/SSE     (the server→client `changes()` feed)
 *
 * Swapping embedded ↔ client/server is a transport choice, not a rewrite.
 */
export interface Transport {
  /** Send one request/response operation and await the serialized reply. */
  request(op: WireRequest, ctx: Context): Promise<WireResponse>;

  /**
   * Open a server→client stream for the change feed. Transports without push semantics
   * (plain HTTP) leave this undefined; WebSocket/SSE transports implement it.
   */
  subscribe?(op: WireRequest, onEvent: (event: unknown) => void, ctx: Context): WireUnsubscribe;
}

/** The backend methods that travel over the wire, tagged for dispatch on the server adapter. */
export type WireMethod =
  | "handshake"
  | "query"
  | "queryUuids"
  | "aggregate"
  | "save"
  | "remove"
  | "persist"
  | "changes"
  | "command"
  | "pull"
  | "push";

export interface WireRequest {
  method: WireMethod;
  /**
   * Method arguments (e.g. a serialized QueryPlan). Typed `unknown` rather than `JsonValue`: the
   * payload must be JSON-serializable, but that is a runtime contract the transport enforces (the
   * in-process transport JSON round-trips it) — `JsonValue` at compile time fights every named
   * interface and forces casts at each boundary.
   */
  params: unknown;
}

export interface WireResponse {
  ok: boolean;
  /** Present when `ok`; the return value (JSON-serializable; see `WireRequest.params`). */
  result?: unknown;
  /** Present when `!ok`; a transport/authz/store error description. */
  error?: WireError;
}

export interface WireError {
  code: string;
  message: string;
}

export type WireUnsubscribe = () => void;

/**
 * Server-side counterpart: receives a deserialized `WireRequest`, applies authentication,
 * and dispatches to the wrapped backend. Authorization lives separately in a PolicyBackend
 * decorator below the adapter, not here (ARCHITECTURE.md §8).
 */
export interface TransportAdapter {
  handle(request: WireRequest, ctx: Context): Promise<WireResponse>;
  /**
   * Optional server→client stream for the change feed. A backend adapter implements it; a plain
   * request/response adapter (e.g. one fronting a `SyncTarget`, which is pull/push only) leaves it
   * undefined, and transports that need it check for its presence.
   */
  subscribe?(onEvent: (event: unknown) => void, ctx: Context): WireUnsubscribe;
}
