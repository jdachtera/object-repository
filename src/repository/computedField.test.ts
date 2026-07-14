import { describe, it, expect, expectTypeOf } from "vitest";
import { newDb } from "pg-mem";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { text, integer, computed } from "../properties/factories.js";
import { eq } from "../expressions/index.js";
import type { Model } from "./Repository.js";

function personRepo(backend = new InMemoryBackend()) {
  const orm = new RepositoryManager({ backend });
  const people = orm.define({
    name: "Person",
    properties: {
      first: text(),
      last: text(),
      age: integer(),
      fullName: computed<string>((row) => `${row.first} ${row.last}`),
      isAdult: computed<boolean>((row) => (row.age as number) >= 18)
    }
  });
  return { orm, people, backend };
}

describe("computed / virtual fields", () => {
  it("materializes on read from the instance's other fields", async () => {
    const { people } = personRepo();
    const p = people.createInstance({ first: "Ada", last: "Lovelace", age: 36 });
    expect(p.fullName).toBe("Ada Lovelace"); // available immediately at createInstance
    expect(p.isAdult).toBe(true);
    people.save(p);
    await people.persist();

    const [loaded] = await people.all().list();
    expect(loaded!.fullName).toBe("Ada Lovelace");
    expect(loaded!.isAdult).toBe(true);
  });

  it("recomputes on read after a source field changes", async () => {
    const backend = new InMemoryBackend();
    const { people } = personRepo(backend);
    const p = people.createInstance({ first: "Grace", last: "H", age: 40 });
    people.save(p);
    await people.persist();

    p.last = "Hopper";
    people.save(p);
    await people.persist();

    // Cold read through a fresh manager — the value is derived, not stored.
    const { people: cold } = personRepo(backend);
    const [loaded] = await cold.all().list();
    expect(loaded!.fullName).toBe("Grace Hopper");
  });

  it("is never persisted — no column on the SQL table and not in _extra", async () => {
    const { Pool } = newDb().adapters.createPg();
    const pool = new Pool();
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool.query(t, p);
      }
    } as never);
    const orm = new RepositoryManager({ backend: spy });
    const people = orm.define({
      name: "cperson",
      properties: { first: text(), last: text(), fullName: computed<string>((r) => `${r.first} ${r.last}`) }
    });
    const p = people.createInstance({ first: "Ada", last: "L" });
    people.save(p);
    await people.persist();

    const createTable = seen.find((s) => s.includes("CREATE TABLE"))!;
    expect(createTable).toContain('"first"');
    expect(createTable).toContain('"last"');
    expect(createTable).not.toContain("fullName"); // no column for the computed field

    // The written row's _extra overflow must not carry the computed value either.
    const raw = await pool.query('SELECT "_extra" FROM "cperson"');
    const extra = raw.rows[0]!._extra;
    expect(extra == null || !String(extra).includes("fullName")).toBe(true);

    // It still materializes on read.
    const [loaded] = await people.all().list();
    expect(loaded!.fullName).toBe("Ada L");
  });

  it("rejects sorting or filtering by a computed field with a clear error", async () => {
    const { people } = personRepo();
    people.save(people.createInstance({ first: "A", last: "B", age: 20 }));
    await people.persist();

    await expect(people.all().sort("fullName" as never).list()).rejects.toThrow(/computed field "fullName"/);
    await expect(people.all().filter(eq("fullName", "A B")).list()).rejects.toThrow(/computed field "fullName"/);
    await expect(people.all().filter(eq("isAdult", true)).count()).rejects.toThrow(/computed field "isAdult"/);
  });

  it("infers the computed field's type into the model", () => {
    const { people } = personRepo();
    type Person = Model<typeof people>;
    expectTypeOf<Person["fullName"]>().toEqualTypeOf<string>();
    expectTypeOf<Person["isAdult"]>().toEqualTypeOf<boolean>();
    const p = people.createInstance({ first: "x", last: "y", age: 1 });
    expectTypeOf(p.fullName).toEqualTypeOf<string>();
  });
});
