/**
 * Cross-backend parity for absent (missing/null) and mixed-type fields — the property test the review
 * asked for. The in-memory reference and every compiled backend must return the *same* rows for a
 * battery of predicates over a fixture that includes rows with a missing field. Absent fields are
 * unordered (excluded from <, <=, >, >=) but still matched by != (Mongo semantics), so all engines agree.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "./indexeddb/IndexedDBBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { eq, neq, lt, lte, gt, gte, inList, notInList, not, and, or, isNull, isNotNull } from "../expressions/index.js";
import type { Backend } from "../core/Backend.js";
import type { Expression } from "../expressions/index.js";
import "fake-indexeddb/auto";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// rows a & d have an age; b & c leave it unset (absent)
const ROWS = [
  { uuid: "a", name: "Ann", age: 20 },
  { uuid: "b", name: "Bo" },
  { uuid: "c", name: "Cy" },
  { uuid: "d", name: "Di", age: 40 }
];

const QUERIES: Array<[string, Expression]> = [
  ["eq age 20", eq("age", 20)],
  ["neq age 20", neq("age", 20)], // absent rows match != (like Mongo $ne)
  ["lt age 30", lt("age", 30)], // absent excluded from ordering
  ["lte age 20", lte("age", 20)],
  ["gt age 30", gt("age", 30)],
  ["gte age 40", gte("age", 40)],
  ["in age [20,40]", inList("age", [20, 40])],
  ["nin age [20]", notInList("age", [20])], // absent included (like Mongo $nin)
  ["and(gt10, lt50)", and(gt("age", 10), lt("age", 50))],
  ["or(eq20, missing-safe)", or(eq("age", 20), eq("name", "Cy"))],
  ["isNull age", isNull("age")], // absent (b, c) match null-or-absent
  ["isNotNull age", isNotNull("age")], // present-non-null (a, d)
  ["not(isNull age)", not(isNull("age"))]
];

const idsFor = async (mk: () => Backend, expr: Expression): Promise<string[]> => {
  const orm = new RepositoryManager({ backend: mk() });
  const people = orm.define({ name: "P", properties: { name: text(), age: integer() } });
  for (const r of ROWS) people.save(people.createInstance(r));
  await people.persist();
  return (await people.all().filter(expr).list()).map((p) => p.uuid).sort();
};

describe("null/absent-field parity across backends", () => {
  const backends: Array<[string, () => Backend]> = [
    ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))],
    ["IndexedDB", () => new IndexedDBBackend()]
  ];

  for (const [label, expr] of QUERIES) {
    it(`"${label}" matches the reference on every backend`, async () => {
      const reference = await idsFor(() => new InMemoryBackend(), expr);
      for (const [name, mk] of backends) {
        expect(await idsFor(mk, expr), `${name} diverged on ${label}`).toEqual(reference);
      }
    });
  }

  it("absent fields are excluded from ordering but matched by !=", async () => {
    // pin the actual semantics, not just cross-backend agreement
    expect(await idsFor(() => new InMemoryBackend(), lt("age", 30))).toEqual(["a"]); // not b/c (absent)
    expect(await idsFor(() => new InMemoryBackend(), neq("age", 20))).toEqual(["b", "c", "d"]); // absent included
    expect(await idsFor(() => new InMemoryBackend(), not(eq("age", 20)))).toEqual(["b", "c", "d"]);
    expect(await idsFor(() => new InMemoryBackend(), isNull("age"))).toEqual(["b", "c"]); // absent = null-or-absent
    expect(await idsFor(() => new InMemoryBackend(), isNotNull("age"))).toEqual(["a", "d"]);
  });
});
