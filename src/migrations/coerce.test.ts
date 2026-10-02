/**
 * The widening-conversion table. This is the single definition a backend's native `ALTER COLUMN` and
 * the reference executor are both held to, so every case is pinned explicitly.
 */
import { describe, it, expect } from "vitest";
import { cloneValue, coerce, CoercionError } from "./coerce.js";
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

  it("refuses blank text as a number, though Number() reads it as 0", () => {
    expect(() => coerce("  ", "float")).toThrow(CoercionError);
    expect(() => coerce("\t", "integer")).toThrow(CoercionError);
  });

  it("reads every spelling of a boolean it accepts", () => {
    expect([1, "1", "true"].map((v) => coerce(v, "boolean"))).toEqual([true, true, true]);
    expect([0, "0", "false"].map((v) => coerce(v, "boolean"))).toEqual([false, false, false]);
    expect(() => coerce(2, "boolean")).toThrow(CoercionError);
  });

  it("names the value and the target when it refuses", () => {
    const error = (() => {
      try {
        coerce("maybe", "boolean");
      } catch (caught) {
        return caught as CoercionError;
      }
    })();
    expect(error).toMatchObject({ name: "CoercionError", value: "maybe", to: "boolean" });
    expect(error!.message).toBe('Cannot convert "maybe" to boolean without losing or inventing information.');
  });

  it("leaves a value of the stated type alone, so JSON text isn't encoded twice", () => {
    expect(coerce('{"a":1}', "json", "json")).toBe('{"a":1}');
    const list = ["x"] as unknown as JsonValue;
    expect(coerce(list, "array", "array")).toBe(list);
  });

  describe("a float an engine rendered as text", () => {
    it.each([
      ["1e+15", "1000000000000000"],
      ["1e-07", "1e-7"],
      ["1.50", "1.5"],
      [" 3 ", "3"]
    ])("normalises %j to JavaScript's text", (rendered, text) => {
      expect(coerce(rendered, "text", "float")).toBe(text);
      expect(coerce(rendered, "json", "float")).toBe(text);
    });

    it("leaves text that isn't a number, or isn't known to be a float, as it is", () => {
      expect(coerce("1e+15", "text")).toBe("1e+15");
      expect(coerce("1e+15", "text", "integer")).toBe("1e+15");
      expect(coerce("abc", "text", "float")).toBe("abc");
      expect(coerce(" ", "text", "float")).toBe(" ");
      expect(coerce("abc", "json", "float")).toBe('"abc"');
      expect(coerce(" ", "json", "float")).toBe('" "');
      expect(coerce("1e+15", "json", "text")).toBe('"1e+15"');
      expect(coerce(1.5, "json", "float")).toBe("1.5");
    });
  });
});

describe("cloneValue", () => {
  it("copies objects and arrays, so a copied field never aliases its source", () => {
    const object = { a: [1] } as unknown as JsonValue;
    const array = [{ b: 2 }] as unknown as JsonValue;
    for (const value of [object, array]) {
      const copy = cloneValue(value);
      expect(copy).toEqual(value);
      expect(copy).not.toBe(value);
    }
  });

  it("returns null and scalars as they are", () => {
    for (const value of [null, 0, "", "x", false] as JsonValue[]) expect(cloneValue(value)).toBe(value);
  });
});
