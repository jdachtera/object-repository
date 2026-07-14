/**
 * Parity for the filter ops surfaced by the query-surface benchmark — `exists`, `size`, `nin` — across the
 * three local backends. SQLite pushes them down (json_type / json_array_length / NOT IN); in-memory and
 * IndexedDB evaluate them on a scan. The point of this suite is that all three agree, edge cases included
 * (null counts as present, missing field is absent, size 0 ≠ missing, NOT IN matches a missing field).
 */
import { describe, it, expect } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "./indexeddb/IndexedDBBackend.js";
import { exists, size, notInList } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";
import type { Backend } from "../core/Backend.js";

const ctx = SYSTEM_CONTEXT;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function plan(model: string, where: QueryPlan["where"]): QueryPlan {
  return { model, where, order: [], paging: { start: 0 } };
}

function runSuite(name: string, makeBackend: () => Backend) {
  describe(`exists / size / nin parity on ${name}`, () => {
    it("`exists` treats null as present and a missing field as absent", async () => {
      const backend = makeBackend();
      backend.save("Doc", { uuid: "d1", publishAt: 100 }, ctx); // present
      backend.save("Doc", { uuid: "d2", publishAt: null }, ctx); // present, null
      backend.save("Doc", { uuid: "d3", title: "draft" }, ctx); // absent
      await backend.persist(ctx);

      const present = await backend.query(plan("Doc", exists("publishAt").serialize()), ctx);
      expect(present.map((d) => d.uuid).sort()).toEqual(["d1", "d2"]);
      const absent = await backend.query(plan("Doc", exists("publishAt", false).serialize()), ctx);
      expect(absent.map((d) => d.uuid)).toEqual(["d3"]);
    });

    it("`size` matches only real arrays of that length (0 ≠ missing)", async () => {
      const backend = makeBackend();
      backend.save("Doc", { uuid: "d1", tags: ["a", "b"] }, ctx);
      backend.save("Doc", { uuid: "d2", tags: ["a"] }, ctx);
      backend.save("Doc", { uuid: "d3", tags: [] }, ctx);
      backend.save("Doc", { uuid: "d4", title: "no tags" }, ctx); // missing
      await backend.persist(ctx);

      expect((await backend.query(plan("Doc", size("tags", 2).serialize()), ctx)).map((d) => d.uuid)).toEqual(["d1"]);
      expect((await backend.query(plan("Doc", size("tags", 0).serialize()), ctx)).map((d) => d.uuid)).toEqual(["d3"]);
    });

    it("`nin` (notInList) matches a missing field", async () => {
      const backend = makeBackend();
      backend.save("U", { uuid: "a", role: "admin" }, ctx);
      backend.save("U", { uuid: "b", role: "user" }, ctx);
      backend.save("U", { uuid: "c" }, ctx); // role absent → matches NOT IN
      await backend.persist(ctx);

      const out = await backend.query(plan("U", notInList("role", ["admin"]).serialize()), ctx);
      expect(out.map((u) => u.uuid).sort()).toEqual(["b", "c"]);
    });
  });
}

let idbSeq = 0;
runSuite("InMemoryBackend", () => new InMemoryBackend());
runSuite("SQLiteBackend", () => new SQLiteBackend(new DatabaseSync(":memory:")));
runSuite(
  "IndexedDBBackend",
  () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `newfilters-idb-${idbSeq++}` })
);
