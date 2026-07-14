/**
 * Additive schema migration for the columnar SQL backends: when a model gains a field, provisioning
 * an existing table introspects its columns and `ALTER TABLE ADD COLUMN`s the missing ones. Behavior
 * is checked on pg-mem (which supports ALTER + information_schema); the exact ALTER SQL and the
 * "already present → no-op" case are checked against a capturing fake.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { MySqlBackend } from "./sql/MySqlBackend.js";
import { text, integer } from "../properties/factories.js";
import { eq } from "../expressions/index.js";
import type { FieldSpec } from "../core/Backend.js";

describe("additive column migration", () => {
  it("adds a newly-declared column to an existing table and keeps old rows readable (pg-mem)", async () => {
    const { Pool } = newDb().adapters.createPg(); // both managers share the one in-memory db

    // v1: the model has only `name`
    const v1 = new RepositoryManager({ backend: new PostgresBackend(new Pool()) });
    const usersV1 = v1.define({ name: "users_mig", properties: { name: text() } });
    usersV1.save(usersV1.createInstance({ name: "Ann" }));
    await usersV1.persist();

    // v2: same table, now declaring `age` → provisioning ALTERs ADD COLUMN "age"
    const v2 = new RepositoryManager({ backend: new PostgresBackend(new Pool()) });
    const usersV2 = v2.define({ name: "users_mig", properties: { name: text(), age: integer() } });
    usersV2.save(usersV2.createInstance({ name: "Bo", age: 40 }));
    await usersV2.persist();

    const [bo] = await usersV2.all().filter(eq("name", "Bo")).list();
    expect(bo!.age).toBe(40); // the new column stores and reads back
    const [ann] = await usersV2.all().filter(eq("name", "Ann")).list();
    expect(ann!.name).toBe("Ann"); // old row still there
    expect(ann!.age).toBeUndefined(); // its new column is NULL → omitted
    expect(await usersV2.all().count()).toBe(2);
  });

  it("emits ALTER only for the missing column, and nothing when all are present", async () => {
    class MigPg {
      altered: string[] = [];
      existing: string[] = [];
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        if (sql.includes("information_schema")) return { rows: this.existing.map((c) => ({ column_name: c })) };
        if (sql.startsWith("ALTER")) this.altered.push(sql);
        return { rows: [] };
      }
    }
    const fields: FieldSpec[] = [{ name: "name", type: "text" }, { name: "age", type: "integer" }];

    // `age` is missing on the existing table → exactly one ALTER, for `age`
    const missing = new MigPg();
    missing.existing = ["uuid", "name", "_extra"];
    await new PostgresBackend(missing).registerModel("M", [], fields);
    expect(missing.altered).toEqual([`ALTER TABLE "M" ADD COLUMN "age" bigint`]);

    // everything already present → no ALTER at all
    const present = new MigPg();
    present.existing = ["uuid", "name", "age", "_extra"];
    await new PostgresBackend(present).registerModel("M", [], fields);
    expect(present.altered).toEqual([]);

    // MySQL emits its own ALTER dialect (backticks, `DATABASE()`-scoped introspection)
    class MigMy {
      altered: string[] = [];
      existing = ["uuid", "name", "_extra"];
      async query(sql: string): Promise<[Record<string, unknown>[], unknown]> {
        if (sql.includes("information_schema")) return [this.existing.map((c) => ({ column_name: c })), []];
        if (sql.startsWith("ALTER")) this.altered.push(sql);
        return [[], []];
      }
    }
    const my = new MigMy();
    await new MySqlBackend(my as never).registerModel("M", [], fields);
    expect(my.altered).toEqual(["ALTER TABLE `M` ADD COLUMN `age` bigint"]);
  });
});
