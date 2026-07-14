/**
 * Observability as a composable, capability-preserving backend decorator (ARCHITECTURE.md §2–3).
 *
 * `observe(backend, options)` wraps any backend so every asynchronous operation it performs — reads,
 * counts, aggregates, the persist flush, patches/upserts, raw queries, transactions, migrations —
 * reports its duration and outcome to `onOperation` (and to `onSlowQuery` when it crosses a
 * threshold). It is the tracing companion to `PolicyBackend`/`HooksBackend`: drop it anywhere in the
 * stack and it observes exactly the operations that cross that seam.
 *
 * Unlike a fixed decorator class, this **mirrors the inner backend's capabilities exactly** — it only
 * exposes `count`/`aggregate`/`patch`/`upsert`/`raw`/`transaction`/`migrate` when the inner does, so
 * wrapping never downgrades push-down (the `isCounting`/`isAggregating`/… probes still see the truth).
 * Synchronous queue ops (`save`/`remove`) and the change feed pass straight through untimed; the write
 * cost surfaces on `persist`.
 */
import type {
  AggregatingBackend,
  Backend,
  CountingBackend,
  IndexSpec,
  MultiPatchingBackend,
  PatchOp,
  PatchingBackend,
  PersistResult,
  RawQueryable,
  SchemaAwareBackend,
  TransactionalBackend,
  UpsertingBackend
} from "../../core/Backend.ts";
import {
  isAggregating,
  isCounting,
  isMultiPatching,
  isPatching,
  isRawQueryable,
  isSchemaAware,
  isTransactional,
  isUpserting
} from "../../core/Backend.ts";
import { isMigratable, type MigratableBackend, type Migration } from "../sql/migrate.ts";
import type { Context, JsonObject, Uuid } from "../../core/types.ts";
import type { AggregatePlan, ExpressionNode, QueryPlan } from "../../core/QueryPlan.ts";

/** The backend operation an `OperationEvent` describes. */
export type Operation =
  | "query"
  | "queryUuids"
  | "count"
  | "aggregate"
  | "persist"
  | "patch"
  | "patchMany"
  | "upsert"
  | "raw"
  | "transaction"
  | "migrate"
  | "rollback";

/** One observed operation: what ran, how long it took, and whether it succeeded. */
export interface OperationEvent {
  operation: Operation;
  /** The model touched, when the operation names one (absent for `raw`/`transaction`). */
  model?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** False if the operation threw (the error is then in `error`, and it is re-thrown). */
  ok: boolean;
  error?: unknown;
  /** A rough result magnitude: row count for reads, changed-record count for `persist`, etc. */
  rows?: number;
}

export interface ObservabilityOptions {
  /** Called after every instrumented operation (success or failure). */
  onOperation?(event: OperationEvent): void;
  /** Operations at or beyond this many milliseconds also fire `onSlowQuery`. */
  slowThresholdMs?: number;
  /** Called for operations that reach `slowThresholdMs` (in addition to `onOperation`). */
  onSlowQuery?(event: OperationEvent): void;
  /** Monotonic clock in ms; injected for tests. Defaults to `performance.now()` when available. */
  now?(): number;
}

const defaultNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/** Wrap `backend`, reporting the timing/outcome of every async operation, preserving its capabilities. */
export function observe(backend: Backend, options: ObservabilityOptions = {}): Backend {
  const now = options.now ?? defaultNow;

  const report = (operation: Operation, model: string | undefined, start: number, ok: boolean, rows?: number, error?: unknown): void => {
    const event: OperationEvent = { operation, model, durationMs: now() - start, ok, rows, error };
    options.onOperation?.(event);
    if (options.slowThresholdMs !== undefined && event.durationMs >= options.slowThresholdMs) {
      options.onSlowQuery?.(event);
    }
  };

  /** Time an async operation, emit its event (with a derived row count), and re-throw on failure. */
  const timed = async <T>(operation: Operation, model: string | undefined, rowsOf: (result: T) => number | undefined, run: () => Promise<T>): Promise<T> => {
    const start = now();
    try {
      const result = await run();
      report(operation, model, start, true, rowsOf(result));
      return result;
    } catch (error) {
      report(operation, model, start, false, undefined, error);
      throw error;
    }
  };

  const len = (value: unknown): number | undefined => (Array.isArray(value) ? value.length : undefined);

  // Core surface — always present.
  const wrapped: Backend & Partial<
    CountingBackend & AggregatingBackend & PatchingBackend & MultiPatchingBackend & UpsertingBackend & RawQueryable & TransactionalBackend & MigratableBackend & SchemaAwareBackend
  > = {
    capabilities: backend.capabilities,
    query: (plan, ctx) => timed("query", plan.model, len, () => backend.query(plan, ctx)),
    queryUuids: (plan, ctx) => timed("queryUuids", plan.model, len, () => backend.queryUuids(plan, ctx)),
    save: (model, record, ctx, dirty) => backend.save(model, record, ctx, dirty),
    remove: (model, record, ctx) => backend.remove(model, record, ctx),
    persist: (ctx) => timed("persist", undefined, (r: PersistResult) => r.saved.length + r.removed.length, () => backend.persist(ctx)),
    changes: (listener, ctx) => backend.changes(listener, ctx)
  };

  if (backend.discardPending) wrapped.discardPending = () => backend.discardPending!();

  // Optional capabilities: expose each only when the inner backend has it, so push-down is preserved.
  if (isSchemaAware(backend)) {
    const inner = backend;
    wrapped.registerModel = (model: string, indexes: IndexSpec[], fields) => inner.registerModel(model, indexes, fields);
  }
  if (isCounting(backend)) {
    const inner = backend;
    wrapped.count = (plan: QueryPlan, ctx: Context) => timed("count", plan.model, (n: number) => n, () => inner.count(plan, ctx));
  }
  if (isAggregating(backend)) {
    const inner = backend;
    wrapped.aggregate = (plan: AggregatePlan, ctx: Context) => timed("aggregate", plan.model, len, () => inner.aggregate(plan, ctx));
  }
  if (isPatching(backend)) {
    const inner = backend;
    wrapped.patch = (model: string, uuid: Uuid, ops: Record<string, PatchOp>, ctx: Context) =>
      timed("patch", model, () => undefined, () => inner.patch(model, uuid, ops, ctx));
  }
  if (isMultiPatching(backend)) {
    const inner = backend;
    wrapped.patchMany = (model: string, where: ExpressionNode, ops: Record<string, PatchOp>, ctx: Context) =>
      timed("patchMany", model, (n: number) => n, () => inner.patchMany(model, where, ops, ctx));
  }
  if (isUpserting(backend)) {
    const inner = backend;
    wrapped.upsert = (model: string, where: ExpressionNode, set: JsonObject, setOnInsert: JsonObject, ctx: Context) =>
      timed("upsert", model, () => undefined, () => inner.upsert(model, where, set, setOnInsert, ctx));
  }
  if (isRawQueryable(backend)) {
    const inner = backend;
    wrapped.raw = (query: unknown, ctx: Context) => timed("raw", undefined, len, () => inner.raw(query, ctx));
  }
  if (isTransactional(backend)) {
    const inner = backend;
    wrapped.transaction = <T>(fn: (tx: Backend) => Promise<T>, ctx: Context) =>
      timed("transaction", undefined, () => undefined, () => inner.transaction(fn, ctx));
  }
  if (isMigratable(backend)) {
    const inner = backend;
    wrapped.migrate = (migrations: Migration[]) => timed("migrate", undefined, (r) => r.applied.length, () => inner.migrate(migrations));
    wrapped.rollback = (migrations: Migration[], count: number) =>
      timed("rollback", undefined, (r) => r.applied.length, () => inner.rollback(migrations, count));
  }

  return wrapped;
}
