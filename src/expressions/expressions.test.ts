import { describe, it, expect } from "vitest";
import { all, eq, neq, gt, lt, gte, lte, and, or, not, inList, notInList, contains, between, exists, size, startsWith, endsWith, includesText } from "./builders.js";
import { parse } from "./parse.js";
import type { Expression, ExpressionVisitor } from "./index.js";

describe("expression match (in-memory evaluation)", () => {
  it("compares with each comparator", () => {
    expect(eq("name", "John").match({ name: "John" })).toBe(true);
    expect(eq("name", "John").match({ name: "Jane" })).toBe(false);
    expect(neq("name", "John").match({ name: "Jane" })).toBe(true);
    expect(gt("age", 30).match({ age: 35 })).toBe(true);
    expect(gt("age", 30).match({ age: 30 })).toBe(false);
    expect(lt("age", 30).match({ age: 25 })).toBe(true);
    expect(gte("age", 30).match({ age: 30 })).toBe(true);
    expect(lte("age", 30).match({ age: 30 })).toBe(true);
  });

  it("evaluates and/or/not", () => {
    const expr = and(eq("name", "John"), lte("age", 30));
    expect(expr.match({ name: "John", age: 30 })).toBe(true);
    expect(expr.match({ name: "John", age: 31 })).toBe(false);
    expect(or(eq("name", "John"), eq("name", "Jane")).match({ name: "Jane" })).toBe(true);
    expect(not(eq("name", "John")).match({ name: "Jane" })).toBe(true);
  });

  it("evaluates in / nin / contains / between", () => {
    expect(inList("country", ["DE", "GB"]).match({ country: "DE" })).toBe(true);
    expect(inList("country", ["DE", "GB"]).match({ country: "FR" })).toBe(false);
    expect(notInList("country", ["DE", "GB"]).match({ country: "FR" })).toBe(true);
    expect(notInList("country", ["DE", "GB"]).match({ country: "DE" })).toBe(false);
    expect(notInList("country", ["DE", "GB"]).match({ city: "X" })).toBe(true); // missing field matches
    expect(contains("langs", "de").match({ langs: ["de", "en"] })).toBe(true);
    expect(between("age", 30, 35).match({ age: 32 })).toBe(true);
    expect(between("age", 30, 35).match({ age: 36 })).toBe(false);
  });

  it("reads dotted paths", () => {
    expect(eq("profile.city", "Berlin").match({ profile: { city: "Berlin" } })).toBe(true);
  });

  it("evaluates exists (present, incl. null, vs. absent)", () => {
    expect(exists("publishAt").match({ publishAt: 123 })).toBe(true);
    expect(exists("publishAt").match({ publishAt: null })).toBe(true); // null counts as present
    expect(exists("publishAt").match({ title: "x" })).toBe(false);
    expect(exists("publishAt", false).match({ title: "x" })).toBe(true);
    expect(exists("publishAt", false).match({ publishAt: null })).toBe(false);
    expect(exists("profile.city").match({ profile: { name: "x" } })).toBe(false);
  });

  it("evaluates size (array length, only arrays)", () => {
    expect(size("tags", 2).match({ tags: ["a", "b"] })).toBe(true);
    expect(size("tags", 2).match({ tags: ["a"] })).toBe(false);
    expect(size("tags", 0).match({ tags: [] })).toBe(true);
    expect(size("tags", 0).match({ title: "x" })).toBe(false); // missing is not an empty array
    expect(size("tags", 1).match({ tags: "a" })).toBe(false); // non-array never matches
  });

  it("evaluates text match (prefix/suffix/substring, ASCII case-insensitive)", () => {
    expect(startsWith("name", "Jo").match({ name: "John" })).toBe(true);
    expect(startsWith("name", "jo").match({ name: "John" })).toBe(false); // case-sensitive by default
    expect(startsWith("name", "jo", { caseInsensitive: true }).match({ name: "John" })).toBe(true);
    expect(endsWith("file", ".png", { caseInsensitive: true }).match({ file: "IMG.PNG" })).toBe(true);
    expect(includesText("bio", "dev").match({ bio: "developer" })).toBe(true);
    expect(includesText("bio", "DEV").match({ bio: "developer" })).toBe(false);
    expect(includesText("bio", "DEV", { caseInsensitive: true }).match({ bio: "developer" })).toBe(true);
    expect(startsWith("name", "x").match({ name: 123 } as never)).toBe(false); // non-string never matches
    expect(includesText("name", "").match({ name: "anything" })).toBe(true); // empty matches any string
  });

  it("matches everything with all()", () => {
    expect(all().match({ anything: 1 })).toBe(true);
  });
});

