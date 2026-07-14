/**
 * Local copy of the `StandardSchemaV1` interface (github.com/standard-schema/standard-schema,
 * `@standard-schema/spec` — MIT). Inlined rather than imported from the npm package: the package
 * has zero runtime code (types only), so depending on it as a real package specifier gains
 * nothing at runtime but forces every consumer — including ones running this source directly with
 * no `node_modules` (Deno, a vendored copy, `tsx`) — to have it resolvable on disk, since several
 * transpilers (esbuild among them) still attempt to resolve a bare specifier even for a
 * syntactically type-only `import type`, and silently mis-handle the module when that resolution
 * fails. Only the `StandardSchemaV1` surface this library actually consumes is kept; see the
 * upstream spec for the full interface (`StandardTypedV1`/`StandardJSONSchemaV1` etc.).
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: Options | undefined
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface Options {
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["input"];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}
