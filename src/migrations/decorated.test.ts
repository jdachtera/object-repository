/**
 * A migration runs on the store, not through the decorators stacked on it.
 *
 * Row policy, hooks and the sync layer are there for application writes. Applied to a migration they
 * filter it down to one user's rows, fire hooks per record, restamp every record as a fresh edit that
 * beats other replicas' offline work, and replicate the journal to peers that never ran it. The runner
 * therefore unwraps every decorator (`migrationTarget`) and migrates the store underneath.
 */
import { describe, it, expect } from "vitest";
import { newDb } from "pg-mem";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import { PolicyBackend } from "../backends/decorators/PolicyBackend.js";
import { HooksBackend } from "../backends/decorators/HooksBackend.js";
import { observe } from "../backends/decorators/ObservabilityBackend.js";
import { multiWriteBackend } from "../backends/decorators/MultiWriteBackend.js";
import { SyncBackend } from "../sync/SyncBackend.js";
import { InMemorySyncTarget } from "../sync/InMemorySyncTarget.js";
import { migrationTarget, type Backend } from "../core/Backend.js";
import { SYSTEM_CONTEXT, type Context, type JsonObject } from "../core/types.js";
import { eq } from "../expressions/index.js";
import { runMigrations } from "./run.js";
import { planMigrations } from "./plan.js";
import { MIGRATION_LOG_MODEL } from "./journal.js";
import { everything } from "./paging.js";
import type { Migration } from "./types.js";

const ctx = SYSTEM_CONTEXT;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const userCtx: Context = { ...SYSTEM_CONTEXT, user: { id: "ann" } } as Context;
const models = { Doc: { fields: [], indexes: [] } };

const tier: Migration = { name: "0040_tier", up: (m) => m.addField("Doc", "tier", "text", { fill: "free" }) };

async function seed(backend: Backend): Promise<void> {
  backend.save("Doc", { uuid: "d1", owner: "ann" }, ctx);
  backend.save("Doc", { uuid: "d2", owner: "bob" }, ctx);
  await backend.persist(ctx);
}

