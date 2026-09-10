/**
 * Versioned migrations: `orm.migrate` applies each not-yet-applied migration once (tracked in
 * `_object_repository_migrations`), running its recorded DDL + backfills; `orm.rollback` reverts via `down`. The
 * full lifecycle runs behaviorally on pg-mem; the MySQL DDL (no in-process engine) is asserted as the
 * exact statement stream against a capturing fake, alongside the Postgres stream.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { PolicyBackend } from "./decorators/PolicyBackend.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { runMigrations, rollbackMigrations, MIGRATIONS_TABLE } from "./sql/migrate.js";
import type { Migration } from "./sql/migrate.js";
import { postgresDialect, mysqlDialect } from "./sql/dialect.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import type { SqlExecutor } from "./sql/SqlBackend.js";
import type { MigrationBuilder } from "../migrations/types.js";
import { text } from "../properties/factories.js";
import { all } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

function pgManager() {
  const { Pool } = newDb().adapters.createPg();
  return new RepositoryManager({ backend: new PostgresBackend(new Pool()) });
}

/** Records every statement a runner emits (and answers the tracking SELECT from an in-memory set). */
class SpyExec implements SqlExecutor {
  readonly log: string[] = [];
  private readonly applied = new Set<string>();
  async run(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (/information_schema/i.test(sql)) return []; // introspection probe — plumbing, not logged
    this.log.push(sql);
    if (/^SELECT .* FROM .+_object_repository_migrations/i.test(sql)) return [...this.applied].map((name) => ({ name }));
    if (/^INSERT INTO .+_object_repository_migrations/i.test(sql)) this.applied.add(String(params[0]));
    if (/^DELETE FROM .+_object_repository_migrations/i.test(sql)) this.applied.delete(String(params[0]));
    return [];
  }
  verbs(): string[] {
    return this.log.map((s) => s.trim().split(/\s|\(/)[0]!.toUpperCase());
  }
}

describe("migrations — lifecycle (pg-mem)", () => {
  it("applies pending migrations in order, and is a no-op on re-run", async () => {
    const orm = pgManager();
    const migrations: Migration[] = [
      { name: "0001_create", up: (m) => m.createTable("widgets", [{ name: "size", type: "integer" }]) },
      { name: "0002_add_color", up: (m) => m.addColumn("widgets", "color", "text") }
    ];

    expect(await orm.migrate(migrations)).toMatchObject({ applied: ["0001_create", "0002_add_color"], skipped: [] });
    // both columns exist now — a raw insert/select round-trips through them
    await orm.raw({ sql: `INSERT INTO "widgets" ("uuid", "size", "color", "_extra") VALUES ($1, $2, $3, $4)`, params: ["w1", 5, "red", null] });
    expect(await orm.raw<{ color: string }>({ sql: `SELECT "color" FROM "widgets"` })).toEqual([{ color: "red" }]);

    // second run applies nothing
    expect(await orm.migrate(migrations)).toMatchObject({ applied: [], skipped: ["0001_create", "0002_add_color"] });
  });

  it("only applies the newly-added migration when the set grows", async () => {
    const orm = pgManager();
    const first: Migration = { name: "0001", up: (m) => m.createTable("t", [{ name: "n", type: "integer" }]) };
    const second: Migration = { name: "0002", up: (m) => m.addColumn("t", "extra_flag", "boolean") };
    await orm.migrate([first]);
    expect(await orm.migrate([first, second])).toMatchObject({ applied: ["0002"], skipped: ["0001"] });
  });

  it("renames, retypes, and backfills through the sql() escape hatch", async () => {
    const orm = pgManager();
    await orm.migrate([{ name: "init", up: (m) => m.createTable("people", [{ name: "years", type: "integer" }]) }]);
    await orm.raw({ sql: `INSERT INTO "people" ("uuid", "years", "_extra") VALUES ($1, $2, $3)`, params: ["p1", 30, null] });

    const report = await orm.migrate([
      // Re-declared with its original body: an already-applied migration is skipped, but changing one
      // after the fact is now a CHECKSUM_DRIFT blocker, so it can't be stubbed out to `() => {}`.
      { name: "init", up: (m) => m.createTable("people", [{ name: "years", type: "integer" }]) },
      { name: "rename_years", up: (m) => m.renameColumn("people", "years", "age") },
      { name: "widen_age", up: (m) => m.alterColumnType("people", "age", "float") },
      { name: "add_and_backfill", up: (m) => { m.addColumn("people", "status", "text"); m.sql(`UPDATE "people" SET "status" = 'legacy'`); } }
    ]);

    expect(report.applied).toEqual(["rename_years", "widen_age", "add_and_backfill"]);
    expect(report.skipped).toEqual(["init"]);
    expect(await orm.raw<{ age: number; status: string }>({ sql: `SELECT "age", "status" FROM "people"` })).toEqual([
      { age: 30, status: "legacy" }
    ]);
  });

  it("rolls back the most recent migrations via down(), and re-applies afterwards", async () => {
    const orm = pgManager();
    const migrations: Migration[] = [
      { name: "base", up: (m) => m.createTable("g", [{ name: "n", type: "integer" }]) },
      {
        name: "add_col",
        up: (m) => m.addColumn("g", "note", "text"),
        down: (m) => m.dropColumn("g", "note")
      }
    ];
    await orm.migrate(migrations);

    // rollback the last one — the column is dropped and the tracking row removed
    expect(await orm.rollback(migrations)).toMatchObject({ applied: ["add_col"], skipped: [] });
    await expect(orm.raw({ sql: `SELECT "note" FROM "g"` })).rejects.toThrow();

    // it's pending again, so a migrate re-applies just that one
    expect(await orm.migrate(migrations)).toMatchObject({ applied: ["add_col"], skipped: ["base"] });
  });

  it("skips rollback of a migration without a down()", async () => {
    const orm = pgManager();
    const migrations: Migration[] = [{ name: "irreversible", up: (m) => m.createTable("z", [{ name: "n", type: "integer" }]) }];
    await orm.migrate(migrations);
    expect(await orm.rollback(migrations)).toMatchObject({ applied: [], skipped: ["irreversible"] });
  });

  it("forwards through a PolicyBackend to the inner store", async () => {
    const { Pool } = newDb().adapters.createPg();
    const orm = new RepositoryManager({ backend: new PolicyBackend(new PostgresBackend(new Pool()), {}) });
    expect(await orm.migrate([{ name: "m1", up: (m) => m.createTable("p", [{ name: "n", type: "integer" }]) }])).toMatchObject({
      applied: ["m1"],
      skipped: []
    });
  });
});

describe("adopting an already-deployed database's history", () => {
  it("does not re-apply migrations recorded in the original tracking table", async () => {
    const { Pool } = newDb().adapters.createPg();
    const backend = new PostgresBackend(new Pool());
    const orm = new RepositoryManager({ backend });

    // Stand in for a database migrated under the previous SQL-only mechanism: the table exists and
    // names a migration that has already run, but the portable journal has never seen it.
    await orm.raw({ sql: `CREATE TABLE "${MIGRATIONS_TABLE}" ("name" text PRIMARY KEY, "applied_at" bigint)` });
    await orm.raw({ sql: `INSERT INTO "${MIGRATIONS_TABLE}" ("name", "applied_at") VALUES ($1, $2)`, params: ["0001_create", 1] });
    await orm.raw({ sql: `CREATE TABLE "widgets" ("uuid" text PRIMARY KEY, "size" bigint, "_extra" jsonb)` });
    await orm.raw({ sql: `INSERT INTO "widgets" ("uuid", "size", "_extra") VALUES ($1, $2, $3)`, params: ["w1", 5, null] });

    // Re-running it would CREATE TABLE over live data; it must be recognised as already applied.
    const report = await orm.migrate([
      { name: "0001_create", up: (m) => m.createTable("widgets", [{ name: "size", type: "integer" }]) },
      { name: "0002_add_color", up: (m) => m.addColumn("widgets", "color", "text") }
    ]);

    expect(report.skipped).toEqual(["0001_create"]);
    expect(report.applied).toEqual(["0002_add_color"]);
    expect(await orm.raw<{ size: number }>({ sql: `SELECT "size" FROM "widgets"` })).toEqual([{ size: 5 }]);
  });

  it("leaves the original tracking table untouched, as the operator's record", async () => {
    const { Pool } = newDb().adapters.createPg();
    const orm = new RepositoryManager({ backend: new PostgresBackend(new Pool()) });
    await orm.raw({ sql: `CREATE TABLE "${MIGRATIONS_TABLE}" ("name" text PRIMARY KEY, "applied_at" bigint)` });
    await orm.raw({ sql: `INSERT INTO "${MIGRATIONS_TABLE}" ("name", "applied_at") VALUES ($1, $2)`, params: ["old", 1] });

    await orm.migrate([{ name: "new", up: (m) => m.createTable("t", [{ name: "n", type: "integer" }]) }]);

    expect(await orm.raw<{ name: string }>({ sql: `SELECT "name" FROM "${MIGRATIONS_TABLE}"` })).toEqual([{ name: "old" }]);
  });

  it("adopts nothing on a greenfield database", async () => {
    const orm = pgManager();
    const report = await orm.migrate([{ name: "m1", up: (m) => m.createTable("t", [{ name: "n", type: "integer" }]) }]);
    expect(report.applied).toEqual(["m1"]);
  });
});

describe("migrations — errors and non-SQL backends", () => {
  it("runs on a backend with no DDL at all, rewriting records instead", async () => {
    // This used to throw "does not support migrations". A store without DDL still holds data that
    // needs changing, and silently doing nothing there was the bug this replaces.
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const users = orm.define({ name: "User", properties: { name: text() } });
    users.save(users.createInstance({ uuid: "u1", name: "Ann" }));
    await users.persist();

    const report = await orm.migrate([
      { name: "0001_rename", up: (m) => m.renameField("User", "name", "fullName", "text") }
    ]);
    expect(report.applied).toEqual(["0001_rename"]);

    const rows = await backend.query(
      { model: "User", where: all().serialize(), order: [], paging: { start: 0 } },
      SYSTEM_CONTEXT
    );
    expect(rows).toEqual([{ uuid: "u1", fullName: "Ann" }]);
  });

  it("is idempotent there too", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    orm.define({ name: "User", properties: { name: text() } });
    const migrations = [{ name: "0001", up: (m: MigrationBuilder) => m.addField("User", "tier", "text", { fill: "free" }) }];

    await orm.migrate(migrations);
    expect((await orm.migrate(migrations)).skipped).toEqual(["0001"]);
  });

  it("rejects a duplicate migration name", async () => {
    const orm = pgManager();
    await expect(
      orm.migrate([
        { name: "dup", up: () => {} },
        { name: "dup", up: () => {} }
      ])
    ).rejects.toThrow(/Duplicate migration name/);
  });
});

