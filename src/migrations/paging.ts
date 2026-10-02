/**
 * Keyset paging over a model, shared by the store-to-store copier and the migration executor so the
 * two can't drift.
 *
 * Each page seeks past the last `uuid` of the previous one (`WHERE uuid > after ORDER BY uuid LIMIT n`)
 * rather than using a growing `OFFSET`, so draining N rows costs O(N) total — an index seek per page —
 * instead of O(N²) from a re-scan per page on a scan backend or a deep-offset walk on SQL.
 */
import type { Backend } from "../core/Backend.ts";
import type { Context, JsonObject, SortKey } from "../core/types.ts";
import type { ExpressionNode, QueryPlan } from "../core/QueryPlan.ts";
import { all, and, gt } from "../expressions/builders.ts";
import { parse } from "../expressions/parse.ts";

/** Stable, deterministic page order — the one key every store can sort by. */
export const BY_UUID: SortKey[] = [{ property: "uuid", descending: false }];

export interface Page {
  rows: JsonObject[];
  /** The last uuid of this page: resume here to continue, which is what makes a long pass restartable. */
  cursor: string;
}

/**
 * Yield a model's records page by page.
 *
 * Rewriting rows **in place** while iterating is supported and relied upon by the migration executor:
 * the window advances monotonically on `uuid`, so a row rewritten during a page falls behind the
 * cursor and is never revisited, and each page is read by its own query that does not observe the
 * pending write queue. (The store-to-store copier forbids source === target for a different reason —
 * it writes records the source's own scan would then pick up.)
 */
export async function* pageByUuid(
  backend: Backend,
  model: string,
  where: ExpressionNode,
  batchSize: number,
  ctx: Context,
  after: string | null = null
): AsyncGenerator<Page> {
  const size = Math.max(1, Math.floor(batchSize));
  let cursor = after;
  for (;;) {
    // uuid compares lexicographically, matching `BY_UUID` on every backend, so the window never skips
    // or repeats a row even as rows are written behind it.
    const scoped: ExpressionNode = cursor === null ? where : and(parse(where), gt("uuid", cursor)).serialize();
    const plan: QueryPlan = { model, where: scoped, order: BY_UUID, paging: { start: 0, end: size } };
    const rows = await backend.query(plan, ctx);
    if (rows.length === 0) return;
    cursor = String(rows[rows.length - 1]!.uuid);
    yield { rows, cursor };
    if (rows.length < size) return; // a short page means the model is drained
  }
}

/** The unfiltered starting point for a full-model pass. */
export const everything = (): ExpressionNode => all().serialize();
