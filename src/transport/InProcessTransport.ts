import type { Context } from "../core/types.ts";
import type { Transport, TransportAdapter, WireRequest, WireResponse, WireUnsubscribe } from "../core/Transport.ts";

export interface InProcessTransportOptions {
  /**
   * Round-trip payloads through JSON to actually exercise wire-serializability (default true).
   * Set false for a pure in-memory call with shared references — faster, but won't catch a
   * non-serializable payload that a real network transport would reject.
   */
  serialize?: boolean;
}

/**
 * The simplest transport (ARCHITECTURE.md §10): hands a request straight to a `BackendAdapter` in
 * the same process. With `serialize` on (the default) it JSON round-trips every payload, so the
 * full server-side stack is exercised — and proven wire-safe — with zero network. Swapping this for
 * an HTTP/WS transport turns the same app from embedded into client/server.
 */
export class InProcessTransport implements Transport {
  private readonly serialize: boolean;

  constructor(
    private readonly adapter: TransportAdapter,
    options: InProcessTransportOptions = {}
  ) {
    this.serialize = options.serialize ?? true;
  }

  async request(op: WireRequest, ctx: Context): Promise<WireResponse> {
    const wire = this.roundTrip(op);
    const response = await this.adapter.handle(wire, ctx);
    return this.roundTrip(response);
  }

  subscribe(op: WireRequest, onEvent: (event: unknown) => void, ctx: Context): WireUnsubscribe {
    void this.roundTrip(op);
    if (!this.adapter.subscribe) {
      throw new Error("This transport adapter does not support subscriptions (no change feed).");
    }
    return this.adapter.subscribe((event) => onEvent(this.roundTrip(event)), ctx);
  }

  private roundTrip<T>(value: T): T {
    return this.serialize ? (JSON.parse(JSON.stringify(value)) as T) : value;
  }
}
