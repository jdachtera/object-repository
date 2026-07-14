/**
 * Batched writes: `persist` groups queued saves/removes by model into multi-row `INSERT` /
 * `DELETE … IN (…)` statements (chunked under a row cap) instead of one round-trip per row. The SQL
 * shape and chunking are asserted against a capturing fake; correctness is checked on pg-mem.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { text, integer } from "../properties/factories.js";
import { gt } from "../expressions/index.js";
import type { FieldSpec } from "../core/Backend.js";

const ctx = SYSTEM_CONTEXT;
const FIELDS: FieldSpec[] = [{ name: "n", type: "integer" }];

/** Records the statements (and one representative param count) that reach the driver. */
class SpyPg {
  statements: Array<{ verb: string; params: number }> = [];
  async query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql.includes("information_schema")) return { rows: [{ column_name: "uuid" }, { column_name: "n" }, { column_name: "_extra" }] };
    this.statements.push({ verb: sql.split(/\s|\(/)[0]!.toUpperCase(), params: params.length });
    return { rows: [] };
  }
  // no connect() → runs without a transaction, so we see the writes directly
}

describe("batched writes", () => {
  it("collapses many same-model saves into one multi-row INSERT", async () => {
    const pg = new SpyPg();
    const be = new PostgresBackend(pg);
    await be.registerModel("T", [], FIELDS);
    pg.statements.length = 0;

    for (let i = 0; i < 3; i++) be.save("T", { uuid: `u${i}`, n: i }, ctx);
    await be.persist(ctx);

    const inserts = pg.statements.filter((s) => s.verb === "INSERT");
    expect(inserts).toHaveLength(1); // three rows, one statement
    expect(inserts[0]!.params).toBe(3 * 3); // 3 rows × (uuid, n, _extra)
  });

  it("chunks past the row cap into multiple statements", async () => {
    const pg = new SpyPg();
    const be = new PostgresBackend(pg);
    await be.registerModel("T", [], FIELDS);
    pg.statements.length = 0;

    for (let i = 0; i < 1200; i++) be.save("T", { uuid: `u${i}`, n: i }, ctx);
    await be.persist(ctx);

    // 1200 rows / 500-per-chunk → 3 INSERTs
    expect(pg.statements.filter((s) => s.verb === "INSERT")).toHaveLength(3);
  });

  it("batches removes into a single DELETE … IN (…)", async () => {
    const pg = new SpyPg();
    const be = new PostgresBackend(pg);
    await be.registerModel("T", [], FIELDS);
    pg.statements.length = 0;

    be.remove("T", { uuid: "a" }, ctx);
    be.remove("T", { uuid: "b" }, ctx);
    await be.persist(ctx);

    const deletes = pg.statements.filter((s) => s.verb === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.params).toBe(2);
  });

  it("persists a batch correctly across models (pg-mem)", async () => {
    const { Pool } = newDb().adapters.createPg();
    const orm = new RepositoryManager({ backend: new PostgresBackend(new Pool()) });
    const users = orm.define({ name: "batch_users", properties: { name: text(), age: integer() } });
    const logs = orm.define({ name: "batch_logs", properties: { msg: text() } });

    await orm.transaction(async () => {
      for (let i = 0; i < 50; i++) users.save(users.createInstance({ name: `u${i}`, age: i }));
      logs.save(logs.createInstance({ msg: "hello" }));
    }); // both models' batches flush atomically

    expect(await users.all().count()).toBe(50);
    expect(await logs.all().count()).toBe(1);
    expect((await users.all().filter(gt("age", 47)).list()).map((u) => u.name).sort()).toEqual(["u48", "u49"]);
  });
});
