import type {
  Backend,
  ChangeListener,
  CountingBackend,
  IndexSpec,
  PersistResult,
  SchemaAwareBackend,
  Unsubscribe
} from "../../core/Backend.ts";
import { isCounting, isSchemaAware } from "../../core/Backend.ts";
import type { Capabilities, Context, JsonObject, Uuid } from "../../core/types.ts";
import type { QueryPlan } from "../../core/QueryPlan.ts";

/**
 * Lifecycle hooks for the write path. `before*` run when a write is queued (`save`/`remove`) — mutate
 * the record in place to derive fields, or throw to enforce an invariant. `after*` run once the write
 * is durable (after `persist`), for side effects (emit an event, cascade, write an audit row).
 *
 * Records are the stored JSON form (below the Repository's encode/decode), and each handler receives
 * the model name so one set of hooks can dispatch across models.
 */
export interface Hooks {
  beforeSave?(model: string, record: JsonObject, ctx: Context): void;
  afterSave?(model: string, record: JsonObject, ctx: Context): void;
  beforeRemove?(model: string, record: JsonObject, ctx: Context): void;
  afterRemove?(model: string, record: JsonObject, ctx: Context): void;
}

/**
 * Business logic as a composable backend decorator — the non-portable companion to computed value
 * expressions (which express portable work *in* the AST). Where portable work pushes down to the
 * store, hooks are arbitrary code that runs wherever this decorator sits in the stack: place it on
 * the server side of a transport and the logic runs server-side, exactly like `PolicyBackend`.
 *
 * Reads pass straight through. Writes get `beforeSave`/`beforeRemove` at queue time and
 * `afterSave`/`afterRemove` after `persist` resolves (driven by the `PersistResult`).
 *
 * Hooks fire on the `save`/`remove` unit-of-work path. A `patch` against an inner store that doesn't
 * expose native patching falls back to read-modify-write through this decorator, so its hooks fire
 * too; a natively-pushed `patch` (when this wraps a patching store directly) bypasses them.
 */
export class HooksBackend implements Backend, SchemaAwareBackend, CountingBackend {
  readonly capabilities: Capabilities;

  constructor(
    private readonly inner: Backend,
    private readonly hooks: Hooks
  ) {
    this.capabilities = inner.capabilities;
  }

  registerModel(model: string, indexes: IndexSpec[]): void {
    if (isSchemaAware(this.inner)) this.inner.registerModel(model, indexes);
  }

  query(plan: QueryPlan, ctx: Context): Promise<JsonObject[]> {
    return this.inner.query(plan, ctx);
  }

  queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    return this.inner.queryUuids(plan, ctx);
  }

  // Count push-down survives the decorator (read path is untouched).
  async count(plan: QueryPlan, ctx: Context): Promise<number> {
    if (isCounting(this.inner)) return this.inner.count(plan, ctx);
    return (await this.inner.query(plan, ctx)).length;
  }

  save(model: string, record: JsonObject, ctx: Context, dirty?: readonly string[]): void {
    this.hooks.beforeSave?.(model, record, ctx);
    this.inner.save(model, record, ctx, dirty);
  }

  remove(model: string, record: JsonObject, ctx: Context): void {
    this.hooks.beforeRemove?.(model, record, ctx);
    this.inner.remove(model, record, ctx);
  }

  async persist(ctx: Context): Promise<PersistResult> {
    const result = await this.inner.persist(ctx);
    if (this.hooks.afterSave) for (const change of result.saved) this.hooks.afterSave(change.model, change.record, ctx);
    if (this.hooks.afterRemove) for (const change of result.removed) this.hooks.afterRemove(change.model, change.record, ctx);
    return result;
  }

  /** Forward transaction rollback to the inner queue — without this, a rolled-back write would commit. */
  discardPending(): void {
    this.inner.discardPending?.();
  }

  changes(listener: ChangeListener, ctx: Context): Unsubscribe {
    return this.inner.changes(listener, ctx);
  }
}
