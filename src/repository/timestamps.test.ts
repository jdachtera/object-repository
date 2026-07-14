import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { text, integer } from "../properties/factories.js";
import { inc } from "./patch.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function runSuite(name: string, makeBackend: () => Backend) {
  describe(`timestamps: true on ${name}`, () => {
    it("sets createdAt once and updatedAt on every save (persisted as Dates)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const orm = new RepositoryManager({ backend: makeBackend() });
        const posts = orm.define({ name: "Post", properties: { title: text() }, timestamps: true });

        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
        const post = posts.createInstance({ title: "hello" });
        expect(post.createdAt).toBeUndefined(); // not stamped until the first save

        posts.save(post);
        await posts.persist();
        const created = post.createdAt;
        expect(created).toBeInstanceOf(Date);
        expect(post.updatedAt).toEqual(created);

        // re-save later → updatedAt advances, createdAt is preserved
        vi.setSystemTime(new Date("2024-02-01T00:00:00Z"));
        post.title = "hi";
        posts.save(post);
        await posts.persist();
        expect(post.createdAt).toEqual(created);
        expect(post.updatedAt!.getTime()).toBeGreaterThan(created!.getTime());

        // round-trips through the backend (stored epoch ms → decoded Date)
        const [reloaded] = await posts.all().list();
        expect(reloaded!.createdAt).toEqual(created);
        expect(reloaded!.updatedAt).toEqual(post.updatedAt);
      } finally {
        vi.useRealTimers();
      }
    });

    it("patch bumps updatedAt without touching createdAt", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const orm = new RepositoryManager({ backend: makeBackend() });
        const posts = orm.define({ name: "Post", properties: { title: text(), views: integer() }, timestamps: true });

        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
        const post = posts.createInstance({ title: "x", views: 0 });
        posts.save(post);
        await posts.persist();
        const created = post.createdAt!;

        vi.setSystemTime(new Date("2024-03-01T00:00:00Z"));
        const updated = await posts.patch(post.uuid, { views: inc(1) });
        expect(updated!.views).toBe(1);
        expect(updated!.createdAt).toEqual(created);
        expect(updated!.updatedAt!.getTime()).toBeGreaterThan(created.getTime());
      } finally {
        vi.useRealTimers();
      }
    });
  });
}

let idb = 0;
runSuite("in-memory", () => new InMemoryBackend());
runSuite("SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:")));
runSuite("IndexedDB", () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `ts-idb-${idb++}` }));

describe("timestamps typing", () => {
  it("adds createdAt / updatedAt: Date to the inferred model type", () => {
    const orm = new RepositoryManager();
    const posts = orm.define({ name: "Post", properties: { title: text() }, timestamps: true });
    const post = posts.createInstance({ title: "x" });
    expectTypeOf(post.title).toEqualTypeOf<string>();
    expectTypeOf(post.createdAt).toEqualTypeOf<Date>();
    expectTypeOf(post.updatedAt).toEqualTypeOf<Date>();
  });

  it("does not add timestamp fields without the option", () => {
    const orm = new RepositoryManager();
    const posts = orm.define({ name: "Plain", properties: { title: text() } });
    const post = posts.createInstance({ title: "x" });
    // @ts-expect-error createdAt is not part of a model defined without timestamps
    void post.createdAt;
  });
});
