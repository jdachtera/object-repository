import type { JsonObject, Paging, SortKey } from "../../core/types.ts";
import type { QueryPlan } from "../../core/QueryPlan.ts";
import { parse } from "../../expressions/parse.ts";
import { getPath } from "../../expressions/path.ts";

/**
 * Reference query execution for scan-only backends (in-memory, localStorage, ...): filter by
 * evaluating the expression in memory, then order, then page (ARCHITECTURE.md §3).
 *
 * Crucially this applies ordering and paging — never silently dropped — and it runs
 * `parse(plan.where)` — so a plan that arrived serialized over a transport executes here without
 * any special-casing.
 */
export function scan(records: JsonObject[], plan: QueryPlan): JsonObject[] {
  const matcher = parse(plan.where);
  const filtered = records.filter((record) => matcher.match(record));
  const ordered = applyOrder(filtered, plan.order);
  return applyPaging(ordered, plan.paging);
}

export function applyOrder(records: JsonObject[], order: SortKey[]): JsonObject[] {
  if (order.length === 0) {
    return records;
  }
  return [...records].sort((a, b) => {
    for (const key of order) {
      const cmp = compareValues(getPath(a, key.property), getPath(b, key.property));
      if (cmp !== 0) {
        return key.descending ? -cmp : cmp;
      }
    }
    return 0;
  });
}

export function applyPaging(records: JsonObject[], paging: Paging): JsonObject[] {
  return records.slice(paging.start, paging.end);
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}
