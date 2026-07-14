import { describe, it, expect } from "vitest";
import { text, integer, float, boolean, date, json } from "./factories.js";
import { ValidationError } from "./schema.js";

describe("scalar validation (built-in schemas)", () => {
  it("text accepts strings and rejects non-strings", () => {
    expect(text().validate("hi")).toBe("hi");
    expect(() => text().validate(5)).toThrow(ValidationError);
  });

  it("integer rejects non-integers", () => {
    expect(integer().validate(3)).toBe(3);
    expect(() => integer().validate(3.5)).toThrow(ValidationError);
  });

  it("float accepts decimals but rejects NaN/Infinity", () => {
    expect(float().validate(3.5)).toBe(3.5);
    expect(() => float().validate(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("boolean accepts only booleans", () => {
    expect(boolean().validate(true)).toBe(true);
    expect(() => boolean().validate("true")).toThrow();
  });

  it("date accepts valid Date instances and rejects others", () => {
    const now = new Date();
    expect(date().validate(now)).toBe(now);
    expect(() => date().validate(123)).toThrow();
    expect(() => date().validate(new Date("not-a-date"))).toThrow();
  });
});

describe("codecs round-trip through stored JSON", () => {
  it("date <-> epoch integer", () => {
    const property = date();
    const value = new Date("2026-06-29T00:00:00.000Z");
    const stored = property.encode(value);
    expect(typeof stored).toBe("number");
    expect(property.decode(stored).getTime()).toBe(value.getTime());
  });

  it("json <-> JSON string", () => {
    const property = json<{ bio: string }>();
    const stored = property.encode({ bio: "hi" });
    expect(typeof stored).toBe("string");
    expect(property.decode(stored)).toEqual({ bio: "hi" });
  });

  it("text uses an identity codec", () => {
    expect(text().encode("x")).toBe("x");
    expect(text().decode("x")).toBe("x");
  });
});

describe("storage metadata", () => {
  it("captures unique / index / length and kind", () => {
    const property = text({ unique: true, index: true, length: 64 });
    expect(property.kind).toBe("scalar");
    expect(property.unique).toBe(true);
    expect(property.index).toBe(true);
    expect(property.length).toBe(64);
  });

  it("defaults metadata sensibly", () => {
    const property = integer();
    expect(property.unique).toBe(false);
    expect(property.index).toBe(false);
  });
});

describe("ValidationError", () => {
  it("exposes structured issues", () => {
    try {
      text().validate(42);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues.length).toBeGreaterThan(0);
      expect((error as ValidationError).issues[0]?.message).toMatch(/string/i);
    }
  });
});
