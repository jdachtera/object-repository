import type {
  MigrationTargeting,
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
import { substituteNode } from "../../repository/mirror.ts";
import { isMigratable, type Migration, type MigrationReport } from "../sql/migrate.ts";
import type { Capabilities, Context, JsonObject, Uuid } from "../../core/types.ts";
import type { QueryPlan } from "../../core/QueryPlan.ts";
import type { Expression } from "../../expressions/Expression.ts";
import { and, inList } from "../../expressions/builders.ts";
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
/** A write held until `persist`, when the row it replaces can be read and authorized. */
interface PendingWrite {
  kind: "save" | "remove";
  model: string;
  record: JsonObject;
  ctx: Context;
  dirty?: readonly string[];
}

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
export class PolicyBackend implements Backend, SchemaAwareBackend, CountingBackend, RawQueryable, MigrationTargeting {
  readonly capabilities: Capabilities;

  /**
   * The legacy SQL-only migration hatch. Schema migration is a deploy-time operation, not a per-request
   * one, so it forwards to the inner store untouched (the portable runner gets there through
   * `migrationTarget`). Attached in the constructor **only when the inner store is migratable**, so
   * `isMigratable(policyBackend)` answers for the stack it actually wraps — a method declared
   * unconditionally that throws inside would make the capability probe report a hatch that isn't
   * there, moving a checkable boolean into a runtime failure.
   */
  migrate?: (migrations: Migration[]) => Promise<MigrationReport>;
  rollback?: (migrations: Migration[], count: number) => Promise<MigrationReport>;

  private pending: PendingWrite[] = [];
  /** Weak, so a server minting a context per request doesn't accumulate them. */
  private readonly contextKeys = new WeakMap<Context, number>();
  private nextContextKey = 0;
  /** Per model, canonical field → the legacy field holding its value (open compatibility windows). */
  private readonly mirrors = new Map<string, Map<string, string>>();

  constructor(
    private readonly inner: Backend,
    private readonly policy: AccessPolicy
  ) {
    this.capabilities = inner.capabilities;
    if (isMigratable(inner)) {
      const migratable = inner;
      this.migrate = (migrations) => migratable.migrate(migrations);
      this.rollback = (migrations, count) => migratable.rollback(migrations, count);
    }
  }

  registerModel(model: string, indexes: IndexSpec[], fields?: FieldSpec[]): void | Promise<void> {
    const mirrors = new Map<string, string>();
    for (const field of fields ?? []) if (field.mirroredBy) mirrors.set(field.name, field.mirroredBy);
    if (mirrors.size) this.mirrors.set(model, mirrors);
    else this.mirrors.delete(model);
    if (isSchemaAware(this.inner)) return this.inner.registerModel(model, indexes, fields);
  }

  /**
   * The context's read filter for `model`, naming fields as the store holds them. A policy written
   * against the canonical half of an open compatibility window would otherwise test the stale copy:
   * after an older build hands a record to someone else, the previous owner could still read it and
   * the new one couldn't.
   */
  private readFilter(model: string, ctx: Context): Expression | null {
    const filter = this.policy.read?.(model, ctx) ?? null;
    const mirrors = this.mirrors.get(model);
    if (!filter || !mirrors) return filter;
    return parse(substituteNode(filter.serialize(), mirrors));
  }

  /**
   * `record` as the write policy should judge it: during an open window the legacy field is the
   * authoritative copy (an older build may have handed the record to someone else through it alone),
   * so each canonical field takes its legacy value — absent where that is — as the read filter does.
   */
  private authoritative(model: string, record: JsonObject): JsonObject {
    const mirrors = this.mirrors.get(model);
    if (!mirrors) return record;
    const view = { ...record };
    for (const [canonical, legacy] of mirrors) {
      if (record[legacy] === undefined) delete view[canonical];
      else view[canonical] = record[legacy]!;
    }
    return view;
  }

  /**
   * Migrations run on the store beneath the policy. Row policy is per-request authorization; applied
   * to a migration it would rewrite only the rows the context can see and journal the migration as
   * applied — a silent partial migration — or hide the migration lease and block every run.
   */
  migrationTarget(): Backend {
    return this.inner;
  }

  /**
   * Forward a raw query to the inner store. The query is opaque, so row-level `read` policy can't be
   * woven into it — the caller owns what it selects. Throws if the inner backend has no raw hatch.
   */
  async raw(query: unknown, ctx: Context): Promise<Record<string, unknown>[]> {
    if (!isRawQueryable(this.inner)) throw new Error("The wrapped backend does not support raw queries.");
    return this.inner.raw(query, ctx);
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

  /**
   * Queue a write. The record as sent is checked now, so a plainly forbidden write fails where it is
   * made; the stored row it would replace is checked at `persist`, which is where the store can be read.
   */
  save(model: string, record: JsonObject, ctx: Context, dirty?: readonly string[]): void {
    this.authorizeWrite(model, record, ctx);
    this.pending.push({ kind: "save", model, record, ctx, dirty });
  }

  remove(model: string, record: JsonObject, ctx: Context): void {
    this.authorizeWrite(model, record, ctx);
    this.pending.push({ kind: "remove", model, record, ctx });
  }

  /**
   * Authorize every queued write against the row it would replace, then forward them all.
   *
   * Checking only the record a client sends is not authorization: over a transport, a client names
   * any uuid it likes, so it could overwrite or delete another tenant's row just by writing a record
   * that claims to be its own. So the stored row behind each uuid must be one this context can see —
   * under the read filter — and may write. A row it can't see is refused, and nothing is forwarded
   * unless every write passes.
   */
  async persist(ctx: Context): Promise<PersistResult> {
    const pending = this.pending;
    this.pending = [];
    await this.authorizeExisting(pending); // refused: the whole batch is dropped, none of it reaches the store
    for (const change of pending) {
      if (change.kind === "save") this.inner.save(change.model, change.record, change.ctx, change.dirty);
      else this.inner.remove(change.model, change.record, change.ctx);
    }
    return this.inner.persist(ctx);
  }

  private async authorizeExisting(pending: PendingWrite[]): Promise<void> {
    // One lookup per (model, context): the rows these uuids name, as the store holds them.
    const groups = new Map<string, PendingWrite[]>();
    for (const change of pending) {
      if (typeof change.record.uuid !== "string" || !change.record.uuid) continue; // a fresh insert
      const key = `${change.model}\0${this.contextKey(change.ctx)}`;
      groups.set(key, [...(groups.get(key) ?? []), change]);
    }
    for (const changes of groups.values()) {
      const { model, ctx } = changes[0]!;
      const uuids = [...new Set(changes.map((change) => String(change.record.uuid)))];
      const byUuid = { model, where: inList("uuid", uuids).serialize(), order: [], paging: { start: 0 } };
      const stored = await this.inner.query(byUuid, ctx);
      if (!stored.length) continue; // none exist yet: all inserts, checked as sent
      const visible = new Set((await this.inner.query(this.rewrite(byUuid, ctx), ctx)).map((row) => String(row.uuid)));
      for (const row of stored) {
        const uuid = String(row.uuid);
        if (!visible.has(uuid)) {
          throw new PolicyError(`Write to "${model}" denied for the current context: record ${JSON.stringify(uuid)} is not visible to it.`);
        }
        this.authorizeWrite(model, row, ctx); // and the row being replaced must be writable, too
      }
    }
  }

  /** Contexts are compared by identity object; the same context queued twice shares one lookup. */
  private contextKey(ctx: Context): number {
    let key = this.contextKeys.get(ctx);
    if (key === undefined) {
      key = this.nextContextKey++;
      this.contextKeys.set(ctx, key);
    }
    return key;
  }

  /** Drop the queued writes here and below — without this, a rolled-back write would commit. */
  discardPending(): void {
    this.pending = [];
    this.inner.discardPending?.();
  }

  changes(listener: ChangeListener, ctx: Context): Unsubscribe {
    return this.inner.changes((event) => {
      const filter = this.readFilter(event.model, ctx);
      if (!filter) return listener(event); // model fully readable → every event passes
      // A `saved` event carries the record, so match it against the read filter. A `removed` event
      // carries only model+uuid — with a read policy in force we can't prove the deleted record was
      // visible to this context, so drop it rather than leak the existence/uuid of another's record.
      if (event.kind === "saved" && event.record && filter.match(event.record)) listener(event);
    }, ctx);
  }

  private rewrite(plan: QueryPlan, ctx: Context): QueryPlan {
    const extra = this.readFilter(plan.model, ctx);
    if (!extra) return plan;
    const where = plan.where.type === "all" ? extra : and(parse(plan.where), extra);
    return { ...plan, where: where.serialize() };
  }

  private authorizeWrite(model: string, record: JsonObject, ctx: Context): void {
    if (this.policy.write && !this.policy.write(model, this.authoritative(model, record), ctx)) {
      throw new PolicyError(`Write to "${model}" denied for the current context.`);
    }
  }
}
