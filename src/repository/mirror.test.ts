/**
 * The compatibility window, driven the way it is actually experienced: two builds with different
 * property maps, running against one store at the same time.
 *
 * That is the steady state during a rolling deploy and the whole point of gating a rename — so the
 * assertions here are about *convergence between generations*, not about either one in isolation.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { RepositoryManager } from "./RepositoryManager.js";
import { text } from "../properties/factories.js";
import { eq, neq, and, or, field } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Backend, FieldSpec } from "../core/Backend.js";
import type { QueryPlan, ExpressionNode } from "../core/QueryPlan.js";
import type { Context, JsonObject } from "../core/types.js";
import { substituteNode, substituteValue, substituteAggregate, substituteWindow, substitutePlan } from "./mirror.js";

const ctx = SYSTEM_CONTEXT;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** The build that predates the rename: it only knows `name`. */
const oldBuild = (backend: Backend) =>
  new RepositoryManager({ backend }).define({ name: "User", properties: { name: text() } });

/**
 * The build after the rename, mid-window: `fullName` is what the code uses, while `name` is still
 * declared, still authoritative in the store, and marked for removal at version 7.
 */
const newBuild = (backend: Backend) =>
  new RepositoryManager({ backend, schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 } }).define({
    name: "User",
    properties: {
      fullName: text(),
      name: text({ deprecatedSince: 7, mirrors: "fullName" })
    }
  });

const BACKENDS: Array<[string, () => Backend]> = [
  ["InMemory", () => new InMemoryBackend()],
  ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))]
];

describe("both generations converge on the same value", () => {
  for (const [label, make] of BACKENDS) {
    it(`${label}: a write from the old build is visible to the new one`, async () => {
      const backend = make();
      const legacy = oldBuild(backend);
      legacy.save(legacy.createInstance({ uuid: "u1", name: "Ann" }));
      await legacy.persist();

      const current = newBuild(backend);
      expect((await current.get("u1"))!.fullName).toBe("Ann");
    });

    it(`${label}: a write from the new build is visible to the old one`, async () => {
      const backend = make();
      const current = newBuild(backend);
      current.save(current.createInstance({ uuid: "u1", fullName: "Bo" }));
      await current.persist();

      const legacy = oldBuild(backend);
      expect((await legacy.get("u1"))!.name).toBe("Bo");
    });

    it(`${label}: the old build's later edit wins, because its field is the authoritative one`, async () => {
      const backend = make();
      const current = newBuild(backend);
      current.save(current.createInstance({ uuid: "u1", fullName: "Bo" }));
      await current.persist();

      // An old instance, still deployed, updates the only field it knows about.
      const legacy = oldBuild(backend);
      const record = (await legacy.get("u1"))!;
      record.name = "Bo-updated";
      legacy.save(record);
      await legacy.persist();

      // A coalescing reader would return the stale "Bo" here — the legacy field is authoritative
      // precisely so that it doesn't.
      const reread = newBuild(backend);
      expect((await reread.get("u1"))!.fullName).toBe("Bo-updated");
    });

    it(`${label}: an old-build read-modify-write does not lose the new field`, async () => {
      const backend = make();
      const current = newBuild(backend);
      current.save(current.createInstance({ uuid: "u1", fullName: "Ann" }));
      await current.persist();

      const legacy = oldBuild(backend);
      const record = (await legacy.get("u1"))!;
      legacy.save(record); // no change, but a full write through a narrower property map
      await legacy.persist();

      expect((await newBuild(backend).get("u1"))!.fullName).toBe("Ann");
    });
  }
});

describe("queries name the canonical field and still find the data", () => {
  it("filters on the new name against a row only the old build ever wrote", async () => {
    const backend = new InMemoryBackend();
    const legacy = oldBuild(backend);
    legacy.save(legacy.createInstance({ uuid: "u1", name: "Ann" }));
    legacy.save(legacy.createInstance({ uuid: "u2", name: "Bo" }));
    await legacy.persist();

    const found = await newBuild(backend).all().filter(eq("fullName", "Ann")).list();
    expect(found.map((row) => row.uuid)).toEqual(["u1"]);
  });

  it("sorts by the new name", async () => {
    const backend = new InMemoryBackend();
    const legacy = oldBuild(backend);
    legacy.save(legacy.createInstance({ uuid: "u1", name: "Zoe" }));
    legacy.save(legacy.createInstance({ uuid: "u2", name: "Ann" }));
    await legacy.persist();

    const sorted = await newBuild(backend).all().sort("fullName").list();
    expect(sorted.map((row) => row.uuid)).toEqual(["u2", "u1"]);
  });
});

