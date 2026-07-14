/**
 * Bulk backend-to-backend copy (a migration/backfill primitive, ARCHITECTURE.md §2).
 *
 * `copyBackend(source, target, { models })` drains each named model from `source` a page at a time
 * (ordered by `uuid` for stable, resumable pagination) and writes each page into `target` as one
 * persisted batch. Records cross the `Backend` seam as plain JSON, so the two backends can be any
 * pair — in-memory → Postgres, SQLite → Mongo, an old store → a new one — without either knowing the
 * other's shape. It reads through `source.query`, so ordering and paging are honoured even on
 * scan-only stores (the planner sorts/pages in memory when the store can't).
 *
 * A `Backend` doesn't enumerate its own models, so name them explicitly. The `target` must already
 * have those models provisioned (define them on a manager, or `registerModel`) — copy only moves
 * rows, it doesn't create schema. Paired with `multiWriteBackend`, this is the backfill half of a
 * zero-downtime cutover: copy the existing data, dual-write new data, then flip the primary.
 */
import type { Backend } from "../../core/Backend.ts";
import type { Context, JsonObject, SortKey } from "../../core/types.ts";
import type { ExpressionNode, QueryPlan } from "../../core/QueryPlan.ts";
import { SYSTEM_CONTEXT } from "../../core/types.ts";
import { all, and, gt } from "../../expressions/builders.ts";
import { parse } from "../../expressions/parse.ts";

export interface CopyOptions {
  /** Models to copy. A backend can't list its own models, so name them (order = copy order). */
  models: string[];
  /** Rows per read page / write batch (default 500). */
  batchSize?: number;
  /** Context for every read and write (defaults to the system context). */
  ctx?: Context;
  /** Optional per-model filter — copy only the matching subset (e.g. one tenant). */
  where?: (model: string) => ExpressionNode | undefined;
  /** Normalise each record before it's written; return `null` to skip it (drop a field, re-key, …). */
  transform?: (record: JsonObject, model: string) => JsonObject | null;
  /** Called after each flushed batch — a progress hook for long backfills. */
  onBatch?: (progress: CopyProgress) => void;
}

/** Progress after one flushed batch. */
export interface CopyProgress {
  model: string;
  /** Running total copied for this model so far. */
  copied: number;
  /** Rows written in the batch just flushed. */
  batch: number;
}

/** What a copy moved. */
export interface CopyReport {
  /** Rows copied per model. */
  perModel: Record<string, number>;
  /** Grand total across all models. */
  total: number;
}

/** Stable, deterministic page order — the same key every store can sort by. */
const BY_UUID: SortKey[] = [{ property: "uuid", descending: false }];

/**
 * Copy the named models from `source` into `target` in batches. Resolves with the per-model and total
 * row counts. Reads are **keyset-paged** — each page seeks past the last `uuid` of the previous one
 * (`WHERE uuid > lastUuid ORDER BY uuid LIMIT batch`) rather than using a growing `OFFSET`, so a copy
 * of N rows costs O(N) total (an index seek per page) instead of O(N²) (a re-scan/re-sort per page on
 * a scan backend, or a deep-offset walk on SQL). Each page is one `target.persist` flush, so a
 * transactional target commits it as a unit. `source` must not be mutated during the copy (don't pass
 * the same backend as both `source` and `target`).
 */
export async function copyBackend(source: Backend, target: Backend, options: CopyOptions): Promise<CopyReport> {
  const ctx = options.ctx ?? SYSTEM_CONTEXT;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
  const perModel: Record<string, number> = {};
  let total = 0;

  for (const model of options.models) {
    const baseWhere = options.where?.(model) ?? all().serialize();
    let copied = 0;
    let after: string | null = null;
    for (;;) {
      // Seek past the last uuid we read. uuid is compared lexicographically, matching the `BY_UUID`
      // sort on every backend, so the window never skips or repeats a row even as rows are written.
      const where: ExpressionNode = after === null ? baseWhere : and(parse(baseWhere), gt("uuid", after)).serialize();
      const plan: QueryPlan = { model, where, order: BY_UUID, paging: { start: 0, end: batchSize } };
      const rows = await source.query(plan, ctx);
      if (rows.length === 0) break;
      after = String(rows[rows.length - 1]!.uuid);

      let written = 0;
      for (const row of rows) {
        const record = options.transform ? options.transform(row, model) : row;
        if (record === null) continue;
        target.save(model, record, ctx);
        written += 1;
      }
      if (written > 0) {
        await target.persist(ctx);
        copied += written;
        options.onBatch?.({ model, copied, batch: written });
      }

      if (rows.length < batchSize) break; // a short page means the model is drained
    }
    perModel[model] = copied;
    total += copied;
  }

  return { perModel, total };
}
