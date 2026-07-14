import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { text, integer } from "../properties/factories.js";

describe("RepositoryManager.transaction", () => {
  it("flushes everything the callback queued as one unit", async () => {
    const orm = new RepositoryManager();
    const accounts = orm.define({ name: "Account", properties: { owner: text(), balance: integer() } });

    await orm.transaction(async () => {
      accounts.save(accounts.createInstance({ owner: "a", balance: 100 }));
      accounts.save(accounts.createInstance({ owner: "b", balance: 0 }));
    });

    expect(await accounts.all().count()).toBe(2); // both committed together, no explicit persist()
  });

  it("persists nothing and discards queued writes when the callback throws", async () => {
    const orm = new RepositoryManager();
    const accounts = orm.define({ name: "Account", properties: { owner: text(), balance: integer() } });

    await expect(
      orm.transaction(async () => {
        accounts.save(accounts.createInstance({ owner: "a", balance: 100 }));
        throw new Error("business rule violated");
      })
    ).rejects.toThrow(/business rule/);

    // the queued write was discarded — a later persist must not resurrect it
    expect(await accounts.all().count()).toBe(0);
    await accounts.persist();
    expect(await accounts.all().count()).toBe(0);
  });

  it("is a no-op-safe wrapper on a backend without transactions (in-memory)", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const items = orm.define({ name: "Item", properties: { name: text() } });
    const result = await orm.transaction(async () => {
      items.save(items.createInstance({ name: "x" }));
      return "done";
    });
    expect(result).toBe("done");
    expect(await items.all().count()).toBe(1);
  });

  it("commits an atomic batch through a real SQL transaction (pg-mem)", async () => {
    const { Pool } = newDb().adapters.createPg();
    const orm = new RepositoryManager({ backend: new PostgresBackend(new Pool()) });
    const events = orm.define({ name: "tx_events", properties: { kind: text(), amount: integer() } });

    await orm.transaction(async () => {
      events.save(events.createInstance({ kind: "debit", amount: 10 }));
      events.save(events.createInstance({ kind: "credit", amount: 10 }));
    });
    expect(await events.all().count()).toBe(2);
    expect(await events.all().aggregate((a) => ({ total: a.sum("amount") }))).toEqual({ total: 20 });
  });
});
