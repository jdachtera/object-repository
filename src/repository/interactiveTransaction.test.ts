/**
 * Interactive transactions: `orm.transaction(async (tx) => …)` hands the callback a `tx` scope whose
 * repositories read and write on the transaction's own connection, so a write it persists is visible
 * to a later read *before* commit. Happy paths run behaviorally on pg-mem; the rollback statement
 * sequence is asserted against a capturing fake (pg-mem doesn't actually revert on ROLLBACK).
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { text, integer } from "../properties/factories.js";
import type { Model } from "./Repository.js";

function pgManager() {
  const { Pool } = newDb().adapters.createPg();
  return new RepositoryManager({ backend: new PostgresBackend(new Pool()) });
}

describe("interactive transactions", () => {
  it("a tx read sees a write the same tx already persisted, and it commits", async () => {
    const orm = pgManager();
    const accounts = orm.define({ name: "Account", properties: { owner: text(), balance: integer() } });

    await orm.transaction(async (tx) => {
      const scoped = tx.repository<typeof accounts>("Account");
      scoped.save(scoped.createInstance({ owner: "a", balance: 100 }));
      await scoped.persist();
      expect(await scoped.all().count()).toBe(1); // visible within the transaction
    });

    expect(await accounts.all().count()).toBe(1); // committed, seen by the outer repository
  });

  it("supports read-modify-write against uncommitted state (the canonical use case)", async () => {
    const orm = pgManager();
    const accounts = orm.define({ name: "Account", properties: { owner: text(), balance: integer() } });
    await orm.transaction(async () => accounts.save(accounts.createInstance({ owner: "a", balance: 100 })));

    await orm.transaction(async (tx) => {
      const scoped = tx.repository<typeof accounts>("Account");
      const acct = (await scoped.all().list())[0]!;
      scoped.save({ ...acct, balance: (acct.balance as number) - 30 });
      await scoped.persist();
      const reread = (await scoped.all().list())[0]! as Model<typeof accounts>;
      expect(reread.balance).toBe(70); // the uncommitted update is visible to the re-read
    });

    const final = (await accounts.all().list())[0]! as Model<typeof accounts>;
    expect(final.balance).toBe(70);
  });

  it("folds writes made through the outer repositories into the same transaction", async () => {
    const orm = pgManager();
    const accounts = orm.define({ name: "Account", properties: { owner: text(), balance: integer() } });

    await orm.transaction(async (tx) => {
      accounts.save(accounts.createInstance({ owner: "outer", balance: 1 })); // queued on the outer backend
      const scoped = tx.repository<typeof accounts>("Account");
      scoped.save(scoped.createInstance({ owner: "inner", balance: 2 }));
      await scoped.persist();
    });

    expect(await accounts.all().count()).toBe(2); // both the outer and the tx write committed together
  });

  it("rolls back and re-throws when the callback throws (capturing fake)", async () => {
    const log: string[] = [];
    const verb = (sql: string) => sql.split(/\s|\(/)[0]!.toUpperCase();
    class FakePg {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        if (sql.includes("information_schema")) return { rows: [{ column_name: "uuid" }, { column_name: "n" }, { column_name: "_extra" }] };
        log.push(verb(sql));
        return { rows: [] };
      }
      async connect() {
        return { query: (sql: string) => this.query(sql), release: () => log.push("RELEASE") };
      }
    }
    const orm = new RepositoryManager({ backend: new PostgresBackend(new FakePg()) });
    const items = orm.define({ name: "T", properties: { n: integer() } });

    await expect(
      orm.transaction(async (tx) => {
        const scoped = tx.repository<typeof items>("T");
        scoped.save(scoped.createInstance({ n: 1 }));
        await scoped.persist();
        throw new Error("business rule");
      })
    ).rejects.toThrow(/business rule/);

    expect(log).toEqual(["BEGIN", "INSERT", "ROLLBACK", "RELEASE"]); // no COMMIT
  });

  it("degrades to a working (non-isolated) scope on a backend without transactions", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const items = orm.define({ name: "Item", properties: { name: text() } });

    const out = await orm.transaction(async (tx) => {
      const scoped = tx.repository<typeof items>("Item");
      scoped.save(scoped.createInstance({ name: "x" }));
      return "ok";
    });

    expect(out).toBe("ok");
    expect(await items.all().count()).toBe(1); // batched flush still persisted the tx-scope write
  });
});
