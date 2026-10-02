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
  /**
   * The schema version at which this field stopped being canonical — i.e. the gate its removal waits
   * on (ARCHITECTURE.md §13). Pair with `mirrors` to keep it in step with its replacement for as long
   * as the compatibility window is open. Once `minSupportedSchemaVersion` reaches this number the
   * property goes inert: no column is provisioned for it and nothing is written to it.
   */
  deprecatedSince?: number;
  /**
   * The live property this one shadows during a rename's compatibility window.
   *
   * While the window is open **this field stays authoritative** and its replacement is a maintained
   * mirror of it. That direction is not arbitrary: mirroring can only ever be one-way, because only
   * the newer build knows both names. An older build updating this field would leave a replacement
   * that is present but stale, and nothing in the record could say which of the two was fresher —
   * so the field both generations write is the only one that is always current.
   */
  mirrors?: string;
}
