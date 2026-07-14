/**
 * The reference computation for a `WindowPlan` — ranking functions over a filtered row set
 * (ARCHITECTURE.md §11). This is the single source of truth for what `rowNumber`/`rank`/`denseRank`
 * *mean*: a backend that pushes the window down (SQL `OVER (…)`, Mongo `$setWindowFields`) must produce
 * the same numbers this produces over the same rows. Lives in the expression layer (value-node
 * evaluation only) so both the in-memory fallback and any server-side reducer share it.
 *
 * Semantics (matching SQL / Mongo): rows are partitioned by the evaluated `partitionBy` tuple, ordered
 * within each partition by `order`, then numbered — `rowNumber` is 1,2,3… (ties broken by input
 * order), `rank` is 1,1,3 (ties share a rank, then a gap), `denseRank` is 1,1,2 (ties share, no gap).
 * Rows are returned in their *input* order with the window columns merged in.
 */
import type { SortKey, JsonObject, JsonValue } from "../core/types.ts";
import type { WindowPlan, WindowFn } from "../core/QueryPlan.ts";
import { parseValue } from "./values.ts";

/** Compare two rows by the plan's order keys (nulls first, matching `scan.ts`). Returns -1/0/1. */
function orderComparator(order: readonly SortKey[]): (a: JsonObject, b: JsonObject) => number {
  return (a, b) => {
    for (const key of order) {
      const av = a[key.property];
      const bv = b[key.property];
      const cmp = compareForRank(av, bv);
      if (cmp !== 0) return key.descending ? -cmp : cmp;
    }
    return 0;
  };
}

/** Ordering used for ranking: null/undefined sort first, then natural `<`; mismatched types are equal. */
function compareForRank(a: JsonValue | undefined, b: JsonValue | undefined): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? -1 : 1;
  if (typeof a !== typeof b) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether two rows are peers under the order (share every order-key value) — i.e. tie for a rank. */
function peers(order: readonly SortKey[], a: JsonObject, b: JsonObject): boolean {
  return order.every((key) => compareForRank(a[key.property], b[key.property]) === 0);
}

/** Assign one window function's value across an *already-ordered* partition. */
function assign(fn: WindowFn, order: readonly SortKey[], ordered: readonly JsonObject[]): Map<JsonObject, number> {
  const out = new Map<JsonObject, number>();
  let rank = 0;
  let dense = 0;
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]!;
    const isNewPeerGroup = i === 0 || !peers(order, ordered[i - 1]!, row);
    if (isNewPeerGroup) dense += 1;
    if (isNewPeerGroup) rank = i + 1; // rank jumps to the 1-based position at the start of a peer group
    out.set(row, fn.kind === "rowNumber" ? i + 1 : fn.kind === "rank" ? rank : dense);
  }
  return out;
}

/**
 * Compute `plan.functions` over `rows`, returning each row (in input order) with the window columns
 * merged in. `rows` are the already-filtered set; the plan's own `order` defines the ranking order.
 */
export function computeWindow(plan: WindowPlan, rows: readonly JsonObject[]): JsonObject[] {
  const partitionExprs = plan.partitionBy.map(parseValue);
  const order = plan.order;

  // Partition by the evaluated key tuple (hashed the way GROUP BY / $setWindowFields dedupe keys).
  const partitions = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = partitionExprs.map((expr) => expr.evaluate(row) ?? null);
    const hash = JSON.stringify(key);
    (partitions.get(hash) ?? partitions.set(hash, []).get(hash)!).push(row);
  }

  const values = new Map<JsonObject, Record<string, number>>();
  const cmp = orderComparator(order);
  for (const partition of partitions.values()) {
    const ordered = [...partition].sort(cmp);
    for (const fn of plan.functions) {
      const assigned = assign(fn, order, ordered);
      for (const [row, n] of assigned) {
        const bag = values.get(row) ?? {};
        bag[fn.name] = n;
        values.set(row, bag);
      }
    }
  }

  // Emit in input order with the window columns merged (leave the source rows untouched).
  return rows.map((row) => ({ ...row, ...values.get(row) }));
}
