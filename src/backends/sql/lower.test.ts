/**
 * Lowering the portable op IR to SQL: the exact statements per dialect, and — just as important —
 * which operations decline so the portable executor rewrites rows instead.
 */
import { describe, it, expect } from "vitest";
import { lowerToSql, changesColumns } from "./lower.js";
import { postgresDialect, mysqlDialect } from "./dialect.js";
import type { MigrationOp } from "../../migrations/types.js";

const present = new Set(["uuid", "name", "fullName", "age"]);
const sqlFor = (op: MigrationOp, columns = present): string[] =>
  (lowerToSql(op, postgresDialect, columns) ?? []).map((statement) => statement.sql);

describe("lowering to Postgres", () => {
  it("creates a table with its indexes", () => {
    expect(
      sqlFor({
        kind: "createModel",
        model: "User",
        fields: [{ name: "name", type: "text" }],
        indexes: [{ name: "by_name", fields: [{ path: "name" }] }]
      })
    ).toEqual([
      `CREATE TABLE IF NOT EXISTS "User" ("uuid" text PRIMARY KEY, "name" text, "_extra" text)`,
      `CREATE INDEX IF NOT EXISTS "User_by_name" ON "User" ("name")` // scoped: index names are schema-global
    ]);
  });

  it("creates a table's indexes the way provisioning does: table-scoped, and prefix-lengthed on MySQL", () => {
    const op: MigrationOp = {
      kind: "createModel",
      model: "User",
      fields: [{ name: "email", type: "text" }],
      indexes: [
        { name: "email", fields: [{ path: "email" }], unique: true },
        { name: "nested", fields: [{ path: "profile.city" }] } // no column: skipped, as provisioning skips it
      ]
    };
    expect((lowerToSql(op, mysqlDialect, new Set()) ?? []).map((s) => s.sql).slice(1)).toEqual([
      "CREATE UNIQUE INDEX `User_email` ON `User` (`email`(255))"
    ]);
  });

  it("renames a column as metadata rather than rewriting rows", () => {
    expect(
      sqlFor({ kind: "renameField", model: "User", from: "name", to: "fullName", type: "text" }, new Set(["uuid", "name"]))
    ).toEqual([`ALTER TABLE "User" RENAME COLUMN "name" TO "fullName"`]);
  });

  it("declines a rename onto a column that already exists, which would fail or clobber", () => {
    expect(lowerToSql({ kind: "renameField", model: "User", from: "name", to: "fullName", type: "text" }, postgresDialect, present)).toBeNull();
  });

  it("adds only the fill when the column is already there — auto-provisioned, or from an interrupted attempt", () => {
    const statements = lowerToSql(
      { kind: "addField", model: "User", field: "age", type: "integer", fill: 0 },
      postgresDialect,
      present
    )!;
    expect(statements.map((statement) => statement.sql)).toEqual([`UPDATE "User" SET "age" = $1 WHERE "age" IS NULL`]);
    expect(lowerToSql({ kind: "addField", model: "User", field: "age", type: "integer" }, postgresDialect, present)).toEqual([]);
  });

  it("declines addField when the table doesn't exist yet, so the reference provisions it", () => {
    expect(lowerToSql({ kind: "addField", model: "User", field: "tier", type: "text" }, postgresDialect, new Set())).toBeNull();
  });

  it("drops, retypes and indexes", () => {
    expect(sqlFor({ kind: "dropField", model: "User", field: "name" })).toEqual([`ALTER TABLE "User" DROP COLUMN "name"`]);
    expect(sqlFor({ kind: "retypeField", model: "User", field: "age", from: "integer", to: "float" })).toEqual([
      `ALTER TABLE "User" ALTER COLUMN "age" TYPE double precision`
    ]);
    // The physical name provisioning gives it: Postgres index names are schema-global.
    expect(sqlFor({ kind: "dropIndex", model: "User", index: "by_name" })).toEqual([`DROP INDEX IF EXISTS "User_by_name"`]);
    expect(sqlFor({ kind: "dropModel", model: "User" })).toEqual([`DROP TABLE IF EXISTS "User"`]);
  });

  it("adds a column, and backfills it only where unset", () => {
    const statements = lowerToSql(
      { kind: "addField", model: "User", field: "tier", type: "text", fill: "free" },
      postgresDialect,
      present
    )!;
    expect(statements[0]!.sql).toBe(`ALTER TABLE "User" ADD COLUMN "tier" text`);
    expect(statements[1]!.sql).toBe(`UPDATE "User" SET "tier" = $1 WHERE "tier" IS NULL`);
    expect(statements[1]!.params).toEqual(["free"]);
  });

  it("copies a field as one set-based UPDATE, with the overwrite polarity in the WHERE clause", () => {
    // Both guards mirror the reference exactly: it skips a record whose source is absent, and a NULL
    // column decodes as absent — so `IS NOT NULL` is the same condition, expressed in SQL.
    expect(sqlFor({ kind: "copyField", model: "User", from: "name", to: "fullName", type: "text", overwrite: false })).toEqual([
      `UPDATE "User" SET "fullName" = "name" WHERE "fullName" IS NULL AND "name" IS NOT NULL`
    ]);
    expect(sqlFor({ kind: "copyField", model: "User", from: "name", to: "fullName", type: "text", overwrite: true })).toEqual([
      `UPDATE "User" SET "fullName" = "name" WHERE "name" IS NOT NULL`
    ]);
  });

  it("passes raw SQL through with its params", () => {
    const [statement] = lowerToSql(
      { kind: "rawSql", dialect: "*", statement: "UPDATE x SET y = ?", params: [1], phase: "expand" },
      postgresDialect,
      present
    )!;
    expect(statement).toEqual({ sql: "UPDATE x SET y = ?", params: [1] });
  });
});