describe("every plan-taking entry point substitutes, not just the filter", () => {
  /** Captures the plans that actually reach the backend. */
  function capturing(): { backend: Backend; plans: QueryPlan[] } {
    const inner = new InMemoryBackend();
    const plans: QueryPlan[] = [];
    const backend: Backend = {
      capabilities: inner.capabilities,
      query: (plan, c) => {
        plans.push(plan);
        return inner.query(plan, c);
      },
      queryUuids: (plan, c) => {
        plans.push(plan);
        return inner.queryUuids(plan, c);
      },
      save: (model, record, c: Context, dirty) => inner.save(model, record, c, dirty),
      remove: (model, record, c) => inner.remove(model, record, c),
      persist: (c) => inner.persist(c),
      changes: (listener, c) => inner.changes(listener, c)
    };
    return { backend, plans };
  }

  const namesIn = (node: ExpressionNode): string[] => {
    const found: string[] = [];
    const walk = (candidate: unknown): void => {
      if (typeof candidate !== "object" || candidate === null) return;
      const record = candidate as Record<string, unknown>;
      if (typeof record.property === "string") found.push(record.property);
      for (const value of Object.values(record)) {
        if (Array.isArray(value)) value.forEach(walk);
        else walk(value);
      }
    };
    walk(node);
    return found;
  };

  it("rewrites the filter, the sort key and the projection", async () => {
    const { backend, plans } = capturing();
    const users = newBuild(backend);
    users.save(users.createInstance({ uuid: "u1", fullName: "Ann" }));
    await users.persist();
    plans.length = 0;

    await users.all().filter(eq("fullName", "Ann")).sort("fullName").select({ fullName: true });

    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(namesIn(plan.where)).not.toContain("fullName");
      expect(plan.order.map((key) => key.property)).not.toContain("fullName");
      expect(plan.project ?? []).not.toContain("fullName");
    }
  });

  it("rewrites a count's filter too", async () => {
    const { backend, plans } = capturing();
    const users = newBuild(backend);
    users.save(users.createInstance({ uuid: "u1", fullName: "Ann" }));
    await users.persist();
    plans.length = 0;

    expect(await users.all().filter(eq("fullName", "Ann")).count()).toBe(1);
    for (const plan of plans) expect(namesIn(plan.where)).not.toContain("fullName");
  });
});

describe("a retired field goes inert once the floor passes it", () => {
  it("stops being provisioned, so the auto-provisioner cannot resurrect a dropped column", async () => {
    const registered: FieldSpec[][] = [];
    const backend = Object.assign(new InMemoryBackend(), {
      registerModel: (_model: string, _indexes: unknown[], fields?: FieldSpec[]) => {
        registered.push(fields ?? []);
      }
    }) as unknown as Backend;

    // Window closed: minSupported has reached the version at which `name` was deprecated.
    new RepositoryManager({ backend, schema: { schemaVersion: 7, minSupportedSchemaVersion: 7 } }).define({
      name: "User",
      properties: { fullName: text(), name: text({ deprecatedSince: 7, mirrors: "fullName" }) }
    });

    expect(registered[0]!.map((field) => field.name)).toEqual(["fullName"]);
  });

  it("still provisions it while the window is open", async () => {
    const registered: FieldSpec[][] = [];
    const backend = Object.assign(new InMemoryBackend(), {
      registerModel: (_model: string, _indexes: unknown[], fields?: FieldSpec[]) => {
        registered.push(fields ?? []);
      }
    }) as unknown as Backend;

    new RepositoryManager({ backend, schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 } }).define({
      name: "User",
      properties: { fullName: text(), name: text({ deprecatedSince: 7, mirrors: "fullName" }) }
    });

    expect(registered[0]!.map((field) => field.name).sort()).toEqual(["fullName", "name"]);
  });
});

