import { describe, it, expect, vi } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { text, integer } from "../properties/factories.js";
import { eq } from "../expressions/index.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function runSuite(name: string, makeBackend: () => Backend) {
  describe(`upsert() on ${name}`, () => {
    it("inserts when nothing matches, updates when it does", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const users = orm.define({
        name: "User",
        properties: { email: text({ unique: true }), name: text(), logins: integer() }
      });

      // insert: set + setOnInsert both apply to the new record
      const created = await users.upsert(eq("email", "a@x.com"), {
        set: { name: "Ann" },
        setOnInsert: { email: "a@x.com", logins: 0 }
      });
      expect(created.name).toBe("Ann");
      expect(created.logins).toBe(0);
      expect(await users.all().count()).toBe(1);

      // update by the same key: set applies, setOnInsert is ignored, same record (uuid)
      const updated = await users.upsert(eq("email", "a@x.com"), {
        set: { name: "Annie" },
        setOnInsert: { logins: 999 }
      });
      expect(updated.uuid).toBe(created.uuid);
      expect(updated.name).toBe("Annie");
      expect(updated.logins).toBe(0); // setOnInsert ignored on update
      expect(await users.all().count()).toBe(1);
    });

    it("auto-stamps createdAt on insert and bumps updatedAt on update (with timestamps)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const orm = new RepositoryManager({ backend: makeBackend() });
        const songs = orm.define({ name: "Song", properties: { slug: text({ unique: true }), title: text() }, timestamps: true });

        vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
        const a = await songs.upsert(eq("slug", "fur-elise"), { set: { title: "Für Elise" }, setOnInsert: { slug: "fur-elise" } });
        const created = a.createdAt;
        expect(created).toBeInstanceOf(Date);
        expect(a.updatedAt).toEqual(created);

        vi.setSystemTime(new Date("2024-05-01T00:00:00Z"));
        const b = await songs.upsert(eq("slug", "fur-elise"), { set: { title: "Fur Elise" } });
        expect(b.uuid).toBe(a.uuid);
        expect(b.createdAt).toEqual(created); // preserved
        expect(b.updatedAt!.getTime()).toBeGreaterThan(created!.getTime());
      } finally {
        vi.useRealTimers();
      }
    });
  });
}

let idb = 0;
runSuite("in-memory", () => new InMemoryBackend());
runSuite("SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:")));
runSuite("IndexedDB", () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `upsert-idb-${idb++}` }));
