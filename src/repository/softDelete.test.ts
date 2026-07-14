import { describe, it, expect, expectTypeOf } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import "fake-indexeddb/auto";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { text, relationToOne } from "../properties/factories.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// A unique IndexedDB name per backend keeps the shared fake-indexeddb global isolated between tests.
let idbSeq = 0;
const makeIdb = () => new IndexedDBBackend({ name: `sd-${idbSeq++}` });

function runSuite(name: string, makeBackend: () => Backend) {
  describe(`softDelete: true on ${name}`, () => {
    const notes = () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      return orm.define({ name: "Note", properties: { title: text() }, softDelete: true });
    };

    it("remove() hides the row from list/count/get but keeps it in the store", async () => {
      const repo = notes();
      const a = repo.createInstance({ title: "a" });
      const b = repo.createInstance({ title: "b" });
      repo.save(a).save(b);
      await repo.persist();

      repo.remove(a);
      await repo.persist();

      expect((await repo.all().list()).map((n) => n.title)).toEqual(["b"]);
      expect(await repo.all().count()).toBe(1);
      expect(await repo.get(a.uuid)).toBeNull(); // hidden even though it was cached (eviction)

      // still present when explicitly included
      expect((await repo.all().includeDeleted().list()).map((n) => n.title).sort()).toEqual(["a", "b"]);
      expect(await repo.all().includeDeleted().count()).toBe(2);
    });

    it("stamps deletedAt (a Date) on remove and leaves it null/absent while live", async () => {
      const repo = notes();
      const a = repo.createInstance({ title: "a" });
      repo.save(a);
      await repo.persist();
      const [live] = await repo.all().list();
      expect(live!.deletedAt == null).toBe(true);

      repo.remove(a);
      await repo.persist();
      const [deleted] = await repo.all().includeDeleted().list();
      expect(deleted!.deletedAt).toBeInstanceOf(Date);
    });

    it("restore() brings a row back into default queries with fields intact", async () => {
      const repo = notes();
      const a = repo.createInstance({ title: "keep-me" });
      repo.save(a);
      await repo.persist();
      repo.remove(a);
      await repo.persist();
      expect(await repo.all().count()).toBe(0);

      const restored = await repo.restore(a.uuid);
      expect(restored!.title).toBe("keep-me");
      expect(restored!.deletedAt == null).toBe(true);
      expect((await repo.all().list()).map((n) => n.title)).toEqual(["keep-me"]);
      expect(await repo.get(a.uuid)).not.toBeNull();
    });

    it("hard-delete escape hatch truly removes the row", async () => {
      const repo = notes();
      const a = repo.createInstance({ title: "gone" });
      repo.save(a);
      await repo.persist();

      repo.remove(a, { hard: true });
      await repo.persist();
      expect(await repo.all().includeDeleted().count()).toBe(0); // not recoverable
    });

  });
}

runSuite("InMemory", () => new InMemoryBackend());
runSuite("SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:")));
runSuite("IndexedDB", makeIdb);

// The relation cold-read uses two managers over one backend; run it on the backends where that's
// straightforward (IndexedDB's per-manager schema upgrades race under the shared fake-indexeddb global).
for (const [name, makeBackend] of [
  ["InMemory", () => new InMemoryBackend()],
  ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))]
] as Array<[string, () => Backend]>) {
  it(`softDelete: a relationToOne to a soft-deleted target resolves to null on ${name} (cold read)`, async () => {
    const backend = makeBackend();
    const build = (mgr: RepositoryManager) => {
      const authors = mgr.define({ name: "Author", properties: { name: text() }, softDelete: true });
      const books = mgr.define({
        name: "Book",
        properties: { title: text(), author: relationToOne<{ uuid: string; name: string }>({ model: "Author" }) }
      });
      return { authors, books };
    };
    const w = build(new RepositoryManager({ backend }));
    const ada = w.authors.createInstance({ name: "Ada" });
    const book = w.books.createInstance({ title: "B", author: ada });
    w.authors.save(ada);
    w.books.save(book);
    await w.authors.persist();

    w.authors.remove(ada); // soft-delete the target
    await w.authors.persist();

    // cold manager → the relation loads from the backend, where the live filter hides the target
    const r = build(new RepositoryManager({ backend }));
    const loaded = await r.books.get(book.uuid);
    expect(loaded!.author).toBeNull();
  });
}

describe("softDelete typing", () => {
  it("adds deletedAt: Date | null to the instance type", () => {
    const orm = new RepositoryManager();
    const notes = orm.define({ name: "N", properties: { title: text() }, softDelete: true });
    const inst = notes.createInstance({ title: "t" });
    expectTypeOf(inst.deletedAt).toEqualTypeOf<Date | null>();
    expectTypeOf(inst.title).toEqualTypeOf<string>();

    const plain = orm.define({ name: "P", properties: { title: text() } });
    const plainInst = plain.createInstance({ title: "t" });
    // @ts-expect-error — no soft-delete, so no deletedAt on the instance
    plainInst.deletedAt;
  });
});
