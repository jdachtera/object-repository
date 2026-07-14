/**
 * A **typed** Mongo-shaped filter — the compile-time query surface that gives the same field-name and
 * value-type safety as a zod-typed Mongo app. `Where<T>` is checked against the model's inferred type;
 * at runtime it's just a `MongoFilter`, so `QueryCollection.where` reuses the existing `parseMongoFilter`
 * (array-element equality, embedded traversal, all of it). Field names and operator value types are
 * checked at the top level *and* along dotted paths into `embedded()` subdocuments.
 */
import type { JsonValue } from "../core/types.ts";

/** Leaf value types that terminate a dotted path (we don't recurse into these). */
type Leaf = string | number | boolean | Date | null | undefined | JsonValue[] | readonly JsonValue[];

/** The comparison operators available on a field whose value type is `V` (Mongo-shaped). */
export type FieldQuery<V> =
  | V
  | {
      $eq?: V;
      $ne?: V;
      $gt?: V;
      $gte?: V;
      $lt?: V;
      $lte?: V;
      $in?: readonly V[];
      $nin?: readonly V[];
      $exists?: boolean;
    };

// Depth budget so the recursive path type can't loop forever (embedded docs are shallow in practice).
type Decr = [never, 0, 1, 2, 3, 4];

/** Dotted paths into nested (embedded) objects — `"subscription.details.status"` — up to depth `D`. */
type Paths<T, D extends number = 4> = [D] extends [never]
  ? never
  : T extends Leaf
    ? never
    : {
        [K in keyof T & string]: NonNullable<T[K]> extends Leaf
          ? K
          : K | `${K}.${Paths<NonNullable<T[K]>, Decr[D]>}`;
      }[keyof T & string];

/** The value type at a dotted path `P` of `T`. */
type PathValue<T, P extends string> = P extends `${infer K}.${infer R}`
  ? K extends keyof T
    ? PathValue<NonNullable<T[K]>, R>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * A typed filter over the model `T`. Top-level fields and dotted paths into embedded subdocuments are
 * type-checked (name + value type); the logical operators nest. Mirrors the runtime `MongoFilter` the
 * compat facade already understands, so it compiles to the same AST.
 */
export type Where<T> = {
  [K in keyof T]?: FieldQuery<T[K]>;
} & {
  // dotted paths that aren't already a top-level key
  [P in Exclude<Paths<T>, keyof T>]?: FieldQuery<PathValue<T, P>>;
} & {
  $and?: Where<T>[];
  $or?: Where<T>[];
  $nor?: Where<T>[];
};
