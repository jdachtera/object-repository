import type { StandardSchemaV1 } from "../core/standardSchema.ts";
import type { JsonValue } from "../core/types.ts";
import type { Codec } from "./types.ts";
import { validateSync, validateAsync } from "./schema.ts";

export interface ScalarPropertyConfig<Runtime, Stored extends JsonValue> {
  schema: StandardSchemaV1<unknown, Runtime>;
  codec: Codec<Runtime, Stored>;
  unique?: boolean;
  index?: boolean;
  /** Reject a write when absent/null (after any `default`). */
  required?: boolean;
  /** Value or per-instance factory used to fill an absent (`undefined`) field. */
  default?: Runtime | (() => Runtime);
  /** Advisory max length for text-like columns; surfaced to DDL generation. */
  length?: number;
  /** A stable tag for the stored type (`text`/`integer`/…); used for introspection + schema fingerprints. */
  type?: string;
}

/**
 * An attribute (non-relation) property (ARCHITECTURE.md §5).
 *
 * Carries three things: a Standard Schema validator (runtime checks), a codec (runtime ↔
 * stored JSON), and storage metadata (unique/index/length). `Runtime` is what a model
 * instance holds; `Stored` is the JSON shape that crosses the backend boundary. The model's
 * static type is inferred from `Runtime`, not from the validator (see `InferModel`).
 */
export class ScalarProperty<Runtime, Stored extends JsonValue = JsonValue> {
  readonly kind = "scalar" as const;
  readonly schema: StandardSchemaV1<unknown, Runtime>;
  readonly codec: Codec<Runtime, Stored>;
  readonly unique: boolean;
  readonly index: boolean;
  readonly required: boolean;
  readonly hasDefault: boolean;
  private readonly defaultSpec: Runtime | (() => Runtime) | undefined;
  readonly length: number | undefined;
  readonly type: string;

  constructor(config: ScalarPropertyConfig<Runtime, Stored>) {
    this.schema = config.schema;
    this.codec = config.codec;
    this.unique = config.unique ?? false;
    this.index = config.index ?? false;
    this.required = config.required ?? false;
    this.defaultSpec = config.default;
    this.hasDefault = config.default !== undefined;
    this.length = config.length;
    this.type = config.type ?? "scalar";
  }

  /** Produce this property's default (calling the factory if it is one) and validate it. */
  makeDefault(): Runtime {
    const spec = this.defaultSpec;
    const value = typeof spec === "function" ? (spec as () => Runtime)() : (spec as Runtime);
    return this.validate(value);
  }

  /** Validate a candidate value, returning the typed runtime value (throws on failure). */
  validate(value: unknown): Runtime {
    return validateSync(this.schema, value);
  }

  /** Async counterpart of `validate`, for validators that resolve asynchronously. */
  validateAsync(value: unknown): Promise<Runtime> {
    return validateAsync(this.schema, value);
  }

  /** Encode a runtime value to its stored JSON form (for writing to a backend). */
  encode(value: Runtime): Stored {
    return this.codec.encode(value);
  }

  /** Decode a stored JSON value back to its runtime form (for reading from a backend). */
  decode(stored: Stored): Runtime {
    return this.codec.decode(stored);
  }
}
