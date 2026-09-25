/**
 * The dry run. Its whole job is to answer "what does this deploy touch, and what would a release
 * destroy?" without touching anything itself — so the load-bearing assertion here is that a backend
 * driven through `plan()` sees reads and no writes.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { planMigrations, formatPlan } from "./plan.js";
import { runMigrations } from "./run.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Backend } from "../core/Backend.js";
import type { Migration } from "./types.js";

const ctx = SYSTEM_CONTEXT;
let clock = 1000;
const now = () => clock++;
const models = { User: { fields: [], indexes: [] } };

async function seeded(): Promise<InMemoryBackend> {
  const backend = new InMemoryBackend();
  backend.save("User", { uuid: "u1", name: "Ann" }, ctx);
  await backend.persist(ctx);
  return backend;
}

const rename = (): Migration => ({
  name: "0012_fullname",
  schemaVersion: 7,
  up: (m) => m.renameField("User", "name", "fullName", "text")
});

describe("plan", () => {
  it("reports pending work without doing any of it", async () => {
    const backend = await seeded();
    const plan = await planMigrations(backend, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 5 });

    expect(plan.schema).toEqual({ schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect(plan.stored).toBeNull();
    expect(plan.steps.filter((step) => step.status === "pending").map((step) => step.op.kind)).toEqual([
      "addField",
      "copyField"
    ]);
    expect(plan.steps.filter((step) => step.status === "deferred").map((step) => step.op.kind)).toEqual([
      "copyField",
      "dropField"
    ]);

    // Nothing ran: the record is untouched.
    const rows = await backend.query({ model: "User", where: { type: "all" }, order: [], paging: { start: 0 } }, ctx);
    expect(rows).toEqual([{ uuid: "u1", name: "Ann" }]);
  });

  it("issues no writes at all", async () => {
    let writes = 0;
    const inner = await seeded();
    const counting: Backend = {
      capabilities: inner.capabilities,
      query: (plan, c) => inner.query(plan, c),
      queryUuids: (plan, c) => inner.queryUuids(plan, c),
      save: (model, record, c, dirty) => {
        writes += 1;
        inner.save(model, record, c, dirty);
      },
      remove: (model, record, c) => {
        writes += 1;
        inner.remove(model, record, c);
      },
      persist: (c) => inner.persist(c),
      changes: (listener, c) => inner.changes(listener, c)
    };

    await planMigrations(counting, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect(writes).toBe(0);
  });

  it("separates what is withheld from what a release would destroy", async () => {
    const backend = await seeded();

    const closed = await planMigrations(backend, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect(closed.deferred).toHaveLength(1);
    expect(closed.releasable).toHaveLength(0);

    // A contract only becomes *releasable* once its expand has actually run behind a closed gate. On
    // a fresh store with the gate already open there is no window, so the rename just runs whole.
    await runMigrations(backend, [rename()], { models, now, schemaVersion: 7, minSupportedSchemaVersion: 5 });

    const open = await planMigrations(backend, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 7 });
    expect(open.deferred).toHaveLength(0);
    expect(open.releasable).toHaveLength(1);
    expect(open.releasable[0]!.ops.map((op) => op.kind)).toEqual(["copyField", "dropField"]);
  });

  it("marks applied work and warns about an open compatibility window", async () => {
    const backend = await seeded();
    await runMigrations(backend, [rename()], { models, now, schemaVersion: 7, minSupportedSchemaVersion: 5 });

    const plan = await planMigrations(backend, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 5 });
    expect(plan.steps.filter((step) => step.phase === "expand").every((step) => step.status === "applied")).toBe(true);
    expect(plan.warnings.map((warning) => warning.code)).toContain("COMPAT_WINDOW_OPEN");
    expect(plan.stored).not.toBeNull();
  });

  it("reports drift as a blocker rather than throwing", async () => {
    const backend = await seeded();
    await runMigrations(backend, [rename()], { models, now, schemaVersion: 7, minSupportedSchemaVersion: 5 });

    const edited: Migration = { name: "0012_fullname", schemaVersion: 7, up: (m) => m.dropField("User", "other") };
    const plan = await planMigrations(backend, [edited], { models, schemaVersion: 7, minSupportedSchemaVersion: 5 });

    // A plan is diagnostic: it lists the problem instead of refusing to answer.
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(["CHECKSUM_DRIFT"]);
  });

  it("warns that raw SQL is not portable", async () => {
    const backend = await seeded();
    const plan = await planMigrations(
      backend,
      [{ name: "m", schemaVersion: 2, up: (m) => m.sql("DELETE FROM x", [], { phase: "contract" }) }],
      { models, schemaVersion: 2, minSupportedSchemaVersion: 1 }
    );
    expect(plan.warnings.map((warning) => warning.code)).toContain("RAW_SQL_NOT_PORTABLE");
  });
});

describe("formatPlan", () => {
  it("renders what runs, what is withheld, and what a release would destroy", async () => {
    const backend = await seeded();
    const closed = await planMigrations(backend, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 5 });
    const text = formatPlan(closed);

    expect(text).toContain("schema version 7, minSupported 5");
    expect(text).toContain("Will run 2 operation(s)");
    expect(text).toContain("Withheld by the version gate");
    expect(text).toContain("add User.fullName");

    await runMigrations(backend, [rename()], { models, now, schemaVersion: 7, minSupportedSchemaVersion: 5 });
    const open = await planMigrations(backend, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 7 });
    const released = formatPlan(open);

    expect(released).toContain("DESTRUCTIVE");
    expect(released).toContain("drop User.name");
  });

  it("says so plainly when there is nothing to do", async () => {
    const plan = await planMigrations(await seeded(), [], { models });
    expect(formatPlan(plan)).toContain("Nothing to run.");
  });

  it("renders every operation kind legibly", async () => {
    const plan = await planMigrations(
      await seeded(),
      [
        {
          name: "everything",
          up: (m) => {
            m.createModel("New", []);
            m.addField("User", "tier", "text", { fill: "free" });
            m.addField("User", "plain", "text");
            m.copyField("User", "a", "b", "text", { overwrite: true });
            m.retypeField("User", "age", "integer", "float");
            m.transform("User", "t", ["a"]);
            m.addIndex("User", { name: "by_a", fields: [{ path: "a" }], unique: true });
            m.dropIndex("User", "by_a");
            m.dropField("User", "old");
            m.dropModel("Stale");
            m.sql("UPDATE x SET y = 1");
          }
        }
      ],
      { models }
    );

    const text = formatPlan(plan);
    for (const fragment of [
      "create New",
      "add User.tier: text fill=\"free\"",
      "add User.plain: text",
      "copy User.a → b (overwrite)",
      "retype User.age: integer → float",
      'transform User via "t"',
      "add index by_a on User (unique)",
      "drop index by_a on User",
      "drop User.old",
      "drop Stale",
      "raw sql (*): UPDATE x SET y = 1"
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it("renders a rename, which only survives unsplit when no window was requested", async () => {
    const plan = await planMigrations(await seeded(), [{ name: "r", up: (m) => m.renameField("User", "a", "b", "text") }], {
      models
    });
    expect(formatPlan(plan)).toContain("rename User.a → b");
  });
});

describe("plan refuses whatever run refuses", () => {
  it("reports a narrowing retype as a blocker", async () => {
    const plan = await planMigrations(await seeded(), [
      { name: "m", schemaVersion: 1, up: (m) => m.retypeField("User", "age", "float", "integer") }
    ], { models, schemaVersion: 1 });
    expect(plan.blockers.map((b) => b.code)).toEqual(["NARROWING_RETYPE"]);
  });

  it("reports invalid and regressed versions as blockers", async () => {
    const backend = await seeded();
    const invalid = await planMigrations(backend, [], { schemaVersion: 3, minSupportedSchemaVersion: 5 });
    expect(invalid.blockers.map((b) => b.code)).toEqual(["INVALID_SCHEMA_VERSION"]);

    await runMigrations(backend, [], { models, schemaVersion: 8, now });
    const regressed = await planMigrations(backend, [], { schemaVersion: 7 });
    expect(regressed.blockers.map((b) => b.code)).toEqual(["VERSION_REGRESSION"]);
  });

  it("doesn't list an open-gate contract as running unless applyContracts is given", async () => {
    const backend = await seeded();
    const bare = await planMigrations(backend, [rename()], { models, schemaVersion: 7, minSupportedSchemaVersion: 7 });
    expect(bare.steps.filter((step) => step.status === "pending").map((step) => step.op.kind)).toEqual([
      "addField",
      "copyField"
    ]);
    expect(bare.releasable.map((item) => item.migration)).toEqual(["0012_fullname"]);
    expect(formatPlan(bare)).not.toMatch(/dropField|drop User\.name {2}/);

    const released = await planMigrations(backend, [rename()], {
      models,
      schemaVersion: 7,
      minSupportedSchemaVersion: 7,
      applyContracts: true
    });
    expect(released.steps.filter((step) => step.status === "pending").map((step) => step.op.kind)).toEqual(["renameField"]);
  });

  it("sees legacy history as adopted without writing it", async () => {
    const backend = await seeded();
    const withLegacy = Object.assign(backend, { legacyMigrationNames: async () => ["0001_old"] });
    const plan = await planMigrations(withLegacy, [
      { name: "0001_old", up: (m) => m.dropField("User", "name") }
    ], { models });
    expect(plan.steps.every((step) => step.status === "applied")).toBe(true);
    const log = await backend.query(
      { model: "_object_repository_migration_log", where: { type: "all" }, order: [], paging: { start: 0 } },
      ctx
    );
    expect(log).toEqual([]);
  });
});