describe("serialize / parse round-trip (the wire protocol)", () => {
  const cases: Record<string, Expression> = {
    all: all(),
    compare: gt("age", 30),
    in: inList("country", ["DE", "GB"]),
    nin: notInList("country", ["DE", "GB"]),
    contains: contains("langs", "de"),
    between: between("age", 30, 35),
    exists: exists("publishAt"),
    existsFalse: exists("deletedAt", false),
    size: size("tags", 3),
    textmatch: includesText("bio", "dev", { caseInsensitive: true }),
    not: not(between("age", 30, 35)),
    and: and(eq("name", "John"), lte("age", 30)),
    nested: and(or(eq("a", 1), not(eq("b", 2))), between("c", 0, 10))
  };

  for (const [name, expr] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      const restored = parse(expr.serialize());
      expect(restored.hash()).toEqual(expr.hash());
    });
  }

  it("hashes and/or order-independently", () => {
    expect(and(eq("a", 1), eq("b", 2)).hash()).toEqual(and(eq("b", 2), eq("a", 1)).hash());
  });
});

describe("compile (visitor seam)", () => {
  // A toy visitor that compiles an expression to a SQL-ish WHERE string — standing in for what
  // a real SQL/Mongo/IndexedDB backend does instead of scanning.
  const sqlish: ExpressionVisitor<string> = {
    all: () => "1=1",
    compare: (p, c, v) => `${p} ${c} ${JSON.stringify(v)}`,
    expr: (l, c, r) => `expr(${c})[${JSON.stringify(l.serialize())},${JSON.stringify(r.serialize())}]`,
    any: (p, predicate) => `ANY(${p} -> ${predicate.compile(sqlish)})`,
    in: (p, vs) => `${p} IN (${vs.map((v) => JSON.stringify(v)).join(", ")})`,
    nin: (p, vs) => `${p} NOT IN (${vs.map((v) => JSON.stringify(v)).join(", ")})`,
    contains: (p, v) => `${JSON.stringify(v)} = ANY(${p})`,
    between: (p, lo, hi) => `${p} BETWEEN ${JSON.stringify(lo)} AND ${JSON.stringify(hi)}`,
    exists: (p, shouldExist) => `${p} ${shouldExist ? "EXISTS" : "MISSING"}`,
    isNull: (p, negated) => `${p} IS ${negated ? "NOT NULL" : "NULL"}`,
    size: (p, n) => `LENGTH(${p}) = ${n}`,
    textmatch: (p, v, mode, ci) => `${p} ${mode}${ci ? "/i" : ""} ${JSON.stringify(v)}`,
    and: (es) => `(${es.map((e) => e.compile(sqlish)).join(" AND ")})`,
    or: (es) => `(${es.map((e) => e.compile(sqlish)).join(" OR ")})`,
    not: (e) => `NOT (${e.compile(sqlish)})`
  };

  it("dispatches each node type to the visitor", () => {
    expect(gt("age", 30).compile(sqlish)).toBe('age > 30');
    expect(inList("country", ["DE"]).compile(sqlish)).toBe('country IN ("DE")');
    expect(and(eq("name", "John"), lt("age", 40)).compile(sqlish)).toBe('(name = "John" AND age < 40)');
    expect(not(between("age", 30, 35)).compile(sqlish)).toBe("NOT (age BETWEEN 30 AND 35)");
    expect(exists("publishAt").compile(sqlish)).toBe("publishAt EXISTS");
    expect(exists("deletedAt", false).compile(sqlish)).toBe("deletedAt MISSING");
    expect(startsWith("name", "Jo").compile(sqlish)).toBe('name prefix "Jo"');
    expect(includesText("bio", "x", { caseInsensitive: true }).compile(sqlish)).toBe('bio substring/i "x"');
  });
});
