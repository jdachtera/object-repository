/**
 * Fan-out (dual-write) backend — the runtime half of a zero-downtime store migration.
 *
 * `multiWriteBackend({ primary, secondaries })` reads from `primary` but applies every write to
 * `primary` *and* each secondary. Point your app at it during a cutover so live traffic keeps the new
 * store in lock-step with the old one while `copyBackend` backfills the history; once the secondary is
 * verified, flip `primary` to it (and optionally drop the old one). It's a composable decorator like
 * `observe`/`PolicyBackend`: it mirrors the *primary's* read capabilities (count/aggregate/raw come
 * from primary), and exposes a fan-out write capability (patch/patchMany/upsert) only when *every*
 * backend supports it, so a fanned write is always consistent across stores.
 *
 * Consistency model: this is not a two-phase commit. `persist` flushes the primary first (the source
 * of truth for reads and the change feed), then each secondary. Under the default `"strict"` policy a
 * failing secondary rejects the operation — but the primary has already committed, so a secondary can
 * lag; re-run `copyBackend` (or a custom `onSecondaryError`) to reconcile. Interactive transactions
 * are intentionally not exposed (no cross-store 2PC); the manager falls back to write-batching, which
 * still fans out. Schema/DDL (`migrate`) and the raw escape hatch are per-store concerns — `raw` is
 * served by the primary only; provision each store through its own manager.
 */
import type {
  AggregatingBackend,
  Backend,
  CountingBackend,
  FieldSpec,
  IndexSpec,
  MultiPatchingBackend,
  PatchOp,
  PatchingBackend,
  PersistResult,
  RawQueryable,
  SchemaAwareBackend,
  UpsertingBackend
} from "../../core/Backend.ts";
import { isAggregating, isCounting, isMultiPatching, isPatching, isRawQueryable, isSchemaAware, isUpserting } from "../../core/Backend.ts";
import type { Context, JsonObject, Uuid } from "../../core/types.ts";
import type { AggregatePlan, ExpressionNode } from "../../core/QueryPlan.ts";
import { generateUuid } from "../../core/uuid.ts";

/** Called for a secondary write that failed, when the policy isn't `"strict"`. */
export type SecondaryErrorHandler = (error: unknown, backend: Backend) => void;

export interface MultiWriteOptions {
  /** Reads, the change feed, and `raw` are served from here; writes go here first. */
  primary: Backend;
  /** Every write is also applied to these, in order, after the primary. */
  secondaries: Backend[];
  /**
   * How to treat a secondary write that throws. `"strict"` (default) re-throws, failing the operation
   * (the primary has already committed). A function is called per failure and the fan-out continues —
   * use it to log-and-tolerate a lagging secondary during a migration.
   */
  onSecondaryError?: "strict" | SecondaryErrorHandler;
}

/**
 * Build a dual-write backend over a `primary` and one or more `secondaries`. See the module doc for the
 * consistency model. Returns a plain `Backend` (plus the optional capabilities the set jointly supports).
 */
