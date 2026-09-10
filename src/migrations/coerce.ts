/**
 * Value coercion for a widening `retypeField`.
 *
 * This lives in one place so the reference executor and a backend's native `ALTER COLUMN` cannot
 * disagree about what a converted value is. Only widening conversions reach here — a narrowing retype
 * is refused at plan time — so every conversion is total: nothing returns `null` for lack of a
 * representation.
 */
import type { JsonValue } from "../core/types.ts";
import type { StoredType } from "./types.ts";

/**
 * Convert a stored value to its representation under `to`.
 *
 * Returns the input unchanged when the target imposes no representation (`json`/`scalar` hold anything
 * as-is), so the executor can skip the write entirely — which is what makes re-running free.
 */
export function coerce(value: JsonValue, to: StoredType): JsonValue {
  if (value === null) return null;
  switch (to) {
    case "text":
      return typeof value === "string" ? value : stringify(value);
    case "float":
      return typeof value === "number" ? value : Number(value);
    case "integer":
      return typeof value === "number" ? Math.trunc(value) : Math.trunc(Number(value));
    case "boolean":
      return typeof value === "boolean" ? value : Boolean(value);
    case "date":
      // Dates are stored as epoch milliseconds (see `date()` in properties/factories).
      return typeof value === "number" ? value : Number(value);
    case "array":
      return Array.isArray(value) ? value : [value];
    case "json":
    case "scalar":
      return value;
  }
}

/** Objects and arrays stringify as JSON; scalars use their own string form, not `"[object Object]"`. */
function stringify(value: JsonValue): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
