import type {
  Backend,
  ChangeEvent,
  ChangeListener,
  PersistResult,
  PersistedChange,
  Unsubscribe
} from "../core/Backend.ts";
import type { Capabilities, Context, JsonObject, Uuid } from "../core/types.ts";
import type { AggregatePlan, AggregateResultRow, QueryPlan } from "../core/QueryPlan.ts";
import type { Transport, WireResponse } from "../core/Transport.ts";

/**
 * Client side of the transport boundary (ARCHITECTURE.md §10): a `Backend` whose every operation is
 * an RPC to a remote `BackendAdapter` through a `Transport`. Because it satisfies the same `Backend`
 * contract, a `Repository`/`RepositoryManager` can't tell it apart from a local store — that is the
 * whole point of the symmetry.
 *
 * Writes are buffered locally and flushed in one `persist` request (unit of work over the wire);
 * the change feed rides the transport's subscribe channel so cache invalidation still works.
 */
export class RemoteBackend implements Backend {
  readonly capabilities: Capabilities;

  private saves: PersistedChange[] = [];
  private removes: PersistedChange[] = [];
  private readonly listeners = new Set<ChangeListener>();
  private subscription?: Unsubscribe;

  constructor(
    private readonly transport: Transport,
    capabilities: Capabilities
  ) {
    // The client advertises the remote's capabilities (a real deployment would negotiate these on
    // connect); reads come from the remote, so its capabilities are what the planner should see.
    this.capabilities = capabilities;
  }

  /**
   * Verify the server runs the same schema before issuing real requests. Pass the local fingerprint
   * (`manager.fingerprint()`); throws `SchemaMismatchError` if the server's differs — turning silent
   * client/server drift into a clear, immediate failure (ARCHITECTURE.md §4, §10).
   */
  async handshake(fingerprint: string, ctx: Context): Promise<void> {
    const response = await this.transport.request({ method: "handshake", params: { fingerprint } }, ctx);
    if (!response.ok && response.error?.code === "SCHEMA_MISMATCH") {
      throw new SchemaMismatchError(response.error.message);
    }
    expect(response);
  }

  async query(plan: QueryPlan, ctx: Context): Promise<JsonObject[]> {
    const response = await this.transport.request({ method: "query", params: { plan } }, ctx);
    return expect(response) as JsonObject[];
  }

  async queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    const response = await this.transport.request({ method: "queryUuids", params: { plan } }, ctx);
    return expect(response) as Uuid[];
  }

  /**
   * Push a grouped aggregate down across the wire (ARCHITECTURE.md §11): the server reduces
   * (`GROUP BY` / `$group`, or its own reference scan) and returns only the summary rows, so the
   * network carries the result — not the whole table. Implementing this makes `RemoteBackend` an
   * `AggregatingBackend`, so `Repository.runAggregate` picks the push-down path over the transport.
   */
  async aggregate(plan: AggregatePlan, ctx: Context): Promise<AggregateResultRow[]> {
    const response = await this.transport.request({ method: "aggregate", params: { plan } }, ctx);
    return expect(response) as AggregateResultRow[];
  }

  save(model: string, record: JsonObject, _ctx: Context): void {
    this.saves.push({ model, record });
  }

  remove(model: string, record: JsonObject, _ctx: Context): void {
    this.removes.push({ model, record });
  }

  async persist(ctx: Context): Promise<PersistResult> {
    const params = { saves: this.saves, removes: this.removes };
    this.saves = [];
    this.removes = [];
    const response = await this.transport.request({ method: "persist", params }, ctx);
    return expect(response) as PersistResult;
  }

  discardPending(): void {
    this.saves = [];
    this.removes = [];
  }

  changes(listener: ChangeListener, ctx: Context): Unsubscribe {
    this.listeners.add(listener);
    // One shared upstream subscription fans out to every listener; opened lazily, closed when the
    // last listener leaves. Transports without push (plain HTTP) simply never deliver upstream events
    // — but `deliverChanges` (command replies) still reaches the listeners.
    if (!this.subscription && this.transport.subscribe) {
      this.subscription = this.transport.subscribe(
        { method: "changes", params: {} },
        (event) => this.fanout(event as ChangeEvent),
        ctx
      );
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.subscription) {
        this.subscription();
        this.subscription = undefined;
      }
    };
  }

  /**
   * Deliver change events observed out-of-band — e.g. the events a command's writes produced, returned
   * with its reply — to the local listeners, so they invalidate query caches exactly like a
   * live-subscription event would. This is what makes a command-triggered mutation drive the same
   * reactive reloads as a normal write, even over request/response HTTP with no subscription.
   */
  deliverChanges(events: ChangeEvent[]): void {
    for (const event of events) this.fanout(event);
  }

  private fanout(event: ChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Thrown when the server's schema fingerprint doesn't match the client's. */
export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMismatchError";
  }
}

function expect(response: WireResponse): unknown {
  if (!response.ok) {
    const error = response.error;
    throw new Error(error ? `${error.code}: ${error.message}` : "Remote backend request failed");
  }
  return response.result;
}
