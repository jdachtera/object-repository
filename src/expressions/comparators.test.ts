import { describe, it, expect } from "vitest";
import { eq, neq, gt, lt, gte, lte, any } from "./builders.js";
import { field } from "./values.js";

describe("comparator & node in-memory coverage", () => {
  it("every comparator matches in memory (plain-field fast path)", () => {
    const r = { a: 5, s: "m" };
    expect(neq("a", 4).match(r)).toBe(true);
    expect(neq("a", 5).match(r)).toBe(false);
    expect(lt("a", 6).match(r)).toBe(true);
    expect(lte("a", 5).match(r)).toBe(true);
    expect(gte("a", 5).match(r)).toBe(true);
    expect(gt("a", 5).match(r)).toBe(false);
    expect(lt("s", "n").match(r)).toBe(true);
  });

  it("every comparator matches through the computed-expr path (compareJson)", () => {
    // field-on-the-left makes these Expr nodes, which route through compareJson.
    const r = { a: 5 };
    expect(neq(field("a"), 4).match(r)).toBe(true); // !=
    expect(neq(field("a"), 5).match(r)).toBe(false);
    expect(lt(field("a"), 6).match(r)).toBe(true); // <
    expect(lte(field("a"), 5).match(r)).toBe(true); // <= (equal branch)
    expect(lte(field("a"), 4).match(r)).toBe(false);
    expect(gte(field("a"), 5).match(r)).toBe(true); // >= (equal branch)
    expect(gt(field("a"), 4).match(r)).toBe(true); // >
  });

  it("Any exposes a stable hash and serialized shape", () => {
    const a = any("items", eq("sku", "X"));
    expect(typeof a.hash()).toBe("string");
    expect(a.hash()).toBe(a.hash());
    expect(a.serialize().type).toBe("any");
  });
});
