import type { StandardSchemaV1 } from "../core/standardSchema.ts";
import type { JsonObject, JsonValue } from "../core/types.ts";
import type { Codec, ScalarOptions } from "./types.ts";
import { ScalarProperty } from "./ScalarProperty.ts";
import {
  RelationToOneProperty,
  RelationToManyProperty,
  type RelationConfig
} from "./RelationProperty.ts";
import { ComputedProperty } from "./ComputedProperty.ts";
import {
  stringSchema,
  numberSchema,
  integerSchema,
  booleanSchema,
  dateSchema,
  anySchema
} from "./schema.ts";

// --- codecs -------------------------------------------------------------------------------

const identityCodec = <T extends JsonValue>(): Codec<T, T> => ({
  encode: (value) => value,
  decode: (stored) => stored
});

const epochCodec: Codec<Date, number> = {
  encode: (value) => value.getTime(),
  decode: (stored) => new Date(stored)
};

const jsonCodec = <T>(): Codec<T, string> => ({
  encode: (value) => JSON.stringify(value),
  decode: (stored) => JSON.parse(stored) as T
});

// --- scalar factories ---------------------------------------------------------------------
//
// Each factory defaults its runtime type to the primitive base (string/number/boolean), but when a
// Standard Schema validator is supplied its *output* type drives the runtime type — so
// `text({ schema: z.enum(["song", "exercise"]) })` is a `ScalarProperty<"song" | "exercise", string>`,
// giving a zod-typed collection's literal-union safety. The schema output must extend the base type
// (an enum of strings for `text`, etc.); it also validates the value domain on every write. `default`
// stays typed to the base so it never narrows the inferred type. For a fully custom runtime type or
// codec, use `scalar()`.

export interface TextOptions extends ScalarOptions<string> {
  schema?: StandardSchemaV1<unknown, string>;
  length?: number;
}

export function text<S extends StandardSchemaV1<unknown, string>>(
  options: TextOptions & { schema: S }
): ScalarProperty<StandardSchemaV1.InferOutput<S>, string>;
export function text(options?: TextOptions): ScalarProperty<string, string>;
export function text(options: TextOptions = {}): ScalarProperty<string, string> {
  return new ScalarProperty({
    schema: options.schema ?? stringSchema(),
    codec: identityCodec<string>(),
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    length: options.length ?? 1000,
    type: "text"
  });
}

export interface NumberOptions extends ScalarOptions<number> {
  schema?: StandardSchemaV1<unknown, number>;
}

export function integer<S extends StandardSchemaV1<unknown, number>>(
  options: NumberOptions & { schema: S }
): ScalarProperty<StandardSchemaV1.InferOutput<S>, number>;
export function integer(options?: NumberOptions): ScalarProperty<number, number>;
export function integer(options: NumberOptions = {}): ScalarProperty<number, number> {
  return new ScalarProperty({
    schema: options.schema ?? integerSchema(),
    codec: identityCodec<number>(),
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    type: "integer"
  });
}

export function float<S extends StandardSchemaV1<unknown, number>>(
  options: NumberOptions & { schema: S }
): ScalarProperty<StandardSchemaV1.InferOutput<S>, number>;
export function float(options?: NumberOptions): ScalarProperty<number, number>;
export function float(options: NumberOptions = {}): ScalarProperty<number, number> {
  return new ScalarProperty({
    schema: options.schema ?? numberSchema(),
    codec: identityCodec<number>(),
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    type: "float"
  });
}

export interface BooleanOptions extends ScalarOptions<boolean> {
  schema?: StandardSchemaV1<unknown, boolean>;
}

export function boolean<S extends StandardSchemaV1<unknown, boolean>>(
  options: BooleanOptions & { schema: S }
): ScalarProperty<StandardSchemaV1.InferOutput<S>, boolean>;
export function boolean(options?: BooleanOptions): ScalarProperty<boolean, boolean>;
export function boolean(options: BooleanOptions = {}): ScalarProperty<boolean, boolean> {
  return new ScalarProperty({
    schema: options.schema ?? booleanSchema(),
    codec: identityCodec<boolean>(),
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    type: "boolean"
  });
}

