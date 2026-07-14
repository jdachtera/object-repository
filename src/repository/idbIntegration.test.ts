import { describe, it, expect } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { RepositoryManager } from "./RepositoryManager.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { text, integer } from "../properties/factories.js";
import { eq, gt } from "../expressions/builders.js";

let dbCounter = 0;
function idbManager(): { orm: RepositoryManager; backend: IndexedDBBackend } {
  const backend = new IndexedDBBackend({
    name: `repo-idb-${dbCounter++}`,
    factory: new IDBFactory(),
    keyRange: IDBKeyRange
  });
  return { orm: new RepositoryManager({ backend }), backend };
}

// The whole stack — typed define, property codecs, query compilation — running on IndexedDB.
describe("Repository over IndexedDBBackend", () => {
  it("defines a model, provisions indexes, and round-trips through the full stack", async () => {
    const { orm } = idbManager();
    const users = orm.define({
      name: "User",
      properties: { name: text({ index: true }), age: integer({ index: true }) }
    });

    users.save(users.createInstance({ name: "Peter", age: 35 }));
    users.save(users.createInstance({ name: "John", age: 40 }));
    users.save(users.createInstance({ name: "Jane", age: 25 }));
    await users.persist();

    const all = await users.all().list();
    expect(all).toHaveLength(3);

    const over30 = await users.all().filter(gt("age", 30)).sort("age").list();
    expect(over30.map((u) => u.name)).toEqual(["Peter", "John"]);

    const jane = await users.all().filter(eq("name", "Jane")).list();
    expect(jane.map((u) => u.age)).toEqual([25]);
  });

  it("persists to storage so a fresh manager on the same database reads it back", async () => {
    const backend = new IndexedDBBackend({
      name: `repo-idb-shared-${dbCounter++}`,
      factory: new IDBFactory(),
      keyRange: IDBKeyRange
    });

    const orm1 = new RepositoryManager({ backend });
    const writeUsers = orm1.define({ name: "User", properties: { name: text(), age: integer() } });
    writeUsers.save(writeUsers.createInstance({ name: "Peter", age: 35 }));
    await writeUsers.persist();

    const orm2 = new RepositoryManager({ backend });
    const readUsers = orm2.define({ name: "User", properties: { name: text(), age: integer() } });
    const loaded = await readUsers.all().list();
    expect(loaded.map((u) => u.name)).toEqual(["Peter"]);
    expect(loaded[0]!.age).toBe(35);
  });
});
