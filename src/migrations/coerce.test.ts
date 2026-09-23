/**
 * The widening-conversion table. This is the single definition a backend's native `ALTER COLUMN` and
 * the reference executor are both held to, so every case is pinned explicitly.
 */
import { describe, it, expect } from "vitest";
import { coerce, CoercionError } from "./coerce.js";
import type { JsonValue } from "../core/types.js";
import type { StoredType } from "./types.js";

describe("coerce", () => {
  const cases: Array<[JsonValue, StoredType, JsonValue]> = [
    // text: scalars use their own string form; objects and arrays go through JSON
    [42, "text", "42"],
    [true, "text", "true"],
    ["already", "text", "already"],
    [{ a: 1 } as unknown as JsonValue, "text", '{"a":1}'],
    [[1, 2] as unknown as JsonValue, "text", "[1,2]"],

    // numeric
    [3, "float", 3],
    ["3.5", "float", 3.5],
    ["7", "integer", 7],

    // boolean
    [true, "boolean", true],
    [1, "boolean", true],
    [0, "boolean", false],
    ["false", "boolean", false],
    ["1", "boolean", true],

    // date is stored as epoch milliseconds
    [1700000000000, "date", 1700000000000],
    ["1700000000000", "date", 1700000000000],

    // array wraps a lone value rather than discarding it
    [[1] as unknown as JsonValue, "array", [1] as unknown as JsonValue],
    ["solo", "array", ["solo"] as unknown as JsonValue],

    // json stores the value's JSON text; scalar holds any value as-is
    [{ a: 1 } as unknown as JsonValue, "json", '{"a":1}'],
    [42, "json", "42"],
    ["x", "scalar", "x"]
  ];

  for (const [input, to, expected] of cases) {
    it(`${JSON.stringify(input)} → ${to} = ${JSON.stringify(expected)}`, () => {
      expect(coerce(input, to)).toEqual(expected);
    });
  }

  it("passes null through for every target type", () => {
    const types: StoredType[] = ["text", "integer", "float", "boolean", "date", "json", "array", "scalar"];
    for (const to of types) expect(coerce(null, to)).toBeNull();
  });

  it("returns the input unchanged when no conversion is needed, so the executor can skip the write", () => {
    const value = { nested: true } as unknown as JsonValue;
    expect(coerce(value, "scalar")).toBe(value); // identity, not a copy
    expect(coerce("x", "text")).toBe("x");
    expect(coerce('{"a":1}', "json")).toBe('{"a":1}'); // already JSON text: not encoded twice
  });

  it("quotes a known text value into json, so it decodes back to the same string", () => {
    expect(coerce("hello", "json", "text")).toBe('"hello"');
    expect(JSON.parse(coerce("42", "json", "text") as string)).toBe("42"); // stays a string
  });

  it.each([
    ["abc", "float"],
    ["", "float"],
    [3.7, "integer"], // SQL would round, JS would truncate: neither is exact
    ["maybe", "boolean"],
    ["", "boolean"],
    [{}, "date"]
  ] as Array<[JsonValue, StoredType]>)("refuses %j → %s rather than store a guess", (value, to) => {
    expect(() => coerce(value, to)).toThrow(CoercionError);
  });
});
