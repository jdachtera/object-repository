import { describe, it, expect } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "./indexeddb/IndexedDBBackend.js";
import { compileMongoFilter } from "./mongo/MongoBackend.js";
import { startsWith, endsWith, includesText } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";
import type { Expression } from "../expressions/index.js";

const ctx = SYSTEM_CONTEXT;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const songs = [
  { uuid: "s1", title: "Für Elise" },
  { uuid: "s2", title: "fur trader blues" },
  { uuid: "s3", title: "Prelude in C" },
  { uuid: "s4", title: "C-JAM blues" }
];

function plan(where: Expression): QueryPlan {
  return { model: "Song", where: where.serialize(), order: [], paging: { start: 0 } };
}

async function matches(
  makeBackend: () => InMemoryBackend | SQLiteBackend | IndexedDBBackend,
  where: Expression
): Promise<string[]> {
  const backend = makeBackend();
  for (const song of songs) backend.save("Song", song, ctx);
  await backend.persist(ctx);
  return (await backend.query(plan(where), ctx)).map((s) => String(s.uuid)).sort();
}

describe("text search runs identically across backends (§11)", () => {
  let idbSeq = 0;
  const backends: Array<[string, () => InMemoryBackend | SQLiteBackend | IndexedDBBackend]> = [
    ["in-memory", () => new InMemoryBackend()],
    ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))],
    ["IndexedDB", () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `textsearch-idb-${idbSeq++}` })]
  ];

  for (const [name, make] of backends) {
    it(`${name}: case-sensitive vs ASCII case-insensitive`, async () => {
      // case-sensitive substring
      expect(await matches(make, includesText("title", "blues"))).toEqual(["s2", "s4"]);
      // case-insensitive substring (ASCII): "C" matches both "C" occurrences
      expect(await matches(make, includesText("title", "JAM", { caseInsensitive: true }))).toEqual(["s4"]);
      expect(await matches(make, includesText("title", "jam"))).toEqual([]); // CS: no lowercase "jam"
      // prefix / suffix
      expect(await matches(make, startsWith("title", "Prelude"))).toEqual(["s3"]);
      expect(await matches(make, startsWith("title", "fur", { caseInsensitive: true }))).toEqual(["s2"]);
      expect(await matches(make, endsWith("title", "blues"))).toEqual(["s2", "s4"]);
      // ASCII folding does NOT fold non-ASCII: "fur" never matches "Für" (ü ≠ u)
      expect(await matches(make, includesText("title", "fur", { caseInsensitive: true }))).toEqual(["s2"]);
    });
  }

  it("Mongo compiles to an anchored $regex with ASCII char classes (not $options i)", () => {
    expect(compileMongoFilter(startsWith("title", "Pre").serialize())).toEqual({ title: { $regex: "^Pre" } });
    expect(compileMongoFilter(endsWith("title", "blues").serialize())).toEqual({ title: { $regex: "blues$" } });
    expect(compileMongoFilter(includesText("title", "a.b", { caseInsensitive: true }).serialize())).toEqual({
      title: { $regex: "[aA]\\.[bB]" } // letters → classes, "." escaped, no $options
    });
  });
});
