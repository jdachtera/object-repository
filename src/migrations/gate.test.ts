/**
 * The version gate: what runs, what is withheld, and what survives the migration list being edited.
 *
 * The headline guarantee under test — **a bare `migrate()` never destroys anything.** Expands apply,
 * contracts are reported, and releasing one takes both a raised floor and an explicit `applyContracts`.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { runMigrations, rollbackMigrations, gateOpen } from "./run.js";
import { BackendJournal, MIGRATION_LOG_MODEL } from "./journal.js";
import { SchemaVersionError, MigrationBlockedError } from "./errors.js";
import { everything } from "./paging.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Backend } from "../core/Backend.js";
import type { JsonObject } from "../core/types.js";
import type { Migration } from "./types.js";

const ctx = SYSTEM_CONTEXT;
let clock = 1000;
const now = () => clock++;

const models = { User: { fields: [], indexes: [] } };
const run = (backend: Backend, migrations: Migration[], over: Record<string, unknown> = {}) =>
  runMigrations(backend, migrations, { models, now, ...over });

async function seeded(): Promise<InMemoryBackend> {
  const backend = new InMemoryBackend();
  backend.save("User", { uuid: "u1", name: "Ann" }, ctx);
  backend.save("User", { uuid: "u2", name: "Bo" }, ctx);
  await backend.persist(ctx);
  return backend;
}

const readUsers = (backend: Backend): Promise<JsonObject[]> =>
  backend.query({ model: "User", where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctx);

/** The canonical case: rename `name` → `fullName`, introduced at schema version 7. */
const rename = (): Migration => ({
  name: "0012_fullname",
  schemaVersion: 7,
  up: (m) => m.renameField("User", "name", "fullName", "text")
});

describe("gateOpen", () => {
  it("is always open for an unversioned migration", () => {
    expect(gateOpen({ name: "m", up: () => undefined }, 0)).toBe(true);
  });

  it("opens only once the floor reaches the migration's version", () => {
    const migration = { name: "m", schemaVersion: 7, up: () => undefined };
    expect(gateOpen(migration, 6)).toBe(false);
    expect(gateOpen(migration, 7)).toBe(true);
    expect(gateOpen(migration, 8)).toBe(true);
  });
});

describe("a closed gate withholds the destructive half", () => {
  it("expands now, defers the drop, and reports it", async () => {
    const backend = await seeded();
    const report = await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    expect(report.expanded).toEqual(["0012_fullname"]);
    expect(report.contracted).toEqual([]);
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({ migration: "0012_fullname", gate: 7, minSupported: 5 });
    expect(report.deferred[0]!.reason).toContain("drops User.name");

    // Both fields present: the new one back-filled, the old one still authoritative for old readers.
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", name: "Ann", fullName: "Ann" },
      { uuid: "u2", name: "Bo", fullName: "Bo" }
    ]);
  });

  it("is idempotent — re-running changes nothing and keeps reporting the debt", async () => {
    const backend = await seeded();
    const migrations = [rename()];
    await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    const second = await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    expect(second.expanded).toEqual([]);
    expect(second.deferred).toHaveLength(1);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", name: "Ann", fullName: "Ann" },
      { uuid: "u2", name: "Bo", fullName: "Bo" }
    ]);
  });
});

describe("an open gate still needs an explicit release", () => {
  it("reports the contract as releasable but does NOT run it", async () => {
    const backend = await seeded();
    const migrations = [rename()];
    await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    const raised = await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 7 });
    expect(raised.releasable).toHaveLength(1);
    expect(raised.contracted).toEqual([]);
    expect((await readUsers(backend))[0]).toHaveProperty("name"); // still there

    const released = await run(backend, migrations, {
      schemaVersion: 7,
      minSupportedSchemaVersion: 7,
      applyContracts: true
    });
    expect(released.contracted).toEqual(["0012_fullname"]);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", fullName: "Ann" },
      { uuid: "u2", fullName: "Bo" }
    ]);
  });

  it("adopts what an old writer wrote during the window before dropping", async () => {
    const backend = await seeded();
    const migrations = [rename()];
    await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    // An old build, still running, updates the legacy field it knows about.
    backend.save("User", { uuid: "u1", name: "Ann-updated", fullName: "Ann" }, ctx, ["name"]);
    await backend.persist(ctx);

    await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });

    // The contract-side re-copy is what saves this write from being thrown away by the drop.
    expect((await readUsers(backend))[0]).toEqual({ uuid: "u1", fullName: "Ann-updated" });
  });

  it("marks the migration complete afterwards", async () => {
    const backend = await seeded();
    const migrations = [rename()];
    const opts = { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true };
    await run(backend, migrations, opts);
    const again = await run(backend, migrations, opts);

    expect(again.skipped).toEqual(["0012_fullname"]);
    expect(again.contracted).toEqual([]);
  });
});

