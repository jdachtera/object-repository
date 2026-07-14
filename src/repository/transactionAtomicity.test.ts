/**
 * Transaction atomicity: an immediately-persisting write (`patch`/`patchWhere`/`upsert`) must not
 * *silently* escape a transaction, and decorators must forward rollback (`discardPending`). Before
 * these fixes, a `patch` inside a write-batching transaction committed despite a rollback, and a
 * PolicyBackend/HooksBackend swallowed the rollback entirely.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { PolicyBackend } from "../backends/decorators/PolicyBackend.js";
import { HooksBackend } from "../backends/decorators/HooksBackend.js";
import { text, integer } from "../properties/factories.js";
import { inc } from "./patch.js";
import { eq } from "../expressions/builders.js";

describe("patch/upsert refuse to escape a write-batching transaction", () => {
  const setup = () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const accts = orm.define({ name: "Acct", properties: { name: text(), balance: integer() } });
    return { orm, accts };
  };

  it("patch() inside a transaction throws instead of committing unrollbackable-y", async () => {
    const { orm, accts } = setup();
    const a = accts.createInstance({ name: "A", balance: 100 });
    accts.save(a);
    await accts.persist();

    await expect(
      orm.transaction(async () => {
        await accts.patch(a.uuid, { balance: inc(10) });
      })
    ).rejects.toThrow(/non-transactional backend/);

    // the transaction rolled back cleanly: no partial write survived
    expect((await accts.get(a.uuid))!.balance).toBe(100);
  });

  it("upsert() and patchWhere() inside a transaction throw too", async () => {
    const { orm, accts } = setup();
    await expect(orm.transaction(async () => void (await accts.upsert(eq("name", "X"), { set: { balance: 1 } })))).rejects.toThrow(/non-transactional/);
    await expect(orm.transaction(async () => void (await accts.patchWhere(eq("name", "X"), { balance: inc(1) })))).rejects.toThrow(/non-transactional/);
  });

  it("save()/remove() inside a transaction still work (only immediate-persist writes are blocked)", async () => {
    const { orm, accts } = setup();
    await orm.transaction(async () => {
      accts.save(accts.createInstance({ name: "A", balance: 1 }));
      accts.save(accts.createInstance({ name: "B", balance: 2 }));
    });
    expect(await accts.all().count()).toBe(2);
  });

  it("patch() outside any transaction is unaffected", async () => {
    const { accts } = setup();
    const a = accts.createInstance({ name: "A", balance: 100 });
    accts.save(a);
    await accts.persist();
    await accts.patch(a.uuid, { balance: inc(5) });
    expect((await accts.get(a.uuid))!.balance).toBe(105);
  });
});

describe("decorators forward transaction rollback (discardPending)", () => {
  it("PolicyBackend: a rolled-back write does not commit on the next persist", async () => {
    const backend = new PolicyBackend(new InMemoryBackend(), { read: () => null, write: () => true });
    const orm = new RepositoryManager({ backend });
    const users = orm.define({ name: "User", properties: { name: text() } });

    await expect(
      orm.transaction(async () => {
        users.save(users.createInstance({ name: "ghost" }));
        throw new Error("rollback");
      })
    ).rejects.toThrow(/rollback/);

    users.save(users.createInstance({ name: "real" }));
    await users.persist();
    expect((await users.all().list()).map((u) => u.name)).toEqual(["real"]); // ghost was discarded
  });

  it("HooksBackend: same — rollback is honored", async () => {
    const backend = new HooksBackend(new InMemoryBackend(), {});
    const orm = new RepositoryManager({ backend });
    const users = orm.define({ name: "User", properties: { name: text() } });

    await expect(
      orm.transaction(async () => {
        users.save(users.createInstance({ name: "ghost" }));
        throw new Error("rollback");
      })
    ).rejects.toThrow(/rollback/);

    users.save(users.createInstance({ name: "real" }));
    await users.persist();
    expect((await users.all().list()).map((u) => u.name)).toEqual(["real"]);
  });
});