export interface DateOptions extends ScalarOptions<Date> {
  schema?: StandardSchemaV1<unknown, Date>;
}

export function date(options: DateOptions = {}): ScalarProperty<Date, number> {
  return new ScalarProperty({
    schema: options.schema ?? dateSchema(),
    codec: epochCodec,
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    type: "date"
  });
}

/** Null-tolerant epoch codec — a live (never-deleted or restored) row stores/reads the marker as null. */
const nullableEpochCodec: Codec<Date | null, number | null> = {
  encode: (value) => (value == null ? null : value.getTime()),
  decode: (stored) => (stored == null ? null : new Date(stored))
};

/**
 * The nullable `date` marker injected by `softDelete: true` — a real `date`-typed column (so columnar
 * SQL builds a native column and the `isNull` live filter pushes down), but its codec passes null
 * through (the plain `date()` codec throws on null): a live row's marker is null, a soft-deleted row's
 * is the deletion timestamp. Internal — used by `RepositoryManager.withSoftDelete`.
 */
export function softDeleteMarker(): ScalarProperty<Date | null, number | null> {
  const schema: StandardSchemaV1<unknown, Date | null> = {
    "~standard": {
      version: 1,
      vendor: "orm-builtin",
      validate: (v) =>
        v == null || (v instanceof Date && !Number.isNaN(v.getTime()))
          ? { value: v as Date | null }
          : { issues: [{ message: "Expected a Date or null" }] }
    }
  };
  return new ScalarProperty({ schema, codec: nullableEpochCodec, type: "date" });
}

export interface JsonOptions<T> extends ScalarOptions<T> {
  schema?: StandardSchemaV1<unknown, T>;
}

/**
 * Resolve the shared `(schema, opts?)` / `(opts?)` overload of `json`/`embedded`. A Standard Schema is
 * recognised by its `~standard` marker: `json(zodSchema, opts?)` takes the validator (and the type is
 * inferred from it at the call site); `json(opts?)` names the type manually and may still carry an
 * `opts.schema`. Either way validation runs on write when a schema is present.
 */
function resolveSchemaOverload<T>(
  schemaOrOptions: StandardSchemaV1 | ScalarOptions<T> | { schema?: StandardSchemaV1<unknown, T> },
  maybeOptions: ScalarOptions<T>
): { schema: StandardSchemaV1<unknown, unknown> | undefined; options: ScalarOptions<T> } {
  const schemaFirst = "~standard" in schemaOrOptions;
  const options = (schemaFirst ? maybeOptions : (schemaOrOptions as ScalarOptions<T>)) ?? {};
  const schema = (
    schemaFirst
      ? (schemaOrOptions as StandardSchemaV1)
      : (schemaOrOptions as { schema?: StandardSchemaV1<unknown, T> }).schema
  ) as StandardSchemaV1<unknown, unknown> | undefined;
  return { schema, options };
}

export function json<S extends StandardSchemaV1>(
  schema: S,
  options?: Omit<JsonOptions<StandardSchemaV1.InferOutput<S>>, "schema">
): ScalarProperty<StandardSchemaV1.InferOutput<S>, string>;
export function json<T = JsonValue>(options?: JsonOptions<T>): ScalarProperty<T, string>;
export function json(
  schemaOrOptions: StandardSchemaV1 | JsonOptions<unknown> = {},
  maybeOptions: Omit<JsonOptions<unknown>, "schema"> = {}
): ScalarProperty<unknown, string> {
  const { schema, options } = resolveSchemaOverload<unknown>(schemaOrOptions, maybeOptions);
  return new ScalarProperty<unknown, string>({
    schema: schema ?? anySchema(),
    codec: jsonCodec<unknown>(),
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    type: "json"
  });
}

export interface ArrayOptions<T> extends ScalarOptions<T[]> {
  schema?: StandardSchemaV1<unknown, T[]>;
}

