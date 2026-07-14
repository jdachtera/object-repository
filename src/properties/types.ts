import type { JsonValue } from "../core/types.ts";

/**
 * Bidirectional mapping between a property's runtime value and its stored JSON form
 * (ARCHITECTURE.md §5) — a single, uniform serialization mechanism every property uses.
 * Example: a `date` property runs a `Codec<Date, number>` so the model holds a `Date` while
 * the backend stores an epoch int.
 */
export interface Codec<Runtime, Stored extends JsonValue = JsonValue> {
  /** runtime value → stored JSON */
  encode(value: Runtime): Stored;
  /** stored JSON → runtime value */
  decode(stored: Stored): Runtime;
}

/** Storage hints shared by every scalar property; introspected to build DDL / indexes. */
export interface ScalarOptions<Runtime = JsonValue> {
  /** Enforce uniqueness for this column/field. */
  unique?: boolean;
  /** Hint the backend to build a secondary index (enables query push-down, §3). */
  index?: boolean;
  /**
   * Reject a write when this field is absent or null (checked at `save`, after any `default` is
   * applied). Off by default — fields are optional unless declared required.
   */
  required?: boolean;
  /**
   * A value (or a factory called per instance) used when the field is absent — filled by
   * `createInstance` and again at write time, so a plain object saved directly still gets it. Only
   * fills `undefined` (a truly absent field); an explicit `null` is left as-is.
   */
  default?: Runtime | (() => Runtime);
}
