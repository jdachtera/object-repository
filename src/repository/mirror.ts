/**
 * The compatibility window: keeping a renamed field readable by builds that don't know the new name
 * (ARCHITECTURE.md §13).
 *
 * A gated rename leaves both fields in the store for as long as the window is open. The question that
 * decides everything else is which of the two is authoritative, and the answer is **the legacy one**.
 *
 * Mirroring can only ever be one-way, because only the newer build knows both names. If the canonical
 * field were authoritative, an older build updating the legacy field would leave the canonical one
 * present but stale — and nothing in the record could say which was fresher, so a reader coalescing
 * `canonical ?? legacy` would confidently return the stale value. The legacy field is the one *both*
 * generations write, which makes it the only one always current. So the new build writes through to
 * it and reads back from it, and the canonical field it exposes is a projection.
 *
 * Because the legacy field holds the value, a query naming the canonical field is rewritten to name
 * the legacy one — a pure **name substitution**, not a coalesce. That matters for two reasons: it is
 * exact for every comparator, sort key, projection entry and group key without a per-operator table,
 * and it preserves index push-down. A coalesce isn't even expressible here — `ExpressionNode`
 * predicates carry a `property: string`, not a value expression, so it would mean downgrading a
 * comparison to an opaque computed expression and losing the index with it.
 */
import type { AggregatePlan, ExpressionNode, QueryPlan, ValueNode, WindowPlan } from "../core/QueryPlan.ts";
import type { SortKey } from "../core/types.ts";

/** canonical field name → the legacy field that actually holds its value. */
export type Mirrors = ReadonlyMap<string, string>;

/** Rewrite a plan so every reference to a mirrored field names the field that holds the value. */
export function substitutePlan(plan: QueryPlan, mirrors: Mirrors): QueryPlan {
  if (mirrors.size === 0) return plan;
  const next: QueryPlan = { ...plan, where: substituteNode(plan.where, mirrors), order: substituteOrder(plan.order, mirrors) };
  if (plan.project) next.project = plan.project.map((field) => mirrors.get(field) ?? field);
  return next;
}

/** The aggregate-plan equivalent: filter, grouping keys and every aggregated value expression. */
export function substituteAggregate(plan: AggregatePlan, mirrors: Mirrors): AggregatePlan {
  if (mirrors.size === 0) return plan;
  return {
    ...plan,
    where: substituteNode(plan.where, mirrors),
    groupBy: plan.groupBy.map((value) => substituteValue(value, mirrors)),
    aggregates: plan.aggregates.map((stage) =>
      stage.value ? { ...stage, value: substituteValue(stage.value, mirrors) } : stage
    )
  };
}

/** The window-plan equivalent: filter, ordering, and each function's partition and order keys. */
export function substituteWindow(plan: WindowPlan, mirrors: Mirrors): WindowPlan {
  if (mirrors.size === 0) return plan;
  return {
    ...plan,
    where: substituteNode(plan.where, mirrors),
    order: substituteOrder(plan.order, mirrors),
    partitionBy: plan.partitionBy.map((value) => substituteValue(value, mirrors))
  };
}

function substituteOrder(order: SortKey[], mirrors: Mirrors): SortKey[] {
  return order.map((key) => (mirrors.has(key.property) ? { ...key, property: mirrors.get(key.property)! } : key));
}

/**
 * Rewrite every property reference in a predicate tree.
 *
 * Structural recursion over the node union rather than a per-type table: any node carrying a
 * `property` gets it substituted, and any node carrying children recurses. A node shape added later
 * without a matching case here would silently miss substitution, so the field is copied generically.
 */
export function substituteNode(node: ExpressionNode, mirrors: Mirrors): ExpressionNode {
  return rewrite(node, mirrors) as ExpressionNode;
}

/** Rewrite field references inside a computed value expression. */
export function substituteValue(value: ValueNode, mirrors: Mirrors): ValueNode {
  return rewrite(value, mirrors) as ValueNode;
}

/**
 * Rewrite every field reference in an AST, whatever its shape.
 *
 * Deliberately shape-agnostic rather than a case per node type. The union has predicates keyed on
 * `property`, field value-expressions keyed on `path`, and children under differently-named keys
 * (`expressions`, `value`, …) — enumerating those is exactly how a substitution silently misses a
 * node kind that gets added later, and a missed one doesn't fail loudly, it just reads the wrong
 * field. So: recurse into anything that looks like a node, and rewrite both reference keys wherever
 * they appear.
 *
 * A node is identified by carrying a string `type`, which is what keeps this out of a comparison's
 * bound *value*: user data would have to carry both a `type` and a `property`/`path` to be touched.
 */
function rewrite(node: unknown, mirrors: Mirrors): unknown {
  if (mirrors.size === 0 || !isNode(node)) return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if ((key === "property" || key === "path") && typeof value === "string") {
      out[key] = mirrors.get(value) ?? value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (isNode(item) ? rewrite(item, mirrors) : item));
    } else if (isNode(value)) {
      out[key] = rewrite(value, mirrors);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isNode(candidate: unknown): boolean {
  return typeof candidate === "object" && candidate !== null && typeof (candidate as { type?: unknown }).type === "string";
}
