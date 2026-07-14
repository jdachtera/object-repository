/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ScalarProperty } from "./ScalarProperty.ts";
import type { ComputedProperty } from "./ComputedProperty.ts";
import type {
  RelationToOneProperty,
  RelationToManyProperty
} from "./RelationProperty.ts";

/**
 * Any property usable in a model definition.
 *
 * The `any` type arguments are deliberate: they make the union a structural upper bound that
 * every concrete property (e.g. `ScalarProperty<string, string>`) is assignable to. Narrower
 * bounds (`unknown`/`never`) fail because `Stored` appears in a contravariant position.
 */
export type AnyProperty =
  | ScalarProperty<any, any>
  | ComputedProperty<any>
  | RelationToOneProperty<any>
  | RelationToManyProperty<any>;

/** A model definition: a map of property name → property. */
export type PropertyMap = Record<string, AnyProperty>;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Infers a model's instance type from its property map (ARCHITECTURE.md §5).
 *
 * This is the payoff of the port: `define(props)` can return a typed repository, so query
 * predicates and results are type-checked end to end. Scalars contribute their runtime type;
 * a to-one relation is `M | null`; a to-many relation is `M[]`. Every model carries `uuid`.
 */
export type InferModel<P extends PropertyMap> = Prettify<
  {
    // The computed arm must come first: a `ComputedProperty<R>` is structurally distinct, but
    // ordering it ahead of the scalar arm keeps it from ever being shadowed.
    [K in keyof P]: P[K] extends ComputedProperty<infer R>
      ? R
      : P[K] extends ScalarProperty<infer R, any>
        ? R
        : P[K] extends RelationToOneProperty<infer M>
          ? M | null
          : P[K] extends RelationToManyProperty<infer M>
            ? M[]
            : never;
  } & { uuid: string }
>;

/**
 * The keys of `P` that are *stored* (scalar or relation) — i.e. everything except computed/virtual
 * fields. Used to keep a computed field off the filter/sort/keyset surface (a computed field isn't
 * in any stored row, so filtering/sorting by it would be a silent no-op).
 */
export type StorableKeys<P extends PropertyMap> = {
  [K in keyof P]: P[K] extends ComputedProperty<any> ? never : K;
}[keyof P];
