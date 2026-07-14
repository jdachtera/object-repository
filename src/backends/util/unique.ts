import type { IndexSpec, PersistedChange } from "../../core/Backend.ts";
import type { JsonObject, JsonValue } from "../../core/types.ts";

/**
 * Thrown when a write would duplicate a `unique` field's value. Raised by the in-memory reference and
 * by the SQL/Mongo pre-write check (opt-in) so a uniqueness violation surfaces as the same friendly,
 * driver-agnostic error on every backend, instead of a raw DB index error (or, on MySQL, a silently
 * absorbed upsert).
 */
export class UniqueConstraintError extends Error {
  constructor(
    readonly model: string,
    readonly fields: string[]
  ) {
    super(`Unique constraint violated on "${model}" (${fields.join(", ")}).`);
    this.name = "UniqueConstraintError";
  }
}

/**
 * The field-sets that carry a unique constraint the reference/SQL enforce — a `unique` index that is
 * not a Mongo-only text/TTL index and has at least one field. Each entry is the ordered field paths of
 * one unique key (single-field or compound).
 */
export function uniqueKeySets(indexes: IndexSpec[]): string[][] {
  return indexes
    .filter((index) => index.unique && !index.text && index.ttlSeconds === undefined && index.fields.length > 0)
    .map((index) => index.fields.map((f) => f.path));
}

/**
 * A stable key for a record's values on `fields`, or `null` when any component is null/absent — a key
 * with a null/absent part is not enforced (NULLs distinct, like a plain SQL unique index).
 */
export function uniqueKey(record: JsonObject, fields: string[]): string | null {
  const values: JsonValue[] = [];
  for (const field of fields) {
    const value = record[field];
    if (value === null || value === undefined) return null;
    values.push(value);
  }
  return JSON.stringify(values);
}

/**
 * The first unique key-set on which two *different* records in one batch share a value — the
 * same-batch half of the check (the store can't see the batch's own rows yet). Returns the offending
 * field tuple, or `null` if the batch is internally consistent. A record re-saved under the same uuid
 * is not a self-conflict.
 */
export function sameBatchConflict(changes: PersistedChange[], keySets: string[][]): string[] | null {
  for (const fields of keySets) {
    const seen = new Map<string, string>(); // key → uuid
    for (const change of changes) {
      const key = uniqueKey(change.record, fields);
      if (key === null) continue;
      const uuid = String(change.record.uuid);
      const owner = seen.get(key);
      if (owner !== undefined && owner !== uuid) return fields;
      seen.set(key, uuid);
    }
  }
  return null;
}
