import { describe, it, expect, expectTypeOf } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { text, integer, date } from "../properties/factories.js";
import { eq, or, gt } from "../expressions/builders.js";
import { ValidationError } from "../properties/schema.js";

function userRepo() {
  const orm = new RepositoryManager();
  return orm.define({
    name: "User",
    properties: { firstName: text(), lastName: text(), age: integer() }
  });
}

describe("Repository — typed define + in-memory backend", () => {
  it("creates, saves, and queries with preserved identity", async () => {
    const users = userRepo();

    const peter = users.createInstance({ firstName: "Peter", lastName: "Pan", age: 35 });
    expect(peter.firstName).toBe("Peter");
    expect(peter.uuid).toHaveLength(32);
    users.save(peter);
    await users.persist();

    const john = users.createInstance({ firstName: "John", lastName: "Johnson", age: 40 });
    users.save(john);
    await users.persist();

    const peters = await users.all().filter(eq("firstName", "Peter")).list();
    expect(peters).toEqual([peter]);
    expect(peters[0]).toBe(peter); // identity map returns the same object reference

    const either = await users
      .all()
      .filter(or(eq("firstName", "John"), eq("firstName", "Peter")))
      .list();
    expect(either).toHaveLength(2);
  });

  it("infers the instance type from the property map", () => {
    const users = userRepo();
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    expectTypeOf(peter.firstName).toEqualTypeOf<string>();
    expectTypeOf(peter.age).toEqualTypeOf<number>();
    expectTypeOf(peter.uuid).toEqualTypeOf<string>();
  });

  it("validates scalar values on create", () => {
    const users = userRepo();
    expect(() => users.createInstance({ age: 3.5 })).toThrow(ValidationError);
  });

  it("round-trips values through property codecs (Date <-> epoch int)", async () => {
    const orm = new RepositoryManager();
    const events = orm.define({ name: "Event", properties: { title: text(), when: date() } });

    const when = new Date("2026-06-29T10:00:00.000Z");
    const launch = events.createInstance({ title: "Launch", when });
    events.save(launch);
    await events.persist();

    const [loaded] = await events.all().list();
    expect(loaded!.when).toBeInstanceOf(Date);
    expect(loaded!.when.getTime()).toBe(when.getTime());
  });

  it("get(uuid) returns from cache, getMany batches", async () => {
    const users = userRepo();
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    const jane = users.createInstance({ firstName: "Jane", age: 25 });
    users.save(peter).save(jane);
    await users.persist();

    expect(await users.get(peter.uuid)).toBe(peter);
    const many = await users.getMany([peter.uuid, jane.uuid]);
    expect(many).toHaveLength(2);
    expect(await users.get("does-not-exist")).toBeNull();
  });

  it("sorts and pages", async () => {
    const users = userRepo();
    for (const [firstName, age] of [["A", 30], ["B", 20], ["C", 40]] as const) {
      users.save(users.createInstance({ firstName, age }));
    }
    await users.persist();

    const byAge = await users.all().sort("age").list();
    expect(byAge.map((u) => u.firstName)).toEqual(["B", "A", "C"]);

    const oldest = await users.all().sort("age", true).slice(0, 1).list();
    expect(oldest.map((u) => u.firstName)).toEqual(["C"]);
  });

  it("rejects a non-integer slice window (OFFSET/LIMIT is inlined into SQL, so guard it early)", () => {
    const users = userRepo();
    // a stringly-typed offset from an untrusted request must not reach the SQL OFFSET verbatim
    expect(() => users.all().slice("0 UNION SELECT 1" as unknown as number)).toThrow(/non-negative integer/);
    expect(() => users.all().slice(1.5)).toThrow(/integer/);
    expect(() => users.all().slice(0, 2.7)).toThrow(/integer/);
    expect(() => users.all().slice(5, 2)).toThrow(/>= start/);
  });

  it("removes instances", async () => {
    const users = userRepo();
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    users.save(peter);
    await users.persist();

    users.remove(peter);
    await users.persist();

    expect(await users.all().list()).toEqual([]);
    expect(await users.get(peter.uuid)).toBeNull();
  });

  it("caches query results and invalidates via the change feed on persist", async () => {
    const users = userRepo();
    users.save(users.createInstance({ firstName: "Peter", age: 35 }));
    await users.persist();

    const before = await users.all().list();
    expect(before).toHaveLength(1);

    users.save(users.createInstance({ firstName: "John", age: 40 }));
    await users.persist();

    const after = await users.all().list();
    expect(after).toHaveLength(2); // cache was invalidated by the saved-event
  });

  it("filters with a range expression", async () => {
    const users = userRepo();
    for (const [firstName, age] of [["A", 30], ["B", 20], ["C", 40]] as const) {
      users.save(users.createInstance({ firstName, age }));
    }
    await users.persist();
    const over25 = await users.all().filter(gt("age", 25)).list();
    expect(over25.map((u) => u.firstName).sort()).toEqual(["A", "C"]);
  });
});
