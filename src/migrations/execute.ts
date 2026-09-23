/**
 * The reference executor: what every migration operation *means*, expressed against nothing but the
 * `Backend` interface (ARCHITECTURE.md §11).
 *
 * This table is the specification. A backend that can do better implements `lowerMigrationOp` and the
 * runner prefers it, but the result must be the record set this produces — a native lowering changes
 * the cost, never the effect. Because it needs only `query`/`save`/`persist`, it works on every store,
 * including the schemaless ones where a SQL-shaped migration would silently do nothing at all.
 *
 * Three invariants, each closing a verified trap:
 *
 *  1. **Every `save` carries an explicit `dirty` array.** Without one, `MongoBackend.persist` writes
 *     `$set: <whole record>` and an absent key simply keeps its stored value — so a save-based
 *     `dropField` would succeed on four backends and silently no-op on Mongo.
 *  2. **That array always includes `uuid`.** Belt and braces around the empty-`$set` shape.
 *  3. **A generic pass never writes a schema-aware backend a model it hasn't registered.** A SQL
 *     backend derives its column list from `registerModel`; writing before that lands the whole record
 *     in the JSON overflow while the typed columns keep pre-migration values, so a get-by-uuid reads
 *     correctly and a filtered query does not — a divergence §11 forbids.
 */
import type { Backend, FieldSpec, IndexSpec } from "../core/Backend.ts";
import { isSchemaAware } from "../core/Backend.ts";
import type { Context, JsonObject, JsonValue } from "../core/types.ts";
import { MigrationNotSupportedError, SchemaUnknownError } from "./errors.ts";
import { everything, pageByUuid } from "./paging.ts";
import { coerce } from "./coerce.ts";
import type { MigrationOp, MigrationProgress, Phase, RecordTransform } from "./types.ts";

export interface ExecuteOptions {
  ctx: Context;
  batchSize: number;
  /** Which migration and phase this op belongs to — carried through purely for progress reporting. */
  migration: string;
  phase: Phase;
  /** Field/index layout per model, so a schema-aware backend is registered before it is written. */
  models: Record<string, { fields: FieldSpec[]; indexes: IndexSpec[] }>;
  transforms: Record<string, RecordTransform>;
  onProgress?: (progress: MigrationProgress) => void;
  /** Reported in `MigrationNotSupportedError`, purely for the message. */
  backendName?: string;
  /** Resume a record pass after this uuid: an interrupted run's last persisted page. */
  after?: string | null;
  /**
   * Called with a page's last uuid once its writes are queued and before they are persisted, so the
   * runner can queue a resume marker that lands in the same flush as the page it describes.
   */
  checkpoint?: (cursor: string) => void | Promise<void>;
  /** Called after each persisted page — the runner renews its lease here. */
  heartbeat?: () => Promise<void>;
}

/** How many records an op rewrote. */
export interface OpResult {
  rows: number;
}

/**
 * Apply one operation using only the portable `Backend` surface.
 *
 * Every op but `transform` is idempotent: re-running a completed pass is a no-op. A transform need not
 * be (`price * 100`), so an interrupted pass resumes from its last persisted page (`after`) instead of
 * starting over.
 */
export async function applyOp(backend: Backend, op: MigrationOp, options: ExecuteOptions): Promise<OpResult> {
  switch (op.kind) {
    case "createModel":
      await register(backend, op.model, op.fields, op.indexes ?? []);
      return { rows: 0 };

    case "dropModel": {
      let rows = 0;
      for await (const page of pageByUuid(
        backend,
        op.model,
        everything(),
        options.batchSize,
        options.ctx,
        options.after ?? null
      )) {
        for (const row of page.rows) backend.remove(op.model, row, options.ctx);
        await flushPage(backend, options, page.cursor);
        rows += page.rows.length;
        report(options, op, rows);
      }
      return { rows };
    }

    case "addField":
      // Without a fill there is nothing to write: an absent field already reads as absent everywhere.
      if (op.fill === undefined) return { rows: 0 };
      return rewrite(backend, op, options, [op.field], (record) => {
        if (record[op.field] !== undefined) return null;
        return { ...record, [op.field]: op.fill as JsonValue };
      });

    case "dropField":
      return rewrite(backend, op, options, [op.field], (record) => {
        if (!(op.field in record)) return null;
        const next = { ...record };
        delete next[op.field];
        return next;
      });

    case "copyField":
      return rewrite(backend, op, options, [op.to], (record) => {
        if (!op.overwrite && record[op.to] !== undefined) return null;
        if (record[op.from] === undefined) return null;
        return { ...record, [op.to]: record[op.from] as JsonValue };
      });

    case "renameField":
      return rewrite(backend, op, options, [op.from, op.to], (record) => {
        if (record[op.from] === undefined) return null;
        const next = { ...record, [op.to]: record[op.from] as JsonValue };
        delete next[op.from];
        return next;
      });

    case "retypeField":
      return rewrite(backend, op, options, [op.field], (record) => {
        const value = record[op.field];
        if (value === undefined) return null;
        const converted = coerce(value, op.to);
        return converted === value ? null : { ...record, [op.field]: converted };
      });

    case "transform": {
      const transform = options.transforms[op.transform];
      if (!transform) {
        throw new Error(
          `Migration references transform "${op.transform}", which is not in the migration's \`transforms\` map.`
        );
      }
      return rewrite(backend, op, options, op.fields, (record) => transform(record, op.model), op.where);
    }

    case "addIndex":
    case "dropIndex":
      // Index maintenance is schema, not data: re-register the model and let the backend reconcile.
      // A store with no schema concept has nothing to do and correctly does nothing.
      await reregister(backend, op.model, options);
      return { rows: 0 };

    case "rawSql":
      throw new MigrationNotSupportedError(op, options.backendName ?? "the portable executor");
  }
}

