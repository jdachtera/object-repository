import { describe, it, expect } from "vitest";
import { validateSync, validateAsync, ValidationError, stringSchema } from "./schema.js";
import { scalar } from "./factories.js";
import type { StandardSchemaV1 } from "../core/standardSchema.ts";

// A Standard Schema whose validate() returns a Promise — an async validator.
const asyncString: StandardSchemaV1<unknown, string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: async (value) => (typeof value === "string" ? { value } : { issues: [{ message: "not a string" }] })
  }
};

describe("Standard Schema validation helpers", () => {
  it("validateSync returns the value or throws ValidationError with the issues", () => {
    expect(validateSync(stringSchema(), "ok")).toBe("ok");
    try {
      validateSync(stringSchema(), 42);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues[0]!.message).toBe("Expected a string");
    }
  });

  it("validateSync refuses an async validator instead of returning a Promise", () => {
    expect(() => validateSync(asyncString, "x")).toThrow(/asynchronously/);
  });

  it("validateAsync awaits and resolves, or rejects with ValidationError", async () => {
    await expect(validateAsync(asyncString, "hi")).resolves.toBe("hi");
    await expect(validateAsync(asyncString, 1)).rejects.toBeInstanceOf(ValidationError);
  });

  it("ValidationError with no issues still carries a message", () => {
    expect(new ValidationError([]).message).toBe("Validation failed");
  });
});

describe("scalar() escape-hatch factory", () => {
  it("builds a property with a custom schema + codec and validates async", async () => {
    const prop = scalar(stringSchema(), { encode: (v: string) => v.toUpperCase(), decode: (v) => String(v).toLowerCase() });
    expect(prop.type).toBe("scalar");
    expect(prop.encode("aB")).toBe("AB");
    expect(prop.decode("Xy")).toBe("xy");
    await expect(prop.validateAsync("ok")).resolves.toBe("ok");
  });
});