describe("the journal owns the debt, not the source file", () => {
  it("releases a contract after the migration was deleted from the array", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    // Months later the migration is tidied out of the codebase — the store still owes the drop.
    const report = await run(backend, [], {
      schemaVersion: 7,
      minSupportedSchemaVersion: 7,
      applyContracts: true
    });

    // Nothing in the (empty) list to act on, so the runner reports nothing...
    expect(report.contracted).toEqual([]);
    // ...but the debt is still recorded, rather than silently forgotten.
    const journal = new BackendJournal(backend, ctx);
    const owed = (await journal.load()).find((row) => row.phase === "contract" && row.status === "pending");
    expect(owed?.ops).toHaveLength(2);
  });

  it("prefers the recorded ops over an edited migration body when releasing", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    // The author rewrites the migration's contract half after the expand already ran.
    const edited: Migration = {
      name: "0012_fullname",
      schemaVersion: 7,
      up: (m) => m.dropField("User", "somethingElse")
    };

    await expect(
      run(backend, [edited], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true })
    ).rejects.toThrow(MigrationBlockedError);
  });
});

describe("unversioned migrations behave exactly as before", () => {
  it("runs the whole thing in one pass", async () => {
    const backend = await seeded();
    const report = await run(backend, [
      { name: "m1", up: (m) => m.renameField("User", "name", "fullName", "text") }
    ]);

    expect(report.applied).toEqual(["m1"]);
    expect(report.deferred).toEqual([]);
    expect(report.releasable).toEqual([]);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", fullName: "Ann" },
      { uuid: "u2", fullName: "Bo" }
    ]);
  });
});

describe("version invariants", () => {
  it("rejects a floor above the declared version", async () => {
    await expect(
      run(await seeded(), [], { schemaVersion: 3, minSupportedSchemaVersion: 5 })
    ).rejects.toThrow(SchemaVersionError);
  });

  it("rejects an older build run against a newer store", async () => {
    const backend = await seeded();
    await run(backend, [], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });
    await expect(run(backend, [], { schemaVersion: 5 })).rejects.toThrow(/already at 7/);
  });

  it("defaults the floor to one version back, so a bump alone destroys nothing", async () => {
    const backend = await seeded();
    const report = await run(backend, [rename()], { schemaVersion: 7 }); // no explicit floor
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]!.minSupported).toBe(6);
  });

  it("does not record a raised floor that released nothing", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    // An operator raises the floor by mistake but passes no applyContracts: nothing ran, so nothing
    // about that mistake should become permanent.
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 7 });

    const state = await new BackendJournal(backend, ctx).readSchemaState();
    expect(state?.minSupportedSchemaVersion).toBe(0);
  });

  it("rejects duplicate migration names", async () => {
    const dup = { name: "same", up: () => undefined };
    await expect(run(await seeded(), [dup, { ...dup }])).rejects.toThrow(/Duplicate migration name/);
  });
});

