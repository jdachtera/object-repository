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

    expect(await orm.migrate(migrations)).toEqual({ applied: ["0001_create", "0002_add_color"], skipped: [] });
    // both columns exist now — a raw insert/select round-trips through them
    await orm.raw({ sql: `INSERT INTO "widgets" ("uuid", "size", "color", "_extra") VALUES ($1, $2, $3, $4)`, params: ["w1", 5, "red", null] });
    expect(await orm.raw<{ color: string }>({ sql: `SELECT "color" FROM "widgets"` })).toEqual([{ color: "red" }]);

    // second run applies nothing
    expect(await orm.migrate(migrations)).toEqual({ applied: [], skipped: ["0001_create", "0002_add_color"] });
  });

  it("only applies the newly-added migration when the set grows", async () => {
    const orm = pgManager();
    const first: Migration = { name: "0001", up: (m) => m.createTable("t", [{ name: "n", type: "integer" }]) };
    const second: Migration = { name: "0002", up: (m) => m.addColumn("t", "extra_flag", "boolean") };
    await orm.migrate([first]);
    expect(await orm.migrate([first, second])).toEqual({ applied: ["0002"], skipped: ["0001"] });
  });

  it("renames, retypes, and backfills through the sql() escape hatch", async () => {
    const orm = pgManager();
    await orm.migrate([{ name: "init", up: (m) => m.createTable("people", [{ name: "years", type: "integer" }]) }]);
    await orm.raw({ sql: `INSERT INTO "people" ("uuid", "years", "_extra") VALUES ($1, $2, $3)`, params: ["p1", 30, null] });

    const report = await orm.migrate([
      { name: "init", up: () => {} }, // already applied → skipped
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
    expect(await orm.rollback(migrations)).toEqual({ applied: ["add_col"], skipped: [] });
    await expect(orm.raw({ sql: `SELECT "note" FROM "g"` })).rejects.toThrow();

    // it's pending again, so a migrate re-applies just that one
    expect(await orm.migrate(migrations)).toEqual({ applied: ["add_col"], skipped: ["base"] });
  });

  it("skips rollback of a migration without a down()", async () => {
    const orm = pgManager();
    const migrations: Migration[] = [{ name: "irreversible", up: (m) => m.createTable("z", [{ name: "n", type: "integer" }]) }];
    await orm.migrate(migrations);
    expect(await orm.rollback(migrations)).toEqual({ applied: [], skipped: ["irreversible"] });
  });

  it("forwards through a PolicyBackend to the inner store", async () => {
    const { Pool } = newDb().adapters.createPg();
    const orm = new RepositoryManager({ backend: new PolicyBackend(new PostgresBackend(new Pool()), {}) });
    expect(await orm.migrate([{ name: "m1", up: (m) => m.createTable("p", [{ name: "n", type: "integer" }]) }])).toEqual({
      applied: ["m1"],
      skipped: []
    });
  });
});

describe("migrations — errors and non-SQL backends", () => {
  it("throws on a backend without migration support (in-memory)", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    await expect(orm.migrate([])).rejects.toThrow(/does not support migrations/);
    await expect(orm.rollback([])).rejects.toThrow(/does not support migrations/);
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