describe("declining", () => {
  it("declines a field op whose column does not exist", () => {
    // A relation or an undeclared field lives in the `_extra` JSON overflow — there is no column to
    // alter, and emitting DDL against one would simply throw. The portable executor handles it.
    const absent = new Set(["uuid"]);
    expect(lowerToSql({ kind: "dropField", model: "User", field: "customer" }, postgresDialect, absent)).toBeNull();
    expect(lowerToSql({ kind: "renameField", model: "User", from: "a", to: "b", type: "text" }, postgresDialect, absent)).toBeNull();
    expect(lowerToSql({ kind: "retypeField", model: "User", field: "a", to: "text" }, postgresDialect, absent)).toBeNull();
    expect(
      lowerToSql({ kind: "copyField", model: "User", from: "a", to: "b", type: "text", overwrite: false }, postgresDialect, absent)
    ).toBeNull();
  });

  it("declines a transform, which has no SQL form", () => {
    expect(lowerToSql({ kind: "transform", model: "User", transform: "t", fields: [] }, postgresDialect, present)).toBeNull();
  });

  it("declines raw SQL written for another engine", () => {
    const op: MigrationOp = { kind: "rawSql", dialect: "mysql", statement: "SELECT 1", params: [], phase: "expand" };
    expect(lowerToSql(op, postgresDialect, present)).toBeNull();
    expect(lowerToSql(op, mysqlDialect, present)).not.toBeNull();
  });

  it("declines Mongo-only index kinds", () => {
    expect(
      lowerToSql({ kind: "addIndex", model: "User", index: { name: "i", fields: [{ path: "a" }], text: true } }, postgresDialect, present)
    ).toBeNull();
    expect(
      lowerToSql(
        { kind: "addIndex", model: "User", index: { name: "i", fields: [{ path: "a" }], ttlSeconds: 60 } },
        postgresDialect,
        present
      )
    ).toBeNull();
  });
});

describe("lowering to MySQL", () => {
  it("uses backticks and carries index column types for the key-length prefix", () => {
    const [statement] = lowerToSql(
      {
        kind: "addIndex",
        model: "Song",
        index: { name: "by_name", fields: [{ path: "name" }], unique: true },
        columnTypes: { name: "text" }
      },
      mysqlDialect,
      present
    )!;
    expect(statement!.sql).toBe("CREATE UNIQUE INDEX `Song_by_name` ON `Song` (`name`(255))");
  });

  it("prefixes an index over a TEXT column from the live column types when the op carries none", () => {
    const [statement] = lowerToSql(
      { kind: "addIndex", model: "Song", index: { name: "by_name", fields: [{ path: "name" }] } },
      mysqlDialect,
      present,
      new Map([["name", "text"]])
    )!;
    expect(statement!.sql).toBe("CREATE INDEX `Song_by_name` ON `Song` (`name`(255))");
  });

  it("declines an index over a nested path or a field with no column", () => {
    for (const path of ["address.city", "notAColumn"]) {
      expect(lowerToSql({ kind: "addIndex", model: "Song", index: { name: "i", fields: [{ path }] } }, mysqlDialect, present)).toBeNull();
    }
  });

  it("folds a name that isn't an identifier", () => {
    const [statement] = lowerToSql(
      { kind: "addIndex", model: "Song", index: { name: "songId-userId", fields: [{ path: "name" }] } },
      mysqlDialect,
      present
    )!;
    expect(statement!.sql).toContain("`Song_songId_userId`");
  });

  it("modifies rather than alters a column type", () => {
    const [statement] = lowerToSql(
      { kind: "retypeField", model: "Song", field: "age", from: "integer", to: "float" },
      mysqlDialect,
      present
    )!;
    expect(statement!.sql).toBe("ALTER TABLE `Song` MODIFY COLUMN `age` double");
  });
});

describe("changesColumns", () => {
  it("flags exactly the ops that move a table's column set", () => {
    const moves: MigrationOp[] = [
      { kind: "addField", model: "M", field: "a", type: "text" },
      { kind: "dropField", model: "M", field: "a" },
      { kind: "renameField", model: "M", from: "a", to: "b", type: "text" },
      { kind: "retypeField", model: "M", field: "a", to: "text" },
      { kind: "createModel", model: "M", fields: [] },
      { kind: "dropModel", model: "M" }
    ];
    for (const op of moves) expect(changesColumns(op)).toBe(true);

    const stable: MigrationOp[] = [
      { kind: "copyField", model: "M", from: "a", to: "b", type: "text", overwrite: false },
      { kind: "addIndex", model: "M", index: { name: "i", fields: [{ path: "a" }] } },
      { kind: "dropIndex", model: "M", index: "i" },
      { kind: "transform", model: "M", transform: "t", fields: [] }
    ];
    for (const op of stable) expect(changesColumns(op)).toBe(false);
  });
});