const rows = (backend: Backend, model = "Doc"): Promise<JsonObject[]> =>
  backend.query({ model, where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctx);

describe("migrationTarget", () => {
  it("unwraps every decorator down to the store", () => {
    const store = new InMemoryBackend();
    const stacked = observe(new HooksBackend(new PolicyBackend(store, {}), {}));
    expect(migrationTarget(stacked)).toBe(store);
  });

  it("refuses a fan-out, which would migrate the primary alone", () => {
    const fanned = multiWriteBackend({ primary: new InMemoryBackend(), secondaries: [new InMemoryBackend()] });
    expect(() => migrationTarget(fanned)).toThrow(/each store through its own manager/);
  });
});

describe("through PolicyBackend", () => {
  it("migrates every row, not just the ones the context can see", async () => {
    const store = new InMemoryBackend();
    await seed(store);
    const policy = new PolicyBackend(store, {
      read: (_model, context) => eq("owner", String((context as { user?: { id: string } }).user?.id)),
      write: (_model, record, context) => record.owner === (context as { user?: { id: string } }).user?.id
    });
    const report = await runMigrations(policy, [tier], { models, ctx: userCtx });
    expect(report.applied).toEqual(["0040_tier"]);
    expect((await rows(store)).map((row) => row.tier)).toEqual(["free", "free"]);
  });

  it("isn't blocked by a policy that throws for the system context", async () => {
    const store = new InMemoryBackend();
    await seed(store);
    const policy = new PolicyBackend(store, {
      read: () => {
        throw new Error("no user");
      }
    });
    await expect(runMigrations(policy, [tier], { models })).resolves.toMatchObject({ applied: ["0040_tier"] });
  });

  it("adopts the legacy SQL tracking table beneath it instead of re-running history", async () => {
    const { Pool } = newDb().adapters.createPg();
    const pool = new Pool();
    await pool.query(`CREATE TABLE "_object_repository_migrations" ("name" text PRIMARY KEY, "applied_at" bigint)`);
    await pool.query(`INSERT INTO "_object_repository_migrations" VALUES ('0001_old', 1)`);
    const policy = new PolicyBackend(new PostgresBackend(pool), {});

    const history: Migration = { name: "0001_old", up: (m) => m.sql("THIS IS NOT SQL") };
    const plan = await planMigrations(policy, [history], { models });
    expect(plan.steps.filter((step) => step.status === "pending")).toEqual([]);
    await expect(runMigrations(policy, [history], { models })).resolves.toMatchObject({ skipped: ["0001_old"] });
  });
});

describe("through HooksBackend", () => {
  it("fires no application hooks", async () => {
    const store = new InMemoryBackend();
    await seed(store);
    const fired: string[] = [];
    const hooks = new HooksBackend(store, {
      beforeSave: (model) => {
        fired.push(model);
        throw new Error("needs a user");
      }
    });
    await runMigrations(hooks, [tier], { models });
    expect(fired).toEqual([]);
    expect((await rows(store)).map((row) => row.tier)).toEqual(["free", "free"]);
  });
});

describe("through SyncBackend", () => {
  async function replica(target: InMemorySyncTarget, nodeId: string) {
    const local = new InMemoryBackend();
    const sync = new SyncBackend({ local, remote: target, nodeId });
    return { local, sync };
  }

  it("rewrites the local store without restamping, and replicates neither records nor journal", async () => {
    const target = new InMemorySyncTarget();
    const a = await replica(target, "a");
    a.sync.save("Doc", { uuid: "d1", owner: "ann" }, ctx);
    await a.sync.persist(ctx);
    await a.sync.reconcile(ctx);
    const [before] = await rows(a.local);

    await runMigrations(a.sync, [tier], { models });

    const [after] = await rows(a.local);
    expect(after).toMatchObject({ tier: "free", _version: before!._version }); // no fresh HLC
    const outbox = await rows(a.local, "_outbox");
    expect(outbox).toEqual([]);

    // A peer pulling sees none of it: not the migration's rewrite, not the journal.
    const b = await replica(target, "b");
    await b.sync.reconcile(ctx);
    expect(await rows(b.local, MIGRATION_LOG_MODEL)).toEqual([]);
    expect((await rows(b.local))[0]).not.toHaveProperty("tier");
  });

  it("keeps the library's bookkeeping local even when written through it", async () => {
    const target = new InMemorySyncTarget();
    const a = await replica(target, "a");
    a.sync.save(MIGRATION_LOG_MODEL, { uuid: "x" }, ctx);
    await a.sync.persist(ctx);
    await a.sync.reconcile(ctx);
    expect((await target.pull(null, ctx)).changes).toEqual([]);
  });
});

describe("unique indexes during a record pass", () => {
  it("aren't built as a side effect, so a pass over duplicate data still runs", async () => {
    // SQLite refuses a unique index over duplicate values, as Mongo and IndexedDB do.
    const store = new SQLiteBackend(new DatabaseSync(":memory:"));
    store.save("Doc", { uuid: "d1", email: "same@x" }, ctx);
    store.save("Doc", { uuid: "d2", email: "same@x" }, ctx);
    await store.persist(ctx);

    const withUnique = { Doc: { fields: [], indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }] } };
    const report = await runMigrations(store, [tier], { models: withUnique });
    expect(report.applied).toEqual(["0040_tier"]);
    expect((await rows(store)).map((row) => row.tier)).toEqual(["free", "free"]);
  });

  it("are restored once the run ends, where the data allows", async () => {
    const store = new InMemoryBackend();
    const withUnique = { Doc: { fields: [], indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }] } };
    store.registerModel("Doc", withUnique.Doc.indexes);
    await seed(store);
    await runMigrations(store, [tier], { models: withUnique });

    store.save("Doc", { uuid: "d3", email: "a@x" }, ctx);
    store.save("Doc", { uuid: "d4", email: "a@x" }, ctx);
    await expect(store.persist(ctx)).rejects.toThrow(); // still enforced
  });
});