/**
 * An array field stored as a *native* JSON array (not a stringified blob like `json()`), so the
 * array patch ops (`push`/`addToSet`/`pull`) operate on it natively. Elements are scalars by default.
 */
export function array<T extends JsonValue = JsonValue>(options: ArrayOptions<T> = {}): ScalarProperty<T[], T[]> {
  return new ScalarProperty<T[], T[]>({
    schema: options.schema ?? anySchema<T[]>(),
    codec: identityCodec<T[]>(),
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    type: "array"
  });
}

export interface EmbeddedOptions<T> extends ScalarOptions<T> {
  schema?: StandardSchemaV1<unknown, T>;
}

/**
 * A nested subdocument stored *natively* (like `array()`, not stringified like `json()`), so its
 * fields are reachable by a dotted path in filters and sorts — `eq("subscription.customerId", id)`.
 * It traverses in memory (`getPath`), pushes down to a JSON extraction on the columnar SQL backends,
 * is a real subdocument on Mongo, and a nested value in the SQLite blob. Reach for `json()` instead
 * only when the value is an opaque blob you never query *into* (its dotted paths won't traverse).
 */
export function embedded<S extends StandardSchemaV1>(
  schema: S,
  options?: Omit<EmbeddedOptions<StandardSchemaV1.InferOutput<S>>, "schema">
): ScalarProperty<StandardSchemaV1.InferOutput<S>, JsonValue>;
export function embedded<T = JsonObject>(options?: EmbeddedOptions<T>): ScalarProperty<T, JsonValue>;
export function embedded(
  schemaOrOptions: StandardSchemaV1 | EmbeddedOptions<unknown> = {},
  maybeOptions: Omit<EmbeddedOptions<unknown>, "schema"> = {}
): ScalarProperty<unknown, JsonValue> {
  const { schema, options } = resolveSchemaOverload<unknown>(schemaOrOptions, maybeOptions);
  return new ScalarProperty<unknown, JsonValue>({
    schema: schema ?? anySchema(),
    // Identity at runtime (the value is stored natively / stringified by the backend), but typed
    // `Codec<unknown, JsonValue>` so the runtime type is unconstrained: a *discriminated union*
    // (per-`provider` detail shapes) or literal-typed subdocument survives, matching a zod-typed
    // collection. `json<T>()` is likewise unconstrained — `embedded` only differs in that its dotted
    // paths stay queryable.
    codec: { encode: (value) => value as JsonValue, decode: (stored) => stored },
    unique: options.unique,
    index: options.index,
    required: options.required,
    default: options.default,
    type: "embedded"
  });
}

/**
 * Escape hatch for a scalar with a fully custom runtime type, validator, and codec — when the
 * typed factories above don't fit (e.g. a branded string, a BigInt stored as text).
 */
export function scalar<Runtime, Stored extends JsonValue>(
  schema: StandardSchemaV1<unknown, Runtime>,
  codec: Codec<Runtime, Stored>,
  options: ScalarOptions<Runtime> = {}
): ScalarProperty<Runtime, Stored> {
  return new ScalarProperty({ schema, codec, unique: options.unique, index: options.index, required: options.required, default: options.default });
}

// --- computed / virtual fields ------------------------------------------------------------

/**
 * A computed (virtual) field derived from an instance's other fields by a pure function, materialized
 * on every read — `fullName: computed<string>((row) => `${row.first} ${row.last}`)`. Never stored,
 * validated, or sent to a backend (so it can't diverge across backends). The `compute` input is the
 * instance's already-decoded scalar fields; relations aren't loaded yet when it runs. Not filterable
 * or sortable (it isn't in any stored row).
 */
export function computed<R>(compute: (row: any) => R): ComputedProperty<R> {
  return new ComputedProperty<R>(compute as (row: Record<string, unknown>) => R);
}

// --- relation factories -------------------------------------------------------------------

export function relationToOne<M = unknown>(config: RelationConfig): RelationToOneProperty<M> {
  return new RelationToOneProperty<M>(config);
}

export function relationToMany<M = unknown>(config: RelationConfig): RelationToManyProperty<M> {
  return new RelationToManyProperty<M>(config);
}
