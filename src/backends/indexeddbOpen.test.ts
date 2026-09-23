/**
 * Regression: the IndexedDB open/upgrade path.
 *
 * Three independent traps, all on the way to a usable database:
 *  - `hasAllStores` compared store *names* only, so an index declared for an already-created store
 *    never triggered a version bump and was never built — every query that would have used it
 *    silently degraded to a full scan.
 *  - `registerModel` was first-registration-wins, but `save`/`remove` register with an empty index
 *    list to guarantee the store exists. A write landing before `define()` therefore froze the model
 *    at zero indexes.
 *  - `open()` registered no `onblocked`, so an upgrade held up by another connection never settled
 *    and every awaiting caller hung forever.
 */
import { describe, it, expect } from "vitest";
import { IndexedDBBackend, SchemaUpgradeBlockedError } from "./indexeddb/IndexedDBBackend.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all } from "../expressions/index.js";
import type { IndexSpec } from "../core/Backend.js";
import "fake-indexeddb/auto";

const ctx = SYSTEM_CONTEXT;
let seq = 0;
const dbName = () => `idb-open-${seq++}-${Date.now()}`;

const byName: IndexSpec = { name: "by_name", fields: [{ path: "name" }] };
const byAge: IndexSpec = { name: "by_age", fields: [{ path: "age" }] };

/** The index names IndexedDB actually built for a store. */
async function builtIndexes(backend: IndexedDBBackend, model: string): Promise<string[]> {
  // Any read forces the database open; then inspect through a fresh connection of our own.
  await backend.query({ model, where: all().serialize(), order: [], paging: { start: 0 } }, ctx);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open((backend as unknown as { name: string }).name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const list = db.transaction(model, "readonly").objectStore(model).indexNames;
  const names: string[] = [];
  for (let i = 0; i < list.length; i++) names.push(list.item(i)!);
  db.close();
  return names.sort();
}

describe("IndexedDB schema provisioning", () => {
  it("creates an index declared for a store that already exists", async () => {
    const name = dbName();
    const first = new IndexedDBBackend({ name });
    first.registerModel("User", [byName]);
    expect(await builtIndexes(first, "User")).toEqual(["by_name"]);

    // A later build declares one more index on the same model.
    const second = new IndexedDBBackend({ name });
    second.registerModel("User", [byName, byAge]);
    expect(await builtIndexes(second, "User")).toEqual(["by_age", "by_name"]);
  });

  it("a write before define() does not freeze the model at zero indexes", async () => {
    const name = dbName();
    const backend = new IndexedDBBackend({ name });

    // `save` registers the model with an empty index list to guarantee the store exists...
    backend.save("User", { uuid: "u1", name: "Ann" }, ctx);
    await backend.persist(ctx);
    // ...and `define()` follows with the real specs, which must not be discarded.
    backend.registerModel("User", [byName]);

    expect(await builtIndexes(backend, "User")).toEqual(["by_name"]);
  });

  it("an empty registration never removes indexes already declared", async () => {
    const name = dbName();
    const backend = new IndexedDBBackend({ name });
    backend.registerModel("User", [byName]);
    backend.registerModel("User", []); // e.g. a subsequent save()

    expect(await builtIndexes(backend, "User")).toEqual(["by_name"]);
  });

  it("an upgrade blocked by another open connection rejects instead of hanging", async () => {
    const name = dbName();

    // Hold a connection open at version 1 that refuses to yield: no `versionchange` self-close.
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("Held", { keyPath: "uuid" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const backend = new IndexedDBBackend({ name });
    backend.registerModel("User", [byName]); // needs a new store ⇒ a version bump ⇒ blocked

    await expect(
      backend.query({ model: "User", where: all().serialize(), order: [], paging: { start: 0 } }, ctx)
    ).rejects.toThrow(SchemaUpgradeBlockedError);

    holder.close();
  });

  it("a backend that opened the database yields to a peer's upgrade", async () => {
    const name = dbName();
    const first = new IndexedDBBackend({ name });
    first.registerModel("User", [byName]);
    await builtIndexes(first, "User"); // first holds an open connection

    // A peer needing a new store must not be blocked: `first`'s connection self-closes.
    const second = new IndexedDBBackend({ name });
    second.registerModel("Post", []);
    await expect(
      second.query({ model: "Post", where: all().serialize(), order: [], paging: { start: 0 } }, ctx)
    ).resolves.toEqual([]);
  });
});

describe("IndexedDB connection lifecycle", () => {
  const readAll = (backend: IndexedDBBackend, model: string) =>
    backend.query({ model, where: all().serialize(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctx);

  it("keeps working after yielding to a peer's upgrade, instead of failing on the closed connection", async () => {
    const name = dbName();
    const first = new IndexedDBBackend({ name });
    first.save("User", { uuid: "u1", name: "Ann" }, ctx);
    await first.persist(ctx);

    const peer = new IndexedDBBackend({ name });
    peer.registerModel("Post", []);
    await readAll(peer, "Post"); // bumps the version; `first` closes its connection

    first.save("User", { uuid: "u2", name: "Bo" }, ctx);
    await first.persist(ctx);
    expect((await readAll(first, "User")).map((row) => row.uuid)).toEqual(["u1", "u2"]);
  });

  it("writes a batch whose persist was blocked, once the retry succeeds", async () => {
    const name = dbName();
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("Held", { keyPath: "uuid" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const backend = new IndexedDBBackend({ name });
    backend.save("User", { uuid: "u1", name: "Ann" }, ctx);
    await expect(backend.persist(ctx)).rejects.toThrow(SchemaUpgradeBlockedError);

    holder.close();
    await new Promise((resolve) => setTimeout(resolve, 10)); // the orphaned open request settles and closes
    await backend.persist(ctx); // the retry the error asks for
    expect((await readAll(backend, "User")).map((row) => row.uuid)).toEqual(["u1"]);
  });

  it("rebuilds an index redefined under the same name", async () => {
    const name = dbName();
    const backend = new IndexedDBBackend({ name });
    backend.registerModel("User", [{ name: "by_email", fields: [{ path: "email" }] }]);
    await readAll(backend, "User");

    const later = new IndexedDBBackend({ name });
    later.registerModel("User", [{ name: "by_email", fields: [{ path: "email" }], unique: true }]);
    later.save("User", { uuid: "u1", email: "a@x" }, ctx);
    later.save("User", { uuid: "u2", email: "a@x" }, ctx);
    await expect(later.persist(ctx)).rejects.toThrow(); // the unique definition is in force
  });
});
