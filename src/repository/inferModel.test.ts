import { describe, it, expectTypeOf } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import type { Model } from "./Repository.js";
import { text, integer, boolean } from "../properties/factories.js";

describe("Model<> type extraction (the z.infer of this ORM)", () => {
  it("infers the model type from a define() call, no manual interface", () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { name: text(), age: integer(), active: boolean() } });

    type User = Model<typeof users>;
    expectTypeOf<User["uuid"]>().toEqualTypeOf<string>();
    expectTypeOf<User["name"]>().toEqualTypeOf<string>();
    expectTypeOf<User["age"]>().toEqualTypeOf<number>();
    expectTypeOf<User["active"]>().toEqualTypeOf<boolean>();

    // createInstance / query results are already typed by the same inference
    const u = users.createInstance({ name: "Ada", age: 36, active: true });
    expectTypeOf(u.age).toEqualTypeOf<number>();
  });
});
