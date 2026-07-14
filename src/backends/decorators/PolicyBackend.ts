import type {
  Backend,
  ChangeListener,
  CountingBackend,
  FieldSpec,
  IndexSpec,
  PersistResult,
  RawQueryable,
  SchemaAwareBackend,
  Unsubscribe
} from "../../core/Backend.ts";
import { isCounting, isRawQueryable, isSchemaAware } from "../../core/Backend.ts";
import { isMigratable, type MigratableBackend, type Migration, type MigrationReport } from "../sql/migrate.ts";
import type { Capabilities, Context, JsonObject, Uuid } from "../../core/types.ts";
import type { QueryPlan } from "../../core/QueryPlan.ts";
import type { Expression } from "../../expressions/Expression.ts";
import { and } from "../../expressions/builders.ts";
import { parse } from "../../expressions/parse.ts";

/** Thrown when a write is denied by the access policy. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Per-context access rules (ARCHITECTURE.md §8).
 *
 * `read` returns an expression AND-ed into every query for a model (row-level security via query
 * rewriting — the same mechanism as relation preprocessing). `write` authorizes a save/remove.
 * Both receive the ambient `Context` established by a transport adapter.
 */
export interface AccessPolicy {
  /** Extra filter for reads of `model`; `null` means unrestricted. */
  read?(model: string, ctx: Context): Expression | null;
  /** Return false (or throw) to deny a write of `record` to `model`. */
  write?(model: string, record: JsonObject, ctx: Context): boolean;
}

/**
 * Authorization as a composable backend decorator (ARCHITECTURE.md §8).
 *
 * Wraps any backend and enforces policy by **rewriting the query AST** (injecting a row-level
 * filter) and **gating writes** — not by special-casing the transport. The same rules therefore
 * apply over every transport and in-process. Authentication (establishing `ctx`) happens above, in
 * the adapter; this layer is pure authorization.
 *
 * The read filter is also applied to the change feed: `saved` events whose record the context
 * can't see are not forwarded (preventing cross-tenant leakage). `removed` events carry no record
 * and pass through.
 */
export class PolicyBackend implements Backend, SchemaAwareBackend, CountingBackend, RawQueryable, MigratableBackend {
  readonly capabilities: Capabilities;

  constructor(
    private readonly inner: Backend,
    private readonly policy: AccessPolicy
  ) {
    this.capabilities = inner.capabilities;
  }

  registerModel(model: string, indexes: IndexSpec[], fields?: FieldSpec[]): void | Promise<void> {
    if (isSchemaAware(this.inner)) return this.inner.registerModel(model, indexes, fields);
  }

  /**
   * Forward a raw query to the inner store. The query is opaque, so row-level `read` policy can't be
   * woven into it — the caller owns what it selects. Throws if the inner backend has no raw hatch.
   */
  async raw(query: unknown, ctx: Context): Promise<Record<string, unknown>[]> {
    if (!isRawQueryable(this.inner)) throw new Error("The wrapped backend does not support raw queries.");
    return this.inner.raw(query, ctx);
  }

  /** Schema migration is a deploy-time operation, not a per-request one — forward it to the inner store. */
  migrate(migrations: Migration[]): Promise<MigrationReport> {
    if (!isMigratable(this.inner)) throw new Error("The wrapped backend does not support migrations.");
    return this.inner.migrate(migrations);
  }

  rollback(migrations: Migration[], count: number): Promise<MigrationReport> {
    if (!isMigratable(this.inner)) throw new Error("The wrapped backend does not support migrations.");
    return this.inner.rollback(migrations, count);
  }

  query(plan: QueryPlan, ctx: Context): Promise<JsonObject[]> {
    return this.inner.query(this.rewrite(plan, ctx), ctx);
  }

  queryUuids(plan: QueryPlan, ctx: Context): Promise<Uuid[]> {
    return this.inner.queryUuids(this.rewrite(plan, ctx), ctx);
  }

  // Count push-down survives the policy: rewrite first, then count natively if the inner store can.
  async count(plan: QueryPlan, ctx: Context): Promise<number> {
    const rewritten = this.rewrite(plan, ctx);
    if (isCounting(this.inner)) return this.inner.count(rewritten, ctx);
    return (await this.inner.query(rewritten, ctx)).length;
  }

  save(model: string, record: JsonObject, ctx: Context, dirty?: readonly string[]): void {
    this.authorizeWrite(model, record, ctx);
    this.inner.save(model, record, ctx, dirty);
  }

  remove(model: string, record: JsonObject, ctx: Context): void {
    this.authorizeWrite(model, record, ctx);
    this.inner.remove(model, record, ctx);
  }

  persist(ctx: Context): Promise<PersistResult> {
    return this.inner.persist(ctx);
  }

  /** Forward transaction rollback to the inner queue — without this, a rolled-back write would commit. */
  discardPending(): void {
    this.inner.discardPending?.();
  }

  changes(listener: ChangeListener, ctx: Context): Unsubscribe {
    return this.inner.changes((event) => {
      const filter = this.policy.read?.(event.model, ctx) ?? null;
      if (!filter) return listener(event); // model fully readable → every event passes
      // A `saved` event carries the record, so match it against the read filter. A `removed` event
      // carries only model+uuid — with a read policy in force we can't prove the deleted record was
      // visible to this context, so drop it rather than leak the existence/uuid of another's record.
      if (event.kind === "saved" && event.record && filter.match(event.record)) listener(event);
    }, ctx);
  }

  private rewrite(plan: QueryPlan, ctx: Context): QueryPlan {
    const extra = this.policy.read?.(plan.model, ctx) ?? null;
    if (!extra) return plan;
    const where = plan.where.type === "all" ? extra : and(parse(plan.where), extra);
    return { ...plan, where: where.serialize() };
  }

  private authorizeWrite(model: string, record: JsonObject, ctx: Context): void {
    if (this.policy.write && !this.policy.write(model, record, ctx)) {
      throw new PolicyError(`Write to "${model}" denied for the current context.`);
    }
  }
}
