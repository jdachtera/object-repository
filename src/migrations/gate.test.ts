/**
 * The version gate: what runs, what is withheld, and what survives the migration list being edited.
 *
 * The headline guarantee under test — **a bare `migrate()` never destroys anything.** Expands apply,
 * contracts are reported, and releasing one takes both a raised floor and an explicit `applyContracts`.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { runMigrations, rollbackMigrations, gateOpen, MigrationLockedError } from "./run.js";
import { BackendJournal, MIGRATION_LOG_MODEL, acquireLock, LOCK_LEASE_MS } from "./journal.js";
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
    const floorOnly = await run(backend, [], { schemaVersion: 7, minSupportedSchemaVersion: 7 });
    // Reported, not forgotten: the journal's record is what's owed.
    expect(floorOnly.releasable).toMatchObject([{ migration: "0012_fullname", orphaned: true }]);
    expect(floorOnly.releasable[0]!.ops.map((op) => op.kind)).toEqual(["copyField", "dropField"]);

    const report = await run(backend, [], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });
    expect(report.contracted).toEqual(["0012_fullname"]);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", fullName: "Ann" },
      { uuid: "u2", fullName: "Bo" }
    ]);
    const journal = new BackendJournal(backend, ctx);
    expect((await journal.load()).some((row) => row.status === "pending")).toBe(false);
  });

  it("reports a deleted migration's debt as deferred while its gate is closed", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    const report = await run(backend, [], { schemaVersion: 7, minSupportedSchemaVersion: 6 });
    expect(report.deferred).toMatchObject([{ migration: "0012_fullname", gate: 7, orphaned: true }]);
  });

  it("refuses to release a deleted migration's transform, whose code is gone", async () => {
    const backend = await seeded();
    const prune: Migration = {
      name: "0013_prune",
      schemaVersion: 7,
      transforms: { drop: () => null },
      up: (m) => m.transform("User", "drop", [])
    };
    await run(backend, [prune], { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    await expect(
      run(backend, [], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true })
    ).rejects.toMatchObject({ blockers: [{ code: "UNRECOVERABLE_CONTRACT", migration: "0013_prune" }] });
    expect(await readUsers(backend)).toHaveLength(2);

    // Restoring the migration makes the debt payable again.
    const report = await run(backend, [prune], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });
    expect(report.contracted).toEqual(["0013_prune"]);
    expect(await readUsers(backend)).toEqual([]);
  });

  it("re-derives the debt from an unchanged source when the contract row is missing", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    // A crash between the expand-row and contract-row writes leaves no contract row at all.
    const journal = new BackendJournal(backend, ctx);
    await journal.remove("0012_fullname", "contract");

    const report = await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 7 });
    expect(report.releasable).toMatchObject([{ migration: "0012_fullname" }]);
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

  it("refuses a migration with no down() — rather than reverting an older one in its place", async () => {
    const backend = await seeded();
    const older: Migration = { name: "m0", up: (m) => m.addField("User", "a", "text"), down: (m) => m.dropField("User", "a") };
    const migration: Migration = { name: "m1", up: (m) => m.addField("User", "tier", "text", { fill: "x" }) };
    await run(backend, [older, migration]);

    await expect(rollbackMigrations(backend, [older, migration], 1, { models, now })).rejects.toMatchObject({
      blockers: [{ code: "ROLLBACK_REFUSED", migration: "m1" }]
    });
    const log = await new BackendJournal(backend, ctx).load();
    expect(log.some((row) => row.name === "m0")).toBe(true); // the older one was not reverted instead
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

    await expect(rollbackMigrations(backend, [migration], 1, { models, now })).rejects.toMatchObject({
      blockers: [{ code: "ROLLBACK_REFUSED", migration: "0009_drop_name" }]
    });
  });

  it("reverts the later of two migrations applied in the same millisecond", async () => {
    const backend = await seeded();
    const frozen = () => 5000;
    const first: Migration = { name: "m1", up: (m) => m.addField("User", "a", "text", { fill: "1" }), down: (m) => m.dropField("User", "a") };
    const second: Migration = { name: "m2", up: (m) => m.addField("User", "b", "text", { fill: "2" }), down: (m) => m.dropField("User", "b") };
    await runMigrations(backend, [first, second], { models, now: frozen });

    const report = await rollbackMigrations(backend, [first, second], 1, { models, now: frozen });
    expect(report.applied).toEqual(["m2"]);
    expect((await readUsers(backend))[0]).toMatchObject({ a: "1" });
  });

  it("refuses to roll back mid-window, where the legacy field is authoritative", async () => {
    const backend = await seeded();
    const migration: Migration = { ...rename(), down: (m) => m.renameField("User", "fullName", "name", "text") };
    await run(backend, [migration], { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    await expect(rollbackMigrations(backend, [migration], 1, { models, now })).rejects.toThrow(/mid-window/);
  });

  it("refuses a migration that isn't declared any more rather than reach past it", async () => {
    const backend = await seeded();
    const older: Migration = { name: "m0", up: (m) => m.addField("User", "a", "text"), down: (m) => m.dropField("User", "a") };
    const newer: Migration = { name: "m1", up: (m) => m.addField("User", "b", "text"), down: (m) => m.dropField("User", "b") };
    await run(backend, [older, newer]);
    await expect(rollbackMigrations(backend, [older], 1, { models, now })).rejects.toThrow(/not declared/);
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

describe("the migration lease", () => {
  it("refuses a second runner while the first holds it", async () => {
    const backend = await seeded();
    const held = await acquireLock(backend, ctx, now, "replica-a");
    expect(held).not.toBeNull();

    // The accident this exists for: two replicas booting together, both seeing the same pending set.
    await expect(
      runMigrations(backend, [rename()], { models, now, schemaVersion: 7, minSupportedSchemaVersion: 5 })
    ).rejects.toThrow(MigrationLockedError);

    await held!.release();
  });

  it("releases the lease afterwards, so the next deploy is not blocked", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    // A second run proceeds normally — the lease from the first was released.
    const second = await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect(second.deferred).toHaveLength(1);
  });

  it("releases the lease even when a migration throws", async () => {
    const backend = await seeded();
    const exploding: Migration[] = [
      { name: "boom", up: () => { throw new Error("migration failed"); } }
    ];
    await expect(run(backend, exploding)).rejects.toThrow("migration failed");

    // A failed deploy must not wedge every future one.
    await expect(run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 })).resolves.toBeDefined();
  });

  it("lets a later runner take over an expired lease, so a dead process does not wedge deploys", async () => {
    const backend = await seeded();
    await acquireLock(backend, ctx, () => 0, "dead-replica"); // leased at t=0, expiring at the lease length

    const afterExpiry = () => LOCK_LEASE_MS + 1;
    const taken = await acquireLock(backend, ctx, afterExpiry, "replica-b");
    expect(taken).not.toBeNull();
  });

  it("can be skipped by a caller that already guarantees a single runner", async () => {
    const backend = await seeded();
    await acquireLock(backend, ctx, now, "someone-else");
    await expect(run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5, skipLock: true })).resolves.toBeDefined();
  });
});

describe("a bare migrate() never destroys, even with the gate already open", () => {
  // The realistic trigger: the floor is already 7 to release an earlier contract, and a developer
  // adds another v7 migration. Its gate is open the moment it is first seen.
  it("withholds a gated drop whose gate is open on first sight", async () => {
    const backend = await seeded();
    const report = await run(
      backend,
      [{ name: "0014_drop", schemaVersion: 7, up: (m) => m.dropField("User", "name") }],
      { schemaVersion: 7, minSupportedSchemaVersion: 7 }
    );
    expect(report.releasable).toMatchObject([{ migration: "0014_drop" }]);
    expect(report.contracted).toEqual([]);
    expect((await readUsers(backend)).map((user) => user.name)).toEqual(["Ann", "Bo"]);
  });

  it("splits a gated rename whose gate is open on first sight", async () => {
    const backend = await seeded();
    const report = await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 7 });
    expect(report.releasable).toMatchObject([{ migration: "0012_fullname" }]);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", name: "Ann", fullName: "Ann" },
      { uuid: "u2", name: "Bo", fullName: "Bo" }
    ]);
  });

  it("runs it whole, in one pass, once applyContracts is given — and reports the contract", async () => {
    const backend = await seeded();
    const report = await run(backend, [rename()], {
      schemaVersion: 7,
      minSupportedSchemaVersion: 7,
      applyContracts: true
    });
    expect(report.contracted).toEqual(["0012_fullname"]);
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", fullName: "Ann" },
      { uuid: "u2", fullName: "Bo" }
    ]);
    // Nothing left owing, and a re-run is a no-op.
    const again = await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });
    expect(again.skipped).toEqual(["0012_fullname"]);
  });

  it("withholds a transform unless it is declared expand", async () => {
    const backend = await seeded();
    const prune: Migration = {
      name: "0015_prune",
      schemaVersion: 7,
      transforms: { drop: () => null },
      up: (m) => m.transform("User", "drop", [])
    };
    const report = await run(backend, [prune], { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect(report.deferred).toMatchObject([{ migration: "0015_prune" }]);
    expect(await readUsers(backend)).toHaveLength(2);
  });

  it("runs a declared-expand backfill, but fails it rather than let it delete", async () => {
    const backend = await seeded();
    const backfill: Migration = {
      name: "0016_tier",
      schemaVersion: 7,
      transforms: { tier: (row) => ({ ...row, tier: "free" }) },
      up: (m) => m.transform("User", "tier", ["tier"], undefined, { phase: "expand" })
    };
    await run(backend, [backfill], { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect((await readUsers(backend)).map((user) => user.tier)).toEqual(["free", "free"]);

    const liar: Migration = {
      name: "0017_liar",
      schemaVersion: 7,
      transforms: { drop: () => null },
      up: (m) => m.transform("User", "drop", [], undefined, { phase: "expand" })
    };
    await expect(run(backend, [liar], { schemaVersion: 7, minSupportedSchemaVersion: 5 })).rejects.toThrow(
      /declared phase "expand" but deleted/
    );
    expect(await readUsers(backend)).toHaveLength(2);
  });

  it("withholds an overwriting copy", async () => {
    const backend = await seeded();
    backend.save("User", { uuid: "u1", name: "Ann", nick: "annie" }, ctx);
    await backend.persist(ctx);
    const report = await run(
      backend,
      [{ name: "0018_nick", schemaVersion: 7, up: (m) => m.copyField("User", "name", "nick", "text", { overwrite: true }) }],
      { schemaVersion: 7, minSupportedSchemaVersion: 5 }
    );
    expect(report.deferred).toMatchObject([{ migration: "0018_nick" }]);
    expect((await readUsers(backend))[0]!.nick).toBe("annie");
  });
});

describe("every refusal comes before any operation", () => {
  it("refuses a drifted migration before running the contract it guards or anything after it", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 5 });

    const edited: Migration = { ...rename(), up: (m) => m.renameField("User", "name", "displayName", "text") };
    const later: Migration = { name: "0020_later", up: (m) => m.addField("User", "later", "text", { fill: "x" }) };
    await expect(
      run(backend, [edited, later], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true })
    ).rejects.toMatchObject({ blockers: [{ code: "CHECKSUM_DRIFT" }] });

    // Neither the drifted contract nor the later migration ran.
    expect(await readUsers(backend)).toEqual([
      { uuid: "u1", name: "Ann", fullName: "Ann" },
      { uuid: "u2", name: "Bo", fullName: "Bo" }
    ]);
    const log = await new BackendJournal(backend, ctx).load();
    expect(log.some((row) => row.name === "0020_later")).toBe(false);
  });

  it("refuses a narrowing retype late in the list before an earlier migration runs", async () => {
    const backend = await seeded();
    await expect(
      run(backend, [
        { name: "a", up: (m) => m.addField("User", "tier", "text", { fill: "free" }) },
        { name: "b", up: (m) => m.retypeField("User", "age", "float", "integer") }
      ])
    ).rejects.toMatchObject({ blockers: [{ code: "NARROWING_RETYPE" }] });
    expect((await readUsers(backend))[0]).not.toHaveProperty("tier");
  });

  it("reports an inconsistent journal as a blocker", async () => {
    const backend = await seeded();
    await run(backend, [rename()], { schemaVersion: 7, minSupportedSchemaVersion: 7, applyContracts: true });
    await new BackendJournal(backend, ctx).remove("0012_fullname", "expand");
    await expect(run(backend, [rename()], { schemaVersion: 7 })).rejects.toMatchObject({
      blockers: [{ code: "JOURNAL_INCONSISTENT" }]
    });
  });
});

describe("a rollback that fails part-way", () => {
  it("reports each migration it did revert as it goes, so callers can account for them", async () => {
    const backend = await seeded();
    const first: Migration = { name: "m1", up: (m) => m.addField("User", "a", "text"), down: () => { throw new Error("down failed"); } };
    const second: Migration = { name: "m2", up: (m) => m.addField("User", "b", "text", { fill: "B" }), down: (m) => m.dropField("User", "b") };
    await run(backend, [first, second]);

    const reverted: string[] = [];
    await expect(
      rollbackMigrations(backend, [first, second], 2, { models, now, onRolledBack: (migration) => void reverted.push(migration.name) })
    ).rejects.toThrow("down failed");
    expect(reverted).toEqual(["m2"]);
  });
});
