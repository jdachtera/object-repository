import { describe, it, expect, expectTypeOf } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { text, integer, date } from "../properties/factories.js";
import { gt } from "../expressions/builders.js";
import { year, field } from "../expressions/values.js";

function peopleRepo() {
  const orm = new RepositoryManager();
  const people = orm.define({
    name: "Person",
    properties: { name: text(), city: text(), age: integer() }
  });
  for (const [name, city, age] of [
    ["Ann", "Berlin", 30],
    ["Bo", "Berlin", 40],
    ["Cy", "Paris", 20],
    ["Di", "Paris", 50]
  ] as const) {
    people.save(people.createInstance({ name, city, age }));
  }
  return people;
}

describe("advanced query pipeline (§11)", () => {
  it("counts, including with a filter", async () => {
    const people = peopleRepo();
    await people.persist();
    expect(await people.all().count()).toBe(4);
    expect(await people.all().filter(gt("age", 30)).count()).toBe(2);
  });

  it("computes named aggregates with field-checked references", async () => {
    const people = peopleRepo();
    await people.persist();

    const stats = await people.all().aggregate((a) => ({
      total: a.count(),
      avgAge: a.avg("age"),
      oldest: a.max("age")
    }));

    expect(stats).toEqual({ total: 4, avgAge: 35, oldest: 50 });
    expectTypeOf(stats).toEqualTypeOf<{ total: number; avgAge: number; oldest: number }>();
  });

  it("groups by a field and aggregates per group", async () => {
    const people = peopleRepo();
    await people.persist();

    const byCity = await people.all().groupBy("city", (a) => ({
      headcount: a.count(),
      avgAge: a.avg("age")
    }));

    const berlin = byCity.find((g) => g.key === "Berlin")!;
    const paris = byCity.find((g) => g.key === "Paris")!;
    expect(berlin).toEqual({ key: "Berlin", headcount: 2, avgAge: 35 });
    expect(paris).toEqual({ key: "Paris", headcount: 2, avgAge: 35 });
    expectTypeOf(berlin.key).toEqualTypeOf<string>();
    expectTypeOf(berlin.headcount).toEqualTypeOf<number>();
  });

  it("projects a subset of fields (typed)", async () => {
    const people = peopleRepo();
    await people.persist();

    const names = await people.all().sort("age").select({ name: true, age: true });
    expect(names.map((p) => p.name)).toEqual(["Cy", "Ann", "Bo", "Di"]);
    expectTypeOf(names).toEqualTypeOf<Array<{ name: string; age: number }>>();
  });

  it("groups by a computed expression (year bucket), reducing in memory", async () => {
    const orm = new RepositoryManager();
    const events = orm.define({ name: "Event", properties: { ts: date(), amount: integer() } });
    for (const [y, amount] of [[2023, 10], [2024, 20], [2024, 5]] as const) {
      events.save(events.createInstance({ ts: new Date(Date.UTC(y, 0, 1)), amount }));
    }
    await events.persist();

    const byYear = await events.all().groupByExpr(year(field("ts")), (a) => ({ n: a.count(), total: a.sum("amount") }));
    expect(byYear.find((g) => g.key === 2023)).toEqual({ key: 2023, n: 1, total: 10 });
    expect(byYear.find((g) => g.key === 2024)).toEqual({ key: 2024, n: 2, total: 25 });
  });

  it("groups by multiple keys (compound), reducing in memory", async () => {
    const orm = new RepositoryManager();
    const sales = orm.define({ name: "Sale", properties: { region: text(), product: text(), amount: integer() } });
    for (const [region, product, amount] of [["eu", "a", 10], ["eu", "a", 5], ["eu", "b", 20], ["us", "a", 100]] as const) {
      sales.save(sales.createInstance({ region, product, amount }));
    }
    await sales.persist();

    const groups = await sales.all().groupByMany([field("region"), field("product")], (a) => ({ n: a.count(), total: a.sum("amount") }));
    const find = (region: string, product: string) => groups.find((g) => g.key[0] === region && g.key[1] === product);
    expect(find("eu", "a")).toEqual({ key: ["eu", "a"], n: 2, total: 15 });
    expect(find("eu", "b")).toEqual({ key: ["eu", "b"], n: 1, total: 20 });
    expect(find("us", "a")).toEqual({ key: ["us", "a"], n: 1, total: 100 });
  });

  it("returns distinct values of a field", async () => {
    const people = peopleRepo();
    await people.persist();
    const cities = await people.all().distinct("city");
    expect(cities).toEqual(["Berlin", "Paris"]);
    expectTypeOf(cities).toEqualTypeOf<string[]>();
  });
});
