/**
 * Regression: a decorator must forward the whole `SchemaAwareBackend` contract, and must not claim a
 * capability its inner backend lacks.
 *
 * Dropping `registerModel`'s `fields` argument left a SQL store behind the decorator provisioning a
 * `(uuid, _extra)` table with no typed columns and no indexes — the same class of bug `rawQuery.test.ts`
 * pins for `PolicyBackend`. Declaring `migrate` unconditionally (and throwing inside) made
 * `isMigratable()` answer for the decorator rather than for the stack, turning a checkable boolean
 * into a runtime failure.
 */
import { describe, it, expect } from "vitest";
import { HooksBackend } from "./decorators/HooksBackend.js";
import { PolicyBackend } from "./decorators/PolicyBackend.js";
import { SyncBackend } from "../sync/SyncBackend.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { isMigratable } from "./sql/migrate.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all } from "../expressions/index.js";
import type { Backend, FieldSpec, IndexSpec, SchemaAwareBackend } from "../core/Backend.js";
import type { SyncTarget } from "../core/SyncTarget.js";

interface Registration {
  model: string;
  indexes: IndexSpec[];
  fields?: FieldSpec[];
}

/** An in-memory store that also records exactly what `registerModel` was handed. */
class RecordingBackend extends InMemoryBackend implements SchemaAwareBackend {
  readonly registrations: Registration[] = [];
  registerModel(model: string, indexes: IndexSpec[], fields?: FieldSpec[]): void {
    this.registrations.push({ model, indexes, fields });
  }
}

const FIELDS: FieldSpec[] = [
  { name: "name", type: "text" },
  { name: "age", type: "integer" }
];
const INDEXES: IndexSpec[] = [{ name: "by_name", fields: [{ path: "name" }] }];

const idleTarget: SyncTarget = {
  pull: async () => ({ changes: [], cursor: "0" }),
  push: async () => ({ acknowledged: [], conflicts: [] })
};

describe("decorators forward the schema contract", () => {
  it("HooksBackend passes `fields` through to the inner store", () => {
    const inner = new RecordingBackend();
    new HooksBackend(inner, {}).registerModel("User", INDEXES, FIELDS);

    expect(inner.registrations).toEqual([{ model: "User", indexes: INDEXES, fields: FIELDS }]);
  });

  it("SyncBackend passes `fields` through to the local store", () => {
    const inner = new RecordingBackend();
    const sync = new SyncBackend({ local: inner, remote: idleTarget });
    inner.registrations.length = 0; // drop the constructor's own `_outbox` registration
    sync.registerModel("User", INDEXES, FIELDS);

    expect(inner.registrations).toEqual([{ model: "User", indexes: INDEXES, fields: FIELDS }]);
  });
});

describe("decorators report capabilities honestly", () => {
  it("PolicyBackend over a non-migratable store is not migratable", () => {
    expect(isMigratable(new PolicyBackend(new InMemoryBackend(), {}))).toBe(false);
  });

  it("PolicyBackend over a migratable store is migratable, and forwards", async () => {
    let seen: string[] = [];
    const migratable = Object.assign(new InMemoryBackend(), {
      migrate: async (migrations: { name: string }[]) => {
        seen = migrations.map((m) => m.name);
        return { applied: seen, skipped: [] };
      },
      rollback: async () => ({ applied: [], skipped: [] })
    }) as unknown as Backend;

    const policy = new PolicyBackend(migratable, {});
    expect(isMigratable(policy)).toBe(true);

    const report = await policy.migrate!([{ name: "m1", up: () => undefined }]);
    expect(seen).toEqual(["m1"]);
    expect(report.applied).toEqual(["m1"]);
  });

  it("still enforces its read policy over a migratable inner store", async () => {
    const inner = new InMemoryBackend();
    const policy = new PolicyBackend(inner, { read: () => null });
    policy.save("Note", { uuid: "n1", title: "t" }, SYSTEM_CONTEXT);
    await policy.persist(SYSTEM_CONTEXT);
    const plan = { model: "Note", where: all().serialize(), order: [], paging: { start: 0 } };
    expect(await policy.queryUuids(plan, SYSTEM_CONTEXT)).toEqual(["n1"]);
  });
});
