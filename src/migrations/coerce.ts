/**
 * Value coercion for a retype, and for copying a value into a field of a stated type.
 *
 * This lives in one place so the reference executor and a backend's native lowering cannot disagree
 * about what a converted value is: SQL's retype lowering (`src/backends/sql/lower.ts`) is written to
 * produce exactly these stored forms, and the conformance suite holds it to that.
 *
 * Every conversion preserves the *runtime* value — what the target field's codec decodes is what the
 * source field's codec decoded. A value that can't be converted exactly throws rather than being
 * stored as `NaN`/`null`, truncated, or read as `true`: a migration that fails can be fixed and re-run,
 * one that quietly rewrites values cannot be undone.
 *
 * Stored forms, per type: `text` a string; `integer`/`float`/`date` a number (dates as epoch ms);
 * `boolean` a boolean; `json` the JSON *text* of the value (the `json()` codec stores a string);
 * `array` a JSON array; `scalar` any JSON value as-is.
 */
import type { JsonValue } from "../core/types.ts";
import type { StoredType } from "./types.ts";

/** A value that has no exact representation under the target type. */
export class CoercionError extends Error {
  constructor(
    readonly value: JsonValue,
    readonly to: StoredType
  ) {
    super(`Cannot convert ${JSON.stringify(value)} to ${to} without losing or inventing information.`);
    this.name = "CoercionError";
  }
}

/**
 * Convert a stored value to its representation under `to`.
 *
 * `from` is the source field's type when known (a retype states it). Without it — a copy between
 * fields — a value already in `to`'s stored form is taken as-is: that is what keeps a `json` → `json`
 * copy from encoding its JSON text a second time.
 *
 * Returns the input itself when nothing changes, so the executor can skip the write — which is what
 * makes re-running free.
 */
export function coerce(value: JsonValue, to: StoredType, from?: StoredType): JsonValue {
  if (value === null) return null;
  if (from === to) return value;
  switch (to) {
    case "text":
      if (typeof value !== "string") return stringify(value);
      // Already text, but a float an engine rendered its own way (`1e+15`, `1e-07`): the text form is
      // JavaScript's, whoever converted it — and normalising again changes nothing.
      if (from === "float" && value.trim() !== "" && Number.isFinite(Number(value))) return String(Number(value));
      return value;
    case "float":
    case "date":
      return toNumber(value, to);
    case "integer": {
      const number = toNumber(value, to);
      if (!Number.isInteger(number)) throw new CoercionError(value, to); // SQL rounds, JS truncates: neither is safe
      return number;
    }
    case "boolean":
      return toBoolean(value);
    case "array":
      return Array.isArray(value) ? value : [value];
    case "json":
      // Already JSON text, unless the source is known to be something else (`text` → `json` quotes).
      if (typeof value === "string" && from === undefined) return value;
      return JSON.stringify(value);
    case "scalar":
      return value;
  }
}

/** Objects and arrays stringify as JSON; scalars use their own string form, not `"[object Object]"`. */
function stringify(value: JsonValue): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function toNumber(value: JsonValue, to: StoredType): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  throw new CoercionError(value, to);
}

function toBoolean(value: JsonValue): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  throw new CoercionError(value, "boolean");
}

/** A private copy of a value, so a copied field never aliases its source (objects, arrays). */
export function cloneValue<T extends JsonValue>(value: T): T {
  return value !== null && typeof value === "object" ? structuredClone(value) : value;
}
