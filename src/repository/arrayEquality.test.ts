/**
 * Array-element equality: on a declared `array()` field, `eq(field, scalar)` means "the array contains
 * scalar" — Mongo's `{ field: scalar }` semantics — so a scalar-eq against an array field (the app's
 * `{ roles: 'ADMIN' }` idiom) matches membership rather than never matching. Scalar fields are
 * untouched. Verified on the reference and pushed-down backends via the Mongo compat facade too.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { text, integer, array } from "../properties/factories.js";
import { eq, neq } from "../expressions/index.js";
import { mongoCollection } from "../compat/mongo.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const seed = (backend: Backend) => {
  const orm = new RepositoryManager({ backend });
  const users = orm.define({ name: "u", properties: { name: text(), age: integer(), roles: array<string>() } });
  return users;
};

describe("array-element equality", () => {
  it("eq(arrayField, scalar) matches membership; scalar-field eq is unchanged", async () => {
    const run = async (backend: Backend) => {
      const users = seed(backend);
      users.save(users.createInstance({ name: "ann", age: 30, roles: ["ADMIN", "TESTER"] }));
      users.save(users.createInstance({ name: "bo", age: 30, roles: ["TESTER"] }));
      users.save(users.createInstance({ name: "cy", age: 40, roles: [] }));
      await users.persist();
      return {
        admins: (await users.all().filter(eq("roles", "ADMIN")).list()).map((u) => u.name).sort(),
        notAdmins: (await users.all().filter(neq("roles", "ADMIN")).list()).map((u) => u.name).sort(),
        age30: (await users.all().filter(eq("age", 30)).count()) // scalar eq still exact + push-down
      };
    };
    const mem = await run(new InMemoryBackend());
    const sql = await run(new SQLiteBackend(new DatabaseSync(":memory:")));
    expect(sql).toEqual(mem);
    expect(mem.admins).toEqual(["ann"]); // only ann's roles contains ADMIN
    expect(mem.notAdmins).toEqual(["bo", "cy"]); // membership negated (incl. empty)
    expect(mem.age30).toBe(2);
  });

  it("through the Mongo facade: { roles: 'ADMIN' } (the app's admin lookup)", async () => {
    const users = seed(new InMemoryBackend());
    const col = mongoCollection(users);
    await col.insertMany([
      { name: "ann", roles: ["ADMIN"] },
      { name: "bo", roles: ["TESTER"] }
    ] as never);
    expect(await col.countDocuments({ roles: "ADMIN" })).toBe(1);
    expect((await col.findOne({ roles: "ADMIN" }))!.name).toBe("ann");
  });
});