describe("migrations — MySQL DDL statement stream (capturing fake)", () => {
  it("emits backtick MySQL DDL for every operation, wrapped by the tracking table + insert", async () => {
    const exec = new SpyExec();
    const migration: Migration = {
      name: "0001_all_ops",
      up: (m) => {
        m.createTable("Song", [{ name: "plays", type: "integer" }]);
        m.addColumn("Song", "title", "text");
        m.renameColumn("Song", "title", "name");
        m.alterColumnType("Song", "plays", "float");
        m.createIndex("Song", "by_name", ["name"], true, { name: "text" }); // TEXT column → (255) prefix
        m.dropIndex("Song", "by_name");
        m.dropColumn("Song", "name");
        m.dropTable("Song");
        m.sql("UPDATE `Song` SET `plays` = 0");
      }
    };
    // now() is injected so the runner never touches Date.now — pass a fixed stamp.
    const report = await runMigrations(exec, mysqlDialect, [migration], () => 1234);
    expect(report).toEqual({ applied: ["0001_all_ops"], skipped: [] });

    const ddl = exec.log.filter((s) => !/_object_repository_migrations/.test(s));
    expect(ddl).toEqual([
      "CREATE TABLE IF NOT EXISTS `Song` (`uuid` varchar(64) PRIMARY KEY, `plays` bigint, `_extra` longtext) COLLATE=utf8mb4_bin",
      "ALTER TABLE `Song` ADD COLUMN `title` text",
      "ALTER TABLE `Song` RENAME COLUMN `title` TO `name`",
      "ALTER TABLE `Song` MODIFY COLUMN `plays` double",
      "CREATE UNIQUE INDEX `by_name` ON `Song` (`name`(255))",
      "DROP INDEX `by_name` ON `Song`",
      "ALTER TABLE `Song` DROP COLUMN `name`",
      "DROP TABLE IF EXISTS `Song`",
      "UPDATE `Song` SET `plays` = 0"
    ]);

    // The tracking table is created first and the migration recorded (positional `?`, MySQL types).
    expect(exec.log[0]).toBe(
      "CREATE TABLE IF NOT EXISTS `_object_repository_migrations` (`name` varchar(64) PRIMARY KEY, `applied_at` bigint)"
    );
    expect(exec.log.at(-1)).toBe("INSERT INTO `_object_repository_migrations` (`name`, `applied_at`) VALUES (?, ?)");
  });

  it("Postgres renumbers the tracking insert placeholders and deletes on rollback", async () => {
    const exec = new SpyExec();
    const migration: Migration = {
      name: "m",
      up: (m) => m.addColumn("t", "c", "text"),
      down: (m) => m.dropColumn("t", "c")
    };
    await runMigrations(exec, postgresDialect, [migration], () => 1);
    expect(exec.log.some((s) => s === `INSERT INTO "${MIGRATIONS_TABLE}" ("name", "applied_at") VALUES ($1, $2)`)).toBe(true);

    exec.log.length = 0;
    const report = await rollbackMigrations(exec, postgresDialect, [migration], 1);
    expect(report).toEqual({ applied: ["m"], skipped: [] });
    expect(exec.log).toContain(`ALTER TABLE "t" DROP COLUMN "c"`);
    expect(exec.log).toContain(`DELETE FROM "${MIGRATIONS_TABLE}" WHERE "name" = $1`);
  });
});