describe("define() refuses a window that cannot hold", () => {
  const backend = () => new InMemoryBackend();

  it("refuses a mirror of something that is not a declared scalar", () => {
    expect(() =>
      new RepositoryManager({ backend: backend() }).define({
        name: "User",
        properties: { name: text({ deprecatedSince: 7, mirrors: "nope" }) }
      })
    ).toThrow(/not a declared scalar/);
  });

  it("refuses a mirror with no gate to close", () => {
    expect(() =>
      new RepositoryManager({ backend: backend() }).define({
        name: "User",
        properties: { fullName: text(), name: text({ mirrors: "fullName" }) }
      })
    ).toThrow(/without `deprecatedSince`/);
  });

  it("refuses a unique constraint on the canonical half", () => {
    // Two unique constraints over one logical value would double-report, and the legacy field already
    // carries the constraint until the contract runs.
    expect(() =>
      new RepositoryManager({ backend: backend() }).define({
        name: "User",
        properties: { fullName: text({ unique: true }), name: text({ deprecatedSince: 7, mirrors: "fullName" }) }
      })
    ).toThrow(/cannot be `unique`/);
  });

  it("refuses a chained window", () => {
    expect(() =>
      new RepositoryManager({ backend: backend() }).define({
        name: "User",
        properties: {
          c: text(),
          b: text({ deprecatedSince: 8, mirrors: "c" }),
          a: text({ deprecatedSince: 7, mirrors: "b" })
        }
      })
    ).toThrow(/Chained windows are not supported/);
  });
});

describe("the store's shape during a window", () => {
  it("keeps the legacy field populated, since that is what an old reader reads", async () => {
    const backend = new InMemoryBackend();
    const users = newBuild(backend);
    users.save(users.createInstance({ uuid: "u1", fullName: "Ann" }));
    await users.persist();

    const [row] = (await backend.query(
      { model: "User", where: eq("uuid", "u1").serialize(), order: [], paging: { start: 0 } },
      ctx
    )) as JsonObject[];
    expect(row).toMatchObject({ name: "Ann", fullName: "Ann" });
  });
});

describe("substitution reaches every corner of a plan", () => {
  const mirrors = new Map([["fullName", "name"]]);

  it("rewrites nested boolean structure, not just a top-level comparison", () => {
    const where = and(eq("fullName", "Ann"), or(neq("fullName", "Bo"), eq("other", 1))).serialize();
    const rewritten = substituteNode(where, mirrors);

    const names = JSON.stringify(rewritten);
    expect(names).not.toContain("fullName");
    expect(names).toContain("name");
    // ...and leaves unrelated properties alone.
    expect(names).toContain("other");
  });

  it("rewrites aggregate group keys and the value expressions being reduced", () => {
    const plan = substituteAggregate(
      {
        model: "User",
        where: eq("fullName", "Ann").serialize(),
        groupBy: [field("fullName").serialize()],
        aggregates: [{ name: "n", op: "count" }, { name: "m", op: "max", value: field("fullName").serialize() }]
      },
      mirrors
    );

    expect(JSON.stringify(plan)).not.toContain("fullName");
    expect(plan.aggregates[0]).toEqual({ name: "n", op: "count" }); // a valueless stage is untouched
  });

  it("rewrites window partition keys and ordering", () => {
    const plan = substituteWindow(
      {
        model: "User",
        where: eq("fullName", "Ann").serialize(),
        partitionBy: [field("fullName").serialize()],
        order: [{ property: "fullName", descending: true }],
        functions: [{ name: "rank", kind: "rank" }]
      },
      mirrors
    );

    expect(JSON.stringify(plan)).not.toContain("fullName");
    expect(plan.order[0]).toEqual({ property: "name", descending: true });
  });

  it("is a no-op with no mirrors, returning the plan unchanged", () => {
    const empty = new Map<string, string>();
    const where = eq("fullName", "Ann").serialize();
    expect(substituteNode(where, empty)).toBe(where);
    expect(substituteValue(field("fullName").serialize(), empty)).toBeDefined();
    const plan = { model: "User", where, order: [], paging: { start: 0 } };
    expect(substitutePlan(plan, empty)).toBe(plan);
  });
});
