/**
 * Opt-in pre-write unique check on the SQL/Mongo backends — raises the same driver-agnostic
 * `UniqueConstraintError` as the in-memory reference, before the write, instead of leaning on the DB
 * index to throw at write time. SQL behavior runs on pg-mem (a real unique index, so catching the
 * friendly error proves the pre-check fired first); a capturing fake asserts the SELECT is emitted.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { UniqueConstraintError } from "./util/unique.js";
import { text } from "../properties/factories.js";
import type { PgClient } from "./sql/PostgresBackend.js";

function memBackend(opts?: { uniquePreCheck?: boolean }) {
  const { Pool } = newDb().adapters.createPg();
  return new PostgresBackend(new Pool(), undefined, opts);
}

describe("pre-write unique check (SQL, opt-in) on pg-mem", () => {
  it("rejects a duplicate single-field unique value with UniqueConstraintError", async () => {
    const orm = new RepositoryManager({ backend: memBackend({ uniquePreCheck: true }) });
    const users = orm.define({ name: "u1", properties: { email: text({ unique: true }) } });
    users.save(users.createInstance({ email: "a@x.io" }));
    await users.persist();

    users.save(users.createInstance({ email: "a@x.io" }));
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await users.all().count()).toBe(1); // the conflicting write did not land
  });

  it("allows a distinct value and a re-save of the same uuid (no self-conflict)", async () => {
    const orm = new RepositoryManager({ backend: memBackend({ uniquePreCheck: true }) });
    const users = orm.define({ name: "u2", properties: { email: text({ unique: true }) } });
    const a = users.createInstance({ email: "a@x.io" });
    users.save(a);
    await users.persist();

    users.save(users.createInstance({ email: "b@x.io" })); // distinct → ok
    await users.persist();
    a.email = "a2@x.io"; // re-save same uuid, new value → ok
    users.save(a);
    await users.persist();
    expect(await users.all().count()).toBe(2);
  });

  it("catches a duplicate within a single batch", async () => {
    const orm = new RepositoryManager({ backend: memBackend({ uniquePreCheck: true }) });
    const users = orm.define({ name: "u3", properties: { email: text({ unique: true }) } });
    users.save(users.createInstance({ email: "dup@x.io" }));
    users.save(users.createInstance({ email: "dup@x.io" })); // same batch
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await users.all().count()).toBe(0); // nothing landed (thrown before any write)
  });

  it("treats NULL/absent unique values as distinct (not enforced)", async () => {
    const orm = new RepositoryManager({ backend: memBackend({ uniquePreCheck: true }) });
    const users = orm.define({ name: "u4", properties: { email: text({ unique: true }), name: text() } });
    users.save(users.createInstance({ name: "x" })); // email absent
    users.save(users.createInstance({ name: "y" })); // email absent — two NULLs are distinct
    await expect(users.persist()).resolves.toBeDefined();
    expect(await users.all().count()).toBe(2);
  });

  // Compound-key enforcement is verified on real Postgres in sqlIntegration.test.ts — pg-mem has an
  // internal btree bug on the compound pre-check SELECT (it works on a real engine).

  it("emits a pre-check SELECT when enabled, and none when disabled", async () => {
    const seen: string[] = [];
    const spy: PgClient = {
      query: async (sql: string) => {
        if (sql.includes("information_schema")) {
          return { rows: [{ column_name: "uuid" }, { column_name: "email" }, { column_name: "_extra" }] };
        }
        seen.push(sql);
        return { rows: [] }; // no conflict found
      }
    };
    const on = new RepositoryManager({ backend: new PostgresBackend(spy, undefined, { uniquePreCheck: true }) });
    const users = on.define({ name: "u6", properties: { email: text({ unique: true }) } });
    users.save(users.createInstance({ email: "a@x.io" }));
    await users.persist();
    expect(seen.some((s) => /SELECT uuid FROM "u6" WHERE uuid NOT IN/.test(s))).toBe(true);

    seen.length = 0;
    const off = new RepositoryManager({ backend: new PostgresBackend(spy) }); // no flag
    const users2 = off.define({ name: "u7", properties: { email: text({ unique: true }) } });
    users2.save(users2.createInstance({ email: "a@x.io" }));
    await users2.persist();
    expect(seen.some((s) => /SELECT uuid FROM .* WHERE uuid NOT IN/.test(s))).toBe(false);
  });
});
