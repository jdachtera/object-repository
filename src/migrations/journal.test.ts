/**
 * Journal row ids. They land in a backend's key column, which has hard limits a migration name can
 * violate — PostgreSQL rejects a NUL byte anywhere in text, and MySQL's key column is `varchar(64)` — so
 * the id is a fixed-width printable hash, and names that can't be journalled faithfully are refused
 * before any operation runs.
 */
import { describe, it, expect } from "vitest";
import { rowId, validateMigrationNames, MAX_MIGRATION_NAME_LENGTH } from "./journal.js";
import { runMigrations } from "./run.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { everything } from "./paging.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

describe("rowId", () => {
  it("is printable ASCII with no control characters, so every engine's text column accepts it", () => {
    for (const name of ["0001_create", "a".repeat(MAX_MIGRATION_NAME_LENGTH), "ünïcödé — ✓", "x"]) {
      for (const phase of ["expand", "contract"] as const) {
        expect(rowId(name, phase)).toMatch(/^[0-9a-f]{24}-[ec]$/);
      }
    }
  });

  it("fits MySQL's varchar(64) key column regardless of name length", () => {
    expect(rowId("a".repeat(MAX_MIGRATION_NAME_LENGTH), "contract").length).toBeLessThanOrEqual(64);
  });

  it("distinguishes phases and names", () => {
    expect(rowId("m", "expand")).not.toBe(rowId("m", "contract"));
    expect(rowId("m1", "expand")).not.toBe(rowId("m2", "expand"));
  });

  it("is stable, since it keys rows written by earlier deploys", () => {
    expect(rowId("0012_fullname", "expand")).toBe(rowId("0012_fullname", "expand"));
  });
});

describe("validateMigrationNames", () => {
  it("accepts ordinary names", () => {
    expect(() => validateMigrationNames(["0001_create", "0002 add column", "ünïcödé"])).not.toThrow();
  });

  it.each([
    ["an empty name", ""],
    ["a whitespace-only name", "   "],
    ["a NUL byte", "bad\u0000name"],
    ["a newline", "bad\nname"],
    ["an over-long name", "a".repeat(MAX_MIGRATION_NAME_LENGTH + 1)]
  ])("refuses %s", (_label, name) => {
    expect(() => validateMigrationNames([name])).toThrow();
  });

  it("refuses before any operation runs, so nothing is applied without a journal record", async () => {
    const backend = new InMemoryBackend();
    backend.save("User", { uuid: "u1", name: "Ann" }, SYSTEM_CONTEXT);
    await backend.persist(SYSTEM_CONTEXT);

    await expect(
      runMigrations(
        backend,
        [
          { name: "0001_ok", up: (m) => m.addField("User", "tier", "text", { fill: "free" }) },
          { name: "0002\u0000bad", up: (m) => m.dropField("User", "name") }
        ],
        { models: { User: { fields: [], indexes: [] } } }
      )
    ).rejects.toThrow(/control character/);

    const [row] = await backend.query(
      { model: "User", where: everything(), order: [], paging: { start: 0 } },
      SYSTEM_CONTEXT
    );
    expect(row).toEqual({ uuid: "u1", name: "Ann" }); // not even the valid first migration ran
  });
});