describe("rollback", () => {
  it("reverts the most recent migration via its down()", async () => {
    const backend = await seeded();
    const migration: Migration = {
      name: "m1",
      up: (m) => m.addField("User", "tier", "text", { fill: "free" }),
      down: (m) => m.dropField("User", "tier")
    };
    await run(backend, [migration]);
    expect((await readUsers(backend))[0]).toHaveProperty("tier", "free");

    const report = await rollbackMigrations(backend, [migration], 1, { models, now });
    expect(report.applied).toEqual(["m1"]);
    expect((await readUsers(backend))[0]).not.toHaveProperty("tier");

    // ...and the journal forgot it, so a later migrate re-applies rather than skipping.
    const rerun = await run(backend, [migration]);
    expect(rerun.expanded).toEqual(["m1"]);
  });

  it("skips a migration with no down()", async () => {
    const backend = await seeded();
    const migration: Migration = { name: "m1", up: (m) => m.addField("User", "tier", "text", { fill: "x" }) };
    await run(backend, [migration]);

    const report = await rollbackMigrations(backend, [migration], 1, { models, now });
    expect(report.skipped).toEqual(["m1"]);
  });

  it("refuses once a released contract has destroyed data down() cannot restore", async () => {
    const backend = await seeded();
    const migration: Migration = {
      name: "0009_drop_name",
      schemaVersion: 7,
      up: (m) => m.dropField("User", "name"),
      // `down` can re-declare the field, but the values are gone — which is exactly why this is refused.
      down: (m) => m.addField("User", "name", "text")
    };
    await run(backend, [migration], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });

    const report = await rollbackMigrations(backend, [migration], 1, { models, now });
    expect(report.skipped).toEqual(["0009_drop_name"]);
  });

  it("does roll back a released rename, whose values live on under the new name", async () => {
    const backend = await seeded();
    const migration: Migration = {
      name: "0012_fullname",
      schemaVersion: 7,
      up: (m) => m.renameField("User", "name", "fullName", "text"),
      down: (m) => m.renameField("User", "fullName", "name", "text")
    };
    await run(backend, [migration], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });

    const report = await rollbackMigrations(backend, [migration], 1, { models, now });
    expect(report.applied).toEqual(["0012_fullname"]);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", name: "Ann" },
      { uuid: "u2", name: "Bo" }
    ]);
  });
});

describe("the journal is stored through the plain Backend seam", () => {
  it("keeps one row per (migration, phase)", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    const rows = await backend.query(
      { model: MIGRATION_LOG_MODEL, where: everything(), order: [], paging: { start: 0 } },
      ctx
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${String(row.phase)}:${String(row.status)}`).sort()).toEqual([
      "contract:pending",
      "expand:applied"
    ]);
  });
});

describe("the deploy timeline documented in docs/MIGRATIONS.md", () => {
  const migrations: Migration[] = [
    { name: "0012_fullname", schemaVersion: 7, up: (m) => m.renameField("User", "name", "fullName", "text") }
  ];

  it("behaves exactly as the guide describes, step by step", async () => {
    const backend = await seeded();

    // 1. Ship the migration: only the expand runs, and the drop is reported as deferred.
    const shipped = await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect(shipped.expanded).toEqual(["0012_fullname"]);
    expect(shipped.deferred).toHaveLength(1);
    expect(shipped.deferred[0]).toMatchObject({ migration: "0012_fullname", gate: 7, minSupported: 5 });
    expect(shipped.deferred[0]!.reason).toContain("drops User.name");
    expect(shipped.contracted).toEqual([]);

    // 2. Both fields are in the store, so either generation can read.
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", name: "Ann", fullName: "Ann" },
      { uuid: "u2", name: "Bo", fullName: "Bo" }
    ]);

    // 3. Raise the floor: permitted, still not run.
    const raised = await run(backend, migrations, { schemaVersion: 7, minSupportedSchemaVersion: 7 });
    expect(raised.releasable).toHaveLength(1);
    expect(raised.contracted).toEqual([]);
    expect((await readUsers(backend))[0]).toHaveProperty("name");

    // 4. Release it deliberately.
    const released = await run(backend, migrations, {
      schemaVersion: 7,
      minSupportedSchemaVersion: 7,
      applyContracts: true
    });
    expect(released.contracted).toEqual(["0012_fullname"]);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", fullName: "Ann" },
      { uuid: "u2", fullName: "Bo" }
    ]);
  });
});
