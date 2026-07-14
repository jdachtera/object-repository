import type { JsonObject } from "../core/types.ts";
import type { ExpressionNode } from "../core/QueryPlan.ts";
import type { ExpressionVisitor } from "./visitor.ts";

/**
 * A node in the query filter AST (ARCHITECTURE.md §3–4).
 *
 * Every node can do three things:
 *  - `match`   — evaluate against a record in memory (reference semantics + scan fallback, §3)
 *  - `serialize` / `hash` — produce the wire/cache form (the query half of the protocol, §4)
 *  - `compile` — dispatch to a backend `ExpressionVisitor` for native query translation (§3)
 */
export interface Expression {
  /** Evaluate this expression against a record's stored JSON. */
  match(record: JsonObject): boolean;

  /** Serialize to the transferable/cacheable AST node. */
  serialize(): ExpressionNode;

  /** A stable, order-independent hash for cache keys (matches `serialize()` semantics). */
  hash(): string;

  /** Dispatch to a backend compiler. */
  compile<R>(visitor: ExpressionVisitor<R>): R;
}