export function multiWriteBackend(options: MultiWriteOptions): Backend {
  const primary = options.primary;
  const secondaries = options.secondaries;
  const targets = [primary, ...secondaries];
  const strict = options.onSecondaryError === undefined || options.onSecondaryError === "strict";
  const onError = typeof options.onSecondaryError === "function" ? options.onSecondaryError : undefined;

  // Apply `run` to every secondary in order, honouring the error policy.
  const fanSecondary = async (run: (backend: Backend) => Promise<unknown>): Promise<void> => {
    for (const backend of secondaries) {
      try {
        await run(backend);
      } catch (error) {
        if (strict) throw error;
        onError?.(error, backend);
      }
    }
  };

  const wrapped: Backend &
    Partial<CountingBackend & AggregatingBackend & PatchingBackend & MultiPatchingBackend & UpsertingBackend & RawQueryable & SchemaAwareBackend> = {
    // Reads mirror the primary; `transactions` is off — cross-store 2PC isn't offered.
    capabilities: { ...primary.capabilities, transactions: false },
    query: (plan, ctx) => primary.query(plan, ctx),
    queryUuids: (plan, ctx) => primary.queryUuids(plan, ctx),

    save: (model, record, ctx, dirty) => {
      // Fix the uuid once, up front, so every store keys the row identically; hand each backend its
      // own shallow copy so one store's in-place stamping (e.g. a sync version) can't leak to another.
      // Every target gets the same `dirty` hint, so a scoped write on one store never diverges from
      // a full write on another.
      if (typeof record.uuid !== "string" || record.uuid.length === 0) record.uuid = generateUuid();
      for (const backend of targets) backend.save(model, { ...record }, ctx, dirty);
    },
    remove: (model, record, ctx) => {
      for (const backend of targets) backend.remove(model, { ...record }, ctx);
    },
    persist: async (ctx): Promise<PersistResult> => {
      const result = await primary.persist(ctx); // source of truth for the change feed
      await fanSecondary((backend) => backend.persist(ctx));
      return result;
    },

    // The change feed comes from the primary only — no double-emits from the secondaries.
    changes: (listener, ctx) => primary.changes(listener, ctx)
  };

  // Roll back a buffered unit of work across every store that batches one.
  if (targets.some((backend) => backend.discardPending)) {
    wrapped.discardPending = () => {
      for (const backend of targets) backend.discardPending?.();
    };
  }

  // Provision every schema-aware store (so a fresh secondary gets the tables/indexes before backfill).
  if (targets.some(isSchemaAware)) {
    wrapped.registerModel = (model: string, indexes: IndexSpec[], fields?: FieldSpec[]) => {
      const pending: Array<void | Promise<void>> = [];
      for (const backend of targets) if (isSchemaAware(backend)) pending.push(backend.registerModel(model, indexes, fields));
      return Promise.all(pending).then(() => undefined);
    };
  }

  // Read capabilities follow the primary (that's where reads resolve).
  if (isCounting(primary)) {
    const p = primary;
    wrapped.count = (plan, ctx) => p.count(plan, ctx);
  }
  if (isAggregating(primary)) {
    const p = primary;
    wrapped.aggregate = (plan: AggregatePlan, ctx: Context) => p.aggregate(plan, ctx);
  }
  if (isRawQueryable(primary)) {
    const p = primary;
    // Opaque, backend-native — can't be fanned to a differently-shaped secondary; primary serves it.
    wrapped.raw = (query: unknown, ctx: Context) => p.raw(query, ctx);
  }

  // Write capabilities fan out — expose each only when *all* stores support it, so a fanned write can
  // never leave one store patched and another untouched (the Repository otherwise falls back to
  // save/remove, which already fan).
  // `every(isPatching)` guarantees every store has the method at runtime, but the guard's type doesn't
  // extend `Backend`, so it can't narrow the array — the `as` casts below are sound under that check.
  if (targets.every(isPatching)) {
    wrapped.patch = async (model: string, uuid: Uuid, ops: Record<string, PatchOp>, ctx: Context) => {
      await (primary as unknown as PatchingBackend).patch(model, uuid, ops, ctx);
      await fanSecondary((backend) => (backend as unknown as PatchingBackend).patch(model, uuid, ops, ctx));
    };
  }
  if (targets.every(isMultiPatching)) {
    wrapped.patchMany = async (model: string, where: ExpressionNode, ops: Record<string, PatchOp>, ctx: Context) => {
      const modified = await (primary as unknown as MultiPatchingBackend).patchMany(model, where, ops, ctx);
      await fanSecondary((backend) => (backend as unknown as MultiPatchingBackend).patchMany(model, where, ops, ctx));
      return modified; // the primary's count is authoritative
    };
  }
  if (targets.every(isUpserting)) {
    wrapped.upsert = async (model: string, where: ExpressionNode, set: JsonObject, setOnInsert: JsonObject, ctx: Context) => {
      await (primary as unknown as UpsertingBackend).upsert(model, where, set, setOnInsert, ctx);
      await fanSecondary((backend) => (backend as unknown as UpsertingBackend).upsert(model, where, set, setOnInsert, ctx));
    };
  }

  return wrapped;
}
