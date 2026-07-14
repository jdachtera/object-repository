import type { Context } from "../../core/types.ts";
import type { Transport, WireRequest, WireResponse, WireUnsubscribe } from "../../core/Transport.ts";

/** Minimal browser-style WebSocket surface, so the transport works with the global or `ws`. */
interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}
type WebSocketCtor = new (url: string) => WebSocketLike;

const OPEN = 1;

export interface WebSocketTransportOptions {
  /** WebSocket constructor (defaults to the global; inject `ws` in Node tests). */
  WebSocket?: WebSocketCtor;
}

interface ResponseMessage {
  type: "response";
  id: number;
  response: WireResponse;
}
interface EventMessage {
  type: "event";
  event: unknown;
}

/**
 * WebSocket client transport (ARCHITECTURE.md §10): a duplex alternative to the HTTP+SSE transport
 * implementing the same `Transport` contract. Request/response messages are correlated by id over
 * the single connection; server-pushed `event` messages drive the change feed. Lazily connects on
 * first use and works with the global `WebSocket` (browser, Node ≥ 22) or an injected one.
 */
export class WebSocketTransport implements Transport {
  private socket: WebSocketLike | null = null;
  private connecting: Promise<WebSocketLike> | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (response: WireResponse) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(
    private readonly url: string,
    private readonly options: WebSocketTransportOptions = {}
  ) {}

  async request(op: WireRequest, _ctx: Context): Promise<WireResponse> {
    const socket = await this.connect();
    const id = this.nextId++;
    return new Promise<WireResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "request", id, op }));
    });
  }

  /** Reject every in-flight request — the socket closed or errored, so their replies will never come. */
  private failAllPending(reason: string): void {
    if (this.pending.size === 0) return;
    const error = new Error(reason);
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiters) reject(error);
  }

  subscribe(_op: WireRequest, onEvent: (event: unknown) => void, _ctx: Context): WireUnsubscribe {
    this.listeners.add(onEvent);
    void this.connect(); // ensure the connection is open so the server starts pushing events
    return () => {
      this.listeners.delete(onEvent);
    };
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connecting = null;
    this.failAllPending("WebSocket transport closed");
  }

  private connect(): Promise<WebSocketLike> {
    if (this.socket && this.socket.readyState === OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    const Ctor = this.options.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new Error("No WebSocket implementation available; pass options.WebSocket.");

    this.connecting = new Promise<WebSocketLike>((resolve, reject) => {
      const socket = new Ctor(this.url);
      socket.addEventListener("open", () => {
        this.socket = socket;
        resolve(socket);
      });
      socket.addEventListener("error", () => {
        reject(new Error("WebSocket connection failed"));
        this.failAllPending("WebSocket connection error");
      });
      socket.addEventListener("message", (event) => this.handleMessage(String(event.data ?? "")));
      socket.addEventListener("close", () => {
        this.socket = null;
        this.connecting = null;
        this.failAllPending("WebSocket connection closed");
      });
    });
    return this.connecting;
  }

  private handleMessage(data: string): void {
    let message: ResponseMessage | EventMessage;
    try {
      message = JSON.parse(data) as ResponseMessage | EventMessage;
    } catch {
      return; // a malformed server frame must not throw out of the socket's message handler
    }
    if (message.type === "response") {
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        entry.resolve(message.response);
      }
    } else if (message.type === "event") {
      for (const listener of this.listeners) listener(message.event);
    }
  }
}
