import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { inc, mul, set, unset, push, addToSet, pull } from "./patch.js";
import { eq, exists, gt, field, mul as mulExpr, cond, cmp } from "../expressions/index.js";
import { text, integer, array } from "../properties/factories.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function runSuite(name: string, makeBackend: () => Backend) {
  describe(`patch() on ${name}`, () => {
    it("atomically increments, multiplies, and sets fields", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const accounts = orm.define({ name: "Account", properties: { balance: integer(), tier: text() } });

      const account = accounts.createInstance({ balance: 100, tier: "bronze" });
      accounts.save(account);
      await accounts.persist();

      const updated = await accounts.patch(account.uuid, { balance: inc(10), tier: set("gold") });
      expect(updated!.balance).toBe(110);
      expect(updated!.tier).toBe("gold");

      const again = await accounts.patch(account.uuid, { balance: mul(2) });
      expect(again!.balance).toBe(220);

      // persisted, not just in the returned instance
      const [reloaded] = await accounts.all().list();
      expect(reloaded!.balance).toBe(220);
    });

    it("sets a field from a computed value expression (server-side, snapshot of the pre-patch row)", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const lines = orm.define({ name: "Line", properties: { price: integer(), qty: integer(), total: integer(), tier: text() } });

      const line = lines.createInstance({ price: 10, qty: 3, total: 0, tier: "" });
      lines.save(line);
      await lines.persist();

      // total = price * qty ; tier = price >= 10 ? "bulk" : "single" — both from the original row
      const updated = await lines.patch(line.uuid, {
        total: set(mulExpr(field("price"), field("qty"))),
        tier: set(cond(cmp(field("price"), ">=", 10), "bulk", "single"))
      });
      expect(updated!.total).toBe(30);
      expect(updated!.tier).toBe("bulk");

      const [reloaded] = await lines.all().list();
      expect(reloaded!.total).toBe(30);
      expect(reloaded!.tier).toBe("bulk");
    });

    it("push / addToSet / pull mutate an array field", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const users = orm.define({ name: "User", properties: { name: text(), tags: array<string>() } });

      const user = users.createInstance({ name: "x", tags: ["a"] });
      users.save(user);
      await users.persist();

      expect((await users.patch(user.uuid, { tags: push("b", "c") }))!.tags).toEqual(["a", "b", "c"]);
      // addToSet skips values already present, appends new ones in order
      expect((await users.patch(user.uuid, { tags: addToSet("c", "d") }))!.tags).toEqual(["a", "b", "c", "d"]);
      // pull removes every matching value
      expect((await users.patch(user.uuid, { tags: pull("a", "c") }))!.tags).toEqual(["b", "d"]);

      const [reloaded] = await users.all().list();
      expect(reloaded!.tags).toEqual(["b", "d"]);
    });

    it("push onto a missing array field starts a new array", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const users = orm.define({ name: "User", properties: { name: text(), tags: array<string>() } });
      const user = users.createInstance({ name: "x", tags: [] });
      users.save(user);
      await users.persist();
      expect((await users.patch(user.uuid, { tags: push("first") }))!.tags).toEqual(["first"]);
    });

    it("unsets (removes) a field", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const accounts = orm.define({ name: "Account", properties: { balance: integer(), note: text() } });

      const account = accounts.createInstance({ balance: 100, note: "vip" });
      accounts.save(account);
      await accounts.persist();

      const updated = await accounts.patch(account.uuid, { note: unset() });
      expect(updated!.note).toBeUndefined();
      expect(updated!.balance).toBe(100); // other fields untouched

      // The key is actually removed, not set to null — `exists(false)` is what tells them apart,
      // and it agrees across the native (json_remove) and fallback (delete) paths.
      expect(await accounts.all().filter(exists("note", false)).listUuids()).toEqual([account.uuid]);
      expect(await accounts.all().filter(exists("note")).listUuids()).toEqual([]);
    });

    it("sequential increments accumulate correctly (counter)", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const counters = orm.define({ name: "Counter", properties: { n: integer() } });
      const counter = counters.createInstance({ n: 0 });
      counters.save(counter);
      await counters.persist();

      for (let i = 0; i < 5; i++) await counters.patch(counter.uuid, { n: inc(1) });
      const [reloaded] = await counters.all().list();
      expect(reloaded!.n).toBe(5);
    });

    it("patchWhere mutates every matching record (and only those), returning the count", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const items = orm.define({ name: "Item", properties: { stock: integer(), status: text() } });
      for (const [stock, status] of [[0, "ok"], [5, "ok"], [0, "ok"]] as const) {
        items.save(items.createInstance({ stock, status }));
      }
      await items.persist();

      const n = await items.patchWhere(eq("stock", 0), { status: set("oos") });
      expect(n).toBe(2);

      const oos = await items.all().filter(eq("status", "oos")).list();
      expect(oos.map((i) => i.stock)).toEqual([0, 0]);
      expect((await items.all().filter(eq("status", "ok")).list()).map((i) => i.stock)).toEqual([5]);

      // atomic arithmetic applies across the whole matched set
      const bumped = await items.patchWhere(gt("stock", 0), { stock: inc(100) });
      expect(bumped).toBe(1);
      expect((await items.all().filter(eq("status", "ok")).list())[0]!.stock).toBe(105);
    });

    it("returns null when the record does not exist", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const accounts = orm.define({ name: "Account", properties: { balance: integer(), tier: text() } });
      expect(await accounts.patch("missing", { balance: inc(1) })).toBeNull();
    });
  });
}

// Native atomic path (SQL json_set arithmetic) and read-modify-write fallback (in-memory, IndexedDB).
let idb = 0;
runSuite("SQLiteBackend (native)", () => new SQLiteBackend(new DatabaseSync(":memory:")));
runSuite("InMemoryBackend (fallback)", () => new InMemoryBackend());
runSuite(
  "IndexedDBBackend (fallback)",
  () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `patch-idb-${idb++}` })
);
