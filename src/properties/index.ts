/**
 * The property layer: Standard Schema–backed scalar properties, relation metadata, and the
 * model-type inference that flows definitions into typed queries and results (ARCHITECTURE.md §5).
 */
export { ScalarProperty } from "./ScalarProperty.ts";
export type { ScalarPropertyConfig } from "./ScalarProperty.ts";
export {
  RelationToOneProperty,
  RelationToManyProperty
} from "./RelationProperty.ts";
export type { RelationConfig } from "./RelationProperty.ts";
export { ComputedProperty } from "./ComputedProperty.ts";

export {
  text,
  integer,
  float,
  boolean,
  date,
  json,
  array,
  embedded,
  scalar,
  computed,
  relationToOne,
  relationToMany
} from "./factories.ts";
export type {
  TextOptions,
  NumberOptions,
  BooleanOptions,
  DateOptions,
  JsonOptions,
  ArrayOptions,
  EmbeddedOptions
} from "./factories.ts";

export {
  ValidationError,
  validateSync,
  validateAsync,
  stringSchema,
  numberSchema,
  integerSchema,
  booleanSchema,
  dateSchema,
  anySchema
} from "./schema.ts";

export type { Codec, ScalarOptions } from "./types.ts";
export type { AnyProperty, PropertyMap, InferModel, StorableKeys } from "./infer.ts";
export { schemaFingerprint, schemaDescriptor } from "./fingerprint.ts";

import {
  text,
  integer,
  float,
  boolean,
  date,
  json,
  array,
  embedded,
  computed,
  relationToOne,
  relationToMany
} from "./factories.ts";

/** Ergonomic namespace import: `import prop from ".../properties"; prop.text()`. */
export default {
  text,
  integer,
  float,
  boolean,
  date,
  json,
  array,
  embedded,
  computed,
  relationToOne,
  relationToMany
};
