import Expression from ".";

describe("query expressions", () => {
  it("should compare the value using = comparator", async () => {
    const expr = Expression.eq("firstName", "John");
    expect(await expr.match({ firstName: "John" })).toEqual(true);
    expect(await expr.match({ firstName: "Peter" })).toEqual(false);
    expect(expr.toHash()).toEqual(
      '{"type":"compare","property":"firstName","comparator":"=","value":"John"}'
    );
  });

  it("should compare the value using != comparator", async () => {
    const expr = Expression.neq("firstName", "John");
    expect(await expr.match({ firstName: "John" })).toEqual(false);
    expect(await expr.match({ firstName: "Peter" })).toEqual(true);
    expect(expr.toHash()).toEqual(
      '{"type":"compare","property":"firstName","comparator":"!=","value":"John"}'
    );
  });

  it("should compare the value using > comparator", async () => {
    const expr = Expression.gt("age", 30);
    expect(await expr.match({ age: 35 })).toEqual(true);
    expect(await expr.match({ age: 30 })).toEqual(false);
    expect(await expr.match({ age: 25 })).toEqual(false);
    expect(expr.toHash()).toEqual(
      '{"type":"compare","property":"age","comparator":">","value":30}'
    );
  });

  it("should compare the value using < comparator", async () => {
    const expr = Expression.lt("age", 30);
    expect(await expr.match({ age: 35 })).toEqual(false);
    expect(await expr.match({ age: 30 })).toEqual(false);
    expect(await expr.match({ age: 25 })).toEqual(true);
    expect(expr.toHash()).toEqual(
      '{"type":"compare","property":"age","comparator":"<","value":30}'
    );
  });

  it("should compare the value using >= comparator", async () => {
    const expr = Expression.gteq("age", 30);
    expect(await expr.match({ age: 35 })).toEqual(true);
    expect(await expr.match({ age: 30 })).toEqual(true);
    expect(await expr.match({ age: 25 })).toEqual(false);
    expect(expr.toHash()).toEqual(
      '{"type":"compare","property":"age","comparator":">=","value":30}'
    );
  });

  it("should compare the value using <= comparator", async () => {
    const expr = Expression.lteq("age", 30);
    expect(await expr.match({ age: 35 })).toEqual(false);
    expect(await expr.match({ age: 30 })).toEqual(true);
    expect(await expr.match({ age: 25 })).toEqual(true);
    expect(expr.toHash()).toEqual(
      '{"type":"compare","property":"age","comparator":"<=","value":30}'
    );
  });

  it("should combine expressions using and", async () => {
    const firstExpr = Expression.eq("firstName", "John");
    const secondExpr = Expression.lteq("age", 30);
    const expr = Expression.and(firstExpr, secondExpr);

    expect(await expr.match({ firstName: "John", age: 30 })).toEqual(true);
    expect(await expr.match({ firstName: "John" })).toEqual(false);
    expect(expr.toHash()).toEqual(
      '{"type":"and","expressions":["{\\"type\\":\\"compare\\",\\"property\\":\\"age\\",\\"comparator\\":\\"<=\\",\\"value\\":30}","{\\"type\\":\\"compare\\",\\"property\\":\\"firstName\\",\\"comparator\\":\\"=\\",\\"value\\":\\"John\\"}"]}'
    );
  });

  it("should combine expressions using or", async () => {
    const firstExpr = Expression.eq("firstName", "John");
    const secondExpr = Expression.lteq("age", 30);
    const expr = Expression.or(firstExpr, secondExpr);

    expect(await expr.match({ firstName: "John", age: 30 })).toEqual(true);
    expect(await expr.match({ firstName: "John" })).toEqual(true);
    expect(await expr.match({ firstName: "Peter" })).toEqual(false);
    expect(expr.toHash()).toEqual(
      '{"type":"or","expressions":["{\\"type\\":\\"compare\\",\\"property\\":\\"age\\",\\"comparator\\":\\"<=\\",\\"value\\":30}","{\\"type\\":\\"compare\\",\\"property\\":\\"firstName\\",\\"comparator\\":\\"=\\",\\"value\\":\\"John\\"}"]}'
    );
  });

  it("should match containing items", async () => {
    const expr = Expression.contains("languages", "German");

    expect(await expr.match({ languages: ["German", "English"] })).toEqual(
      true
    );

    expect(await expr.match({ languages: ["French", "English"] })).toEqual(
      false
    );
    expect(expr.toHash()).toEqual(
      '{"type":"contains","property":"languages","value":"German"}'
    );
  });

  it("should match items in list", async () => {
    const expr = Expression.in("nationality", ["German", "English"]);

    expect(await expr.match({ nationality: "German" })).toEqual(true);
    expect(await expr.match({ nationality: "English" })).toEqual(true);
    expect(await expr.match({ nationality: "French" })).toEqual(false);
    expect(expr.toHash()).toEqual(
      '{"type":"in","property":"nationality","values":["German","English"]}'
    );
  });

  it("should match number ranges", async () => {
    const expr = Expression.between("age", 30, 35);
    expect(await expr.match({ age: 35 })).toEqual(true);
    expect(await expr.match({ age: 30 })).toEqual(true);
    expect(await expr.match({ age: 25 })).toEqual(false);
    expect(await expr.match({ age: 36 })).toEqual(false);
    expect(expr.toHash()).toEqual(
      '{"type":"between","property":"age","lowerEnd":30,"upperEnd":35}'
    );
  });

  it("should match number ranges", async () => {
    const expr = Expression.not(Expression.between("age", 30, 35));
    expect(await expr.match({ age: 35 })).toEqual(false);
    expect(await expr.match({ age: 30 })).toEqual(false);
    expect(await expr.match({ age: 25 })).toEqual(true);
    expect(await expr.match({ age: 36 })).toEqual(true);
    expect(expr.toHash()).toEqual(
      '{"type":"not","expression":"{\\"type\\":\\"between\\",\\"property\\":\\"age\\",\\"lowerEnd\\":30,\\"upperEnd\\":35}"}'
    );
  });

  it("should match number ranges", async () => {
    const expr = Expression.not(Expression.between("age", 30, 35)).clone();
    expect(await expr.match({ age: 35 })).toEqual(false);
    expect(await expr.match({ age: 30 })).toEqual(false);
    expect(await expr.match({ age: 25 })).toEqual(true);
    expect(await expr.match({ age: 36 })).toEqual(true);
    expect(expr.toHash()).toEqual(
      '{"type":"not","expression":"{\\"type\\":\\"between\\",\\"property\\":\\"age\\",\\"lowerEnd\\":30,\\"upperEnd\\":35}"}'
    );
  });
});
