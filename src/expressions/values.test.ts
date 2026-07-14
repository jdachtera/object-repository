import { describe, it, expect } from "vitest";
import { field, lit, add, sub, mul, div, mod, neg, concat, coalesce, datePart, year, month, dayOfMonth, dayOfWeek, hour, dateToString, cmp, allOf, anyOf, negate, cond, switchExpr, parseValue } from "./values.js";
import type { ValueVisitor } from "./values.js";
import { gt, eq } from "./builders.js";
import { parse } from "./parse.js";
import { Compare, Expr } from "./nodes.js";

describe("value expressions — in-memory evaluation", () => {
  const row = { price: 10, qty: 3, first: "Ada", last: "Lovelace", nickname: null };

  it("evaluates arithmetic", () => {
    expect(mul(field("price"), field("qty")).evaluate(row)).toBe(30);
    expect(add(field("price"), 5).evaluate(row)).toBe(15);
    expect(sub(field("price"), field("qty")).evaluate(row)).toBe(7);
    expect(div(field("price"), field("qty")).evaluate(row)).toBeCloseTo(3.333, 2);
    expect(mod(field("price"), field("qty")).evaluate(row)).toBe(1);
  });

  it("evaluates concat and coalesce", () => {
    expect(concat(field("first"), lit(" "), field("last")).evaluate(row)).toBe("Ada Lovelace");
    expect(coalesce(field("nickname"), field("first")).evaluate(row)).toBe("Ada");
    expect(coalesce(field("nickname"), field("missing")).evaluate(row)).toBeNull(); // all null → null
  });

  it("field access into a non-object path yields undefined", () => {
    // `first` is a string, so `first.length` can't be traversed → null (not a throw)
    expect(field("first.length").evaluate(row)).toBeNull();
  });

  it("divide-by-zero is defined (returns 0) rather than throwing", () => {
    expect(div(field("price"), lit(0)).evaluate(row)).toBe(0);
  });

  it("extracts UTC date parts from an epoch-ms field (and from a Date instance)", () => {
    // 2024-03-05T14:30:45.000Z is a Tuesday (UTC day 2 -> Mongo dayOfWeek 3)
    const ms = Date.UTC(2024, 2, 5, 14, 30, 45);
    const r = { ts: ms };
    expect(year(field("ts")).evaluate(r)).toBe(2024);
    expect(month(field("ts")).evaluate(r)).toBe(3); // 1-based
    expect(dayOfMonth(field("ts")).evaluate(r)).toBe(5);
    expect(dayOfWeek(field("ts")).evaluate(r)).toBe(3); // 1=Sunday → Tuesday is 3
    expect(hour(field("ts")).evaluate(r)).toBe(14);
    // a hydrated instance may hold a Date — handled too
    expect(year(field("ts")).evaluate({ ts: new Date(ms) } as never)).toBe(2024);
    // a non-date value yields null rather than throwing
    expect(month(field("missing")).evaluate(r)).toBeNull();
  });

  it("formats a date with dateToString (UTC, strftime tokens)", () => {
    const ms = Date.UTC(2024, 2, 5, 9, 7, 3);
    expect(dateToString(field("ts"), "%Y-%m-%d").evaluate({ ts: ms })).toBe("2024-03-05");
    expect(dateToString(field("ts"), "%H:%M:%S").evaluate({ ts: ms })).toBe("09:07:03"); // zero-padded
    expect(dateToString(field("ts"), "%Y/%m/%d %H:%M").evaluate({ ts: ms })).toBe("2024/03/05 09:07");
    expect(dateToString(field("ts"), "100%%").evaluate({ ts: ms })).toBe("100%");
    expect(dateToString(field("missing"), "%Y").evaluate({ ts: ms })).toBeNull();
  });

  it("evaluates boolean ops, cond, and switch", () => {
    const r = { level: "beginner", score: 75 };
    expect(cmp(field("level"), "=", "beginner").evaluate(r)).toBe(true);
    expect(cond(cmp(field("score"), ">", 50), "pass", "fail").evaluate(r)).toBe("pass");
    expect(cond(cmp(field("score"), ">", 80), "pass", "fail").evaluate(r)).toBe("fail");
    expect(allOf(cmp(field("score"), ">", 50), cmp(field("level"), "=", "beginner")).evaluate(r)).toBe(true);
    expect(anyOf(cmp(field("score"), ">", 90), cmp(field("level"), "=", "beginner")).evaluate(r)).toBe(true);
    expect(negate(cmp(field("score"), ">", 90)).evaluate(r)).toBe(true);

    const weight = switchExpr(
      [
        [cmp(field("level"), "=", "beginner"), 1],
        [cmp(field("level"), "=", "intermediate"), 2]
      ],
      3
    );
    expect(weight.evaluate(r)).toBe(1);
    expect(weight.evaluate({ level: "advanced" } as never)).toBe(3); // falls through to default
  });

  it("round-trips cond/switch through serialize/parse", () => {
    const expr = switchExpr([[cmp(field("n"), ">", 0), "pos"]], "nonpos");
    const restored = parseValue(expr.serialize());
    expect(restored.evaluate({ n: 5 })).toBe("pos");
    expect(restored.evaluate({ n: -1 })).toBe("nonpos");
  });

  it("evaluates negation and every date part", () => {
    expect(neg(field("a")).evaluate({ a: 5 })).toBe(-5);
    const ms = Date.UTC(2024, 2, 5, 9, 7, 3);
    expect(datePart("minute", field("t")).evaluate({ t: ms })).toBe(7);
    expect(datePart("second", field("t")).evaluate({ t: ms })).toBe(3);
  });

  it("serialize → parseValue → serialize is stable for every node kind, and compile() dispatches", () => {
    const all = [
      field("a"),
      lit(5),
      add(field("a"), 1),
      sub(field("a"), field("b")),
      neg(field("a")),
      concat(field("a"), lit("x")),
      coalesce(field("a"), lit(0)),
      year(field("t")),
      dateToString(field("t"), "%Y"),
      cmp(field("a"), ">", 1),
      allOf(cmp(field("a"), ">", 1)),
      anyOf(cmp(field("a"), ">", 1)),
      negate(cmp(field("a"), ">", 1)),
      cond(cmp(field("a"), ">", 1), 1, 0),
      switchExpr([[cmp(field("a"), ">", 1), 1]], 0)
    ];
    // A counting visitor: compiling each expr as the top node exercises that class's compile().
    const stub = new Proxy({}, { get: () => () => "ok" }) as unknown as ValueVisitor<string>;
    for (const expr of all) {
      const node = expr.serialize();
      expect(parseValue(node).serialize()).toEqual(node); // parseValue covers every case
      expect(expr.compile(stub)).toBe("ok"); // compile() dispatch on every class
    }
  });
});

describe("computed filters via the comparison builders", () => {
  it("keeps the plain-field fast path as a Compare (index-pushable)", () => {
    expect(gt("age", 30)).toBeInstanceOf(Compare);
  });

  it("becomes an Expr when an operand is a value expression", () => {
    const filter = gt(mul(field("price"), field("qty")), 100);
    expect(filter).toBeInstanceOf(Expr);
    expect(filter.match({ price: 40, qty: 3 })).toBe(true); // 120 > 100
    expect(filter.match({ price: 10, qty: 3 })).toBe(false); // 30 > 100
  });

  it("reads a bare string operand as a field in computed comparisons", () => {
    // eq(field, field): compare two columns
    const filter = eq(field("a"), field("b"));
    expect(filter.match({ a: 1, b: 1 })).toBe(true);
    expect(filter.match({ a: 1, b: 2 })).toBe(false);
  });

  it("round-trips a computed filter through serialize/parse", () => {
    const filter = gt(add(field("price"), field("tax")), 100);
    const restored = parse(filter.serialize());
    expect(restored.hash()).toEqual(filter.hash());
    expect(restored.match({ price: 60, tax: 50 })).toBe(true);
  });
});