/**
 * Page through a model applying `change` to each record. `change` returns `null` to leave a record
 * alone (so an already-migrated row costs nothing) or the replacement record; a `transform` op may
 * also return `null` from the user's function to *remove* the record, which is distinguished by
 * `removeOnNull`.
 */
async function rewrite(
  backend: Backend,
  op: MigrationOp & { model: string },
  options: ExecuteOptions,
  fields: string[],
  change: (record: Readonly<JsonObject>) => JsonObject | null,
  where = everything()
): Promise<OpResult> {
  await reregister(backend, op.model, options);
  const removeOnNull = op.kind === "transform";
  const dirty = ["uuid", ...fields.filter((field) => field !== "uuid")];
  let rows = 0;

  for await (const page of pageByUuid(
    backend,
    op.model,
    where,
    options.batchSize,
    options.ctx,
    options.after ?? null
  )) {
    let written = 0;
    try {
      for (const row of page.rows) {
        const next = change(row);
        if (next === null) {
          if (!removeOnNull) continue; // unchanged — skip, which is what makes a re-run free
          if (op.kind === "transform" && op.phase === "expand") {
            // Declared expand is a promise that nothing pre-existing is disturbed; deleting a record
            // breaks it, and the gate that should have held it back was bypassed on that promise.
            throw new Error(
              `Transform "${op.transform}" on "${op.model}" is declared phase "expand" but deleted record ${JSON.stringify(row.uuid)}. A transform that deletes must be a contract.`
            );
          }
          backend.remove(op.model, row, options.ctx);
          written += 1;
          continue;
        }
        backend.save(op.model, next, options.ctx, dirty);
        written += 1;
      }
    } catch (error) {
      // A throw mid-page must not leave that page half-queued: the next persist anyone issues — the
      // lease release, or the application's own — would commit it, and the rerun would apply it again.
      backend.discardPending?.();
      throw error;
    }
    if (written > 0) {
      await flushPage(backend, options, page.cursor);
      rows += written;
      report(options, op, rows);
    }
  }
  return { rows };
}

/** Persist one page together with its resume marker, discarding both if the flush fails. */
async function flushPage(backend: Backend, options: ExecuteOptions, cursor: string): Promise<void> {
  try {
    await options.checkpoint?.(cursor);
    await backend.persist(options.ctx);
  } catch (error) {
    backend.discardPending?.();
    throw error;
  }
  await options.heartbeat?.();
}

/** Register a model's layout with a schema-aware backend, refusing to guess when it isn't known. */
async function reregister(backend: Backend, model: string, options: ExecuteOptions): Promise<void> {
  if (!isSchemaAware(backend)) return;
  const schema = options.models[model];
  if (!schema) throw new SchemaUnknownError(model);
  await register(backend, model, schema.fields, schema.indexes);
}

async function register(backend: Backend, model: string, fields: FieldSpec[], indexes: IndexSpec[]): Promise<void> {
  if (!isSchemaAware(backend)) return;
  await backend.registerModel(model, indexes, fields);
}

function report(options: ExecuteOptions, op: MigrationOp, rows: number): void {
  options.onProgress?.({
    migration: options.migration,
    phase: options.phase,
    op,
    rows
  });
}
