import {
  isAggregating,
  type Backend,
  type ChangeEvent,
  type PersistedChange,
  type Unsubscribe
} from "../core/Backend.ts";
import type { Context } from "../core/types.ts";
import type { AggregatePlan, QueryPlan } from "../core/QueryPlan.ts";
import { reduceAggregatePlan } from "../expressions/aggregateReduce.ts";
import type { TransportAdapter, WireRequest, WireResponse } from "../core/Transport.ts";
import { executeCommand, CommandError, type CommandMap, type CommandReply } from "./command.ts";
import { ValidationError } from "../properties/schema.ts";

/**
 * Server side of the transport boundary (ARCHITECTURE.md §10): wraps a real `Backend`, decodes a
 * `WireRequest`, dispatches to the backend, and encodes the result. Writes arrive batched on the
 * `persist` message (the client buffers `save`/`remove` locally and flushes them together), so the
 * boundary is one round-trip per unit of work.
 *
 * Authentication (establishing `ctx`) and authorization (a PolicyBackend below this adapter) live
 * outside it — see §8.
 */
export class BackendAdapter implements TransportAdapter {
  private readonly allowedModels?: ReadonlySet<string>;

  constructor(
    private readonly backend: Backend,
    /** The server's schema fingerprint (`manager.fingerprint()`); enables the drift check on handshake. */
    private readonly schemaFingerprint?: string,
    /** Task-based RPC handlers dispatched on the `command` message (the command plane). */
    private readonly commands?: CommandMap,
    /**
     * Optional allow-list of model names a client may read/write over the wire. When set, any other
     * model is rejected — the recommended defense-in-depth scoping for a public endpoint. Regardless
     * of this, reserved models (names starting with `_`, e.g. the sync `_outbox`) are never reachable.
     */
    allowedModels?: Iterable<string>,
    /**
     * Optional cap on how many rows one `query`/`queryUuids` may return. A remote client can otherwise
     * ask for an unbounded window (`paging.end` omitted) and dump a whole model in one request; when set
     * this clamps the returned window to `start + maxPageSize`. Unset = unbounded (backward-compatible).
     */
    private readonly maxPageSize?: number
  ) {
    this.allowedModels = allowedModels ? new Set(allowedModels) : undefined;
  }

  /** Clamp a returned window to `maxPageSize` so a client can't request an unbounded bulk read. */
  private clamp(plan: QueryPlan): QueryPlan {
    if (this.maxPageSize === undefined) return plan;
    const cap = plan.paging.start + this.maxPageSize;
    const end = plan.paging.end === undefined ? cap : Math.min(plan.paging.end, cap);
    return { ...plan, paging: { ...plan.paging, end } };
  }

  /** Reject reserved (`_`-prefixed) models always, and anything outside the allow-list when one is set. */
  private modelAllowed(model: string): boolean {
    if (model.startsWith("_")) return false;
    return this.allowedModels ? this.allowedModels.has(model) : true;
  }

  async handle(request: WireRequest, ctx: Context): Promise<WireResponse> {
    try {
      switch (request.method) {
        case "handshake": {
          const { fingerprint } = request.params as unknown as { fingerprint: string };
          if (this.schemaFingerprint !== undefined && fingerprint !== this.schemaFingerprint) {
            return err(
              "SCHEMA_MISMATCH",
              `Client schema ${fingerprint} does not match server schema ${this.schemaFingerprint}.`
            );
          }
          return ok({ fingerprint: this.schemaFingerprint ?? null });
        }
        case "query": {
          const { plan } = request.params as unknown as { plan: QueryPlan };
          if (!this.modelAllowed(plan.model)) return err("FORBIDDEN_MODEL", `Model "${plan.model}" is not exposed.`);
          return ok(await this.backend.query(this.clamp(plan), ctx));
        }
        case "queryUuids": {
          const { plan } = request.params as unknown as { plan: QueryPlan };
          if (!this.modelAllowed(plan.model)) return err("FORBIDDEN_MODEL", `Model "${plan.model}" is not exposed.`);
          return ok(await this.backend.queryUuids(this.clamp(plan), ctx));
        }
        case "aggregate": {
          const { plan } = request.params as unknown as { plan: AggregatePlan };
          if (!this.modelAllowed(plan.model)) return err("FORBIDDEN_MODEL", `Model "${plan.model}" is not exposed.`);
          // Reduce next to the data: natively if the store compiles `GROUP BY` / `$group`, else with
          // the shared reference reducer over the filtered rows. Either way only the summary returns.
          if (isAggregating(this.backend)) return ok(await this.backend.aggregate(plan, ctx));
          const rows = await this.backend.query({ model: plan.model, where: plan.where, order: [], paging: { start: 0 } }, ctx);
          return ok(reduceAggregatePlan(plan, rows));
        }
        case "persist": {
          const { saves, removes } = request.params as unknown as {
            saves: PersistedChange[];
            removes: PersistedChange[];
          };
          for (const change of [...saves, ...removes]) {
            if (!this.modelAllowed(change.model)) return err("FORBIDDEN_MODEL", `Model "${change.model}" is not exposed.`);
          }
          for (const change of saves) this.backend.save(change.model, change.record, ctx);
          for (const change of removes) this.backend.remove(change.model, change.record, ctx);
          return ok(await this.backend.persist(ctx));
        }
        case "command":
          return this.command(request.params, ctx);
        default:
          return err("UNSUPPORTED_METHOD", `Adapter cannot handle "${request.method}"`);
      }
    } catch (error) {
      return safeError("BACKEND_ERROR", error);
    }
  }

  /**
   * Run a command, capturing the change events its writes emit so the client can invalidate the same
   * caches a normal write would (and drive reactive reloads even without a live subscription). Over-
   * capture is safe — a client just refreshes a few extra queries — so a shared change feed is fine.
   */
  private async command(params: unknown, ctx: Context): Promise<WireResponse> {
    if (!this.commands) return err("UNSUPPORTED_METHOD", "This adapter has no commands registered.");
    const { name, input } = (params ?? {}) as { name?: unknown; input?: unknown };
    const changes: ChangeEvent[] = [];
    const unsubscribe = this.backend.changes((event) => changes.push(event), ctx);
    try {
      const value = await executeCommand(this.commands, name, input, ctx);
      return ok({ value, changes } satisfies CommandReply);
    } catch (error) {
      if (error instanceof CommandError) return err(error.code, error.message);
      return safeError("COMMAND_ERROR", error);
    } finally {
      unsubscribe();
    }
  }

  /** Forward the backend's change feed to a transport subscriber (server→client push, §7). */
  subscribe(onEvent: (event: ChangeEvent) => void, ctx: Context): Unsubscribe {
    return this.backend.changes(onEvent, ctx);
  }
}

function ok(result: unknown): WireResponse {
  return { ok: true, result: result as WireResponse["result"] };
}

function err(code: string, message: string): WireResponse {
  return { ok: false, error: { code, message } };
}

/**
 * Map a thrown error to a wire error without leaking backend internals. A `ValidationError` is client
 * input feedback (safe and useful to surface); everything else — SQL/Mongo driver errors, connection
 * failures, constraint messages naming columns — is collapsed to a generic message so it can't reveal
 * schema or infrastructure. The full error should be logged server-side by the caller.
 */
function safeError(code: string, error: unknown): WireResponse {
  if (error instanceof ValidationError) return err(code, error.message);
  return err(code, "An internal error occurred.");
}
