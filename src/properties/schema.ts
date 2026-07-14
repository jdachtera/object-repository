import type { StandardSchemaV1 } from "../core/standardSchema.ts";

/**
 * Validation built on the Standard Schema spec (ARCHITECTURE.md §5).
 *
 * A scalar property delegates validation to *any* Standard Schema validator — Zod, ArkType,
 * Valibot, or the zero-dependency built-ins below. The property's runtime type, not the
 * validator, is the source of truth for model inference; the validator enforces the value
 * domain at runtime.
 */

/** Thrown when a value fails validation; carries the structured issues from the validator. */
export class ValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(issues.map((issue) => issue.message).join("; ") || "Validation failed");
    this.name = "ValidationError";
  }
}

/** Validate synchronously. Throws `ValidationError` on failure, or if the schema is async. */
export function validateSync<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown
): Output {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new Error(
      "This schema validates asynchronously; use validateAsync()/validateAsync property API."
    );
  }
  if (result.issues) {
    throw new ValidationError(result.issues);
  }
  return result.value;
}

/** Validate, awaiting async validators. Throws `ValidationError` on failure. */
export async function validateAsync<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown
): Promise<Output> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    throw new ValidationError(result.issues);
  }
  return result.value;
}

/** Build a minimal, synchronous Standard Schema validator from a type guard. */
function builtin<Output>(
  check: (value: unknown) => value is Output,
  message: string
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "orm-builtin",
      validate: (value) => (check(value) ? { value } : { issues: [{ message }] })
    }
  };
}

export const stringSchema = (): StandardSchemaV1<unknown, string> =>
  builtin((v): v is string => typeof v === "string", "Expected a string");

export const numberSchema = (): StandardSchemaV1<unknown, number> =>
  builtin((v): v is number => typeof v === "number" && Number.isFinite(v), "Expected a finite number");

export const integerSchema = (): StandardSchemaV1<unknown, number> =>
  builtin((v): v is number => Number.isInteger(v), "Expected an integer");

export const booleanSchema = (): StandardSchemaV1<unknown, boolean> =>
  builtin((v): v is boolean => typeof v === "boolean", "Expected a boolean");

export const dateSchema = (): StandardSchemaV1<unknown, Date> =>
  builtin(
    (v): v is Date => v instanceof Date && !Number.isNaN(v.getTime()),
    "Expected a valid Date"
  );

/** Pass-through validator for free-form JSON values (the `json` property default). */
export const anySchema = <T = unknown>(): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "orm-builtin",
    validate: (value) => ({ value: value as T })
  }
});
