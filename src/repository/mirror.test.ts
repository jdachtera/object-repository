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
import { text, integer, relationToOne, scalar } from "../properties/factories.js";
import { switchExpr, cmp } from "../expressions/values.js";
import { any } from "../expressions/builders.js";
import { liveQuery } from "./liveQuery.js";
import { PolicyBackend } from "../backends/decorators/PolicyBackend.js";
import { eq, neq, and, or, field } from "../expressions/index.js";
import { set } from "./patch.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { Backend, FieldSpec } from "../core/Backend.js";
import type { QueryPlan, ExpressionNode } from "../core/QueryPlan.js";
import type { Context, JsonObject } from "../core/types.js";
import { substituteNode, substituteValue, substituteAggregate, substituteWindow, substitutePlan } from "./mirror.js";
import { newDb } from "pg-mem";
import { PostgresBackend } from "../backends/sql/PostgresBackend.js";
import type { MigrationBuilder } from "../migrations/types.js";

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
  ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))],
  [
    "Postgres (pg-mem)",
    () => {
      const { Pool } = newDb().adapters.createPg();
      return new PostgresBackend(new Pool());
    }
  ]
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

describe("a window closes when its contract runs — not when the floor rises", () => {
  const rename = { name: "0012_fullname", schemaVersion: 7, up: (m: MigrationBuilder) => m.renameField("User", "name", "fullName", "text") };
  const build = (backend: Backend, minSupportedSchemaVersion: number) => {
    const orm = new RepositoryManager({ backend, schema: { schemaVersion: 7, minSupportedSchemaVersion } });
    const users = orm.define({
      name: "User",
      properties: { fullName: text(), name: text({ deprecatedSince: 7, mirrors: "fullName" }) }
    });
    return { orm, users };
  };
  const STORES: Array<[string, () => Backend]> = [
    ["InMemory", () => new InMemoryBackend()],
    ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))],
    [
      "Postgres (pg-mem)",
      () => {
        const { Pool } = newDb().adapters.createPg();
        return new PostgresBackend(new Pool());
      }
    ]
  ];

  it.each(STORES)("follows the documented timeline without losing a write (%s)", async (_name, make) => {
    const backend = make();
    // 0. The old build's data.
    const before = new RepositoryManager({ backend }).define({ name: "User", properties: { name: text() } });
    await before.save(before.createInstance({ name: "Ann" })).persist();

    // 1. Ship the migration: expand only.
    const step1 = build(backend, 5);
    await step1.orm.migrate([rename]);

    // 3. Raise the floor. The contract is permitted but hasn't run, so the legacy field is still the
    //    authoritative copy — a write made now must land in it, or the release re-copies over it.
    const step3 = build(backend, 7);
    await step3.orm.migrate([rename]);
    const [ann] = await step3.users.all().list();
    ann!.fullName = "Ann Lee";
    await step3.users.save(ann!).persist();

    // 4. Release it, deliberately.
    const report = await step3.orm.migrate([rename], { applyContracts: true });
    expect(report.contracted).toEqual(["0012_fullname"]);

    // The same process now treats the window as closed: canonical reads, no resurrection.
    expect((await step3.users.all().filter(eq("fullName", "Ann Lee")).list()).map((u) => u.fullName)).toEqual(["Ann Lee"]);
    const [again] = await step3.users.all().list();
    again!.fullName = "Ann Lee-Smith";
    await step3.users.save(again!).persist();
    const [row] = await backend.query({ model: "User", where: { type: "all" }, order: [], paging: { start: 0 } }, ctx);
    expect(row).toMatchObject({ fullName: "Ann Lee-Smith" });
    expect(row!.name ?? null).toBeNull(); // the dropped field stays dropped
    if (backend instanceof PostgresBackend) {
      const columns = await backend.raw(
        { sql: `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, params: ["User"] },
        ctx
      );
      expect(columns.map((c) => c.column_name)).not.toContain("name"); // not re-provisioned, empty
    }

    // A fresh process that still declares the property learns the window is closed from the journal.
    const restarted = build(backend, 7);
    expect((await restarted.users.all().filter(eq("fullName", "Ann Lee-Smith")).list())).toHaveLength(1);

    // …and neither its registration nor a save made before it has read the journal re-creates or
    // writes the legacy field.
    const early = build(backend, 7);
    await early.users.save(early.users.createInstance({ uuid: "u2", fullName: "Bo" })).persist();
    const rows = await backend.query({ model: "User", where: { type: "all" }, order: [], paging: { start: 0 } }, ctx);
    expect(rows.find((r) => r.uuid === "u2")).toEqual({ uuid: "u2", fullName: "Bo" });
    if (backend instanceof PostgresBackend) {
      const columns = await backend.raw(
        { sql: `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, params: ["User"] },
        ctx
      );
      expect(columns.map((c) => c.column_name)).not.toContain("name");
    }
  });

  it("writes a save held before the journal was read on any repository's persist", async () => {
    const backend = new InMemoryBackend();
    const { orm, users } = build(backend, 5);
    const posts = orm.define({ name: "Post", properties: { title: text() } });
    users.save(users.createInstance({ uuid: "u1", fullName: "Ann" })); // held: the journal isn't read yet
    await posts.save(posts.createInstance({ uuid: "p1", title: "Hi" })).persist();
    const stored = await backend.query({ model: "User", where: { type: "all" }, order: [], paging: { start: 0 } }, ctx);
    expect(stored.map((row) => row.uuid)).toEqual(["u1"]);
  });

  it("provisions the legacy column while the window is open, whatever the floor", async () => {
    const registered: FieldSpec[][] = [];
    const backend = Object.assign(new InMemoryBackend(), {
      registerModel: (model: string, _indexes: unknown[], fields?: FieldSpec[]) => {
        if (model === "User") registered.push(fields ?? []);
      }
    }) as unknown as Backend;
    const { orm } = build(backend, 7);
    await (orm as unknown as { windows: { ready: Promise<void> } }).windows.ready; // registered once the journal is read
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

describe("writes through either name stay in step", () => {
  for (const [label, make] of BACKENDS) {
    it(`${label}: an old build clearing the field is not undone by the new build's next save`, async () => {
      const backend = make();
      const current = newBuild(backend);
      current.save(current.createInstance({ uuid: "u1", fullName: "Ann", ...({} as object) }));
      await current.persist();

      const legacy = oldBuild(backend);
      const record = (await legacy.get("u1"))!;
      record.name = null as unknown as string;
      legacy.save(record);
      await legacy.persist();

      const reread = newBuild(backend);
      const user = (await reread.get("u1"))!;
      expect(user.fullName ?? null).toBeNull();
      reread.save(user); // an unrelated save must not resurrect "Ann"
      await reread.persist();
      expect((await oldBuild(backend).get("u1"))!.name ?? null).toBeNull();
    });

    it(`${label}: clearing the canonical field clears the legacy one`, async () => {
      const backend = make();
      const current = newBuild(backend);
      current.save(current.createInstance({ uuid: "u1", fullName: "Ann" }));
      await current.persist();

      const later = newBuild(backend); // a fresh process: the loaded instance carries both halves
      const user = (await later.get("u1"))!;
      delete (user as { fullName?: string }).fullName;
      later.save(user);
      await later.persist();
      expect((await oldBuild(backend).get("u1"))!.name ?? null).toBeNull();
    });

    it(`${label}: patchWhere and upsert find rows by the canonical name`, async () => {
      const backend = make();
      const legacy = oldBuild(backend);
      legacy.save(legacy.createInstance({ uuid: "u1", name: "Ann" }));
      await legacy.persist();

      const current = newBuild(backend);
      expect(await current.patchWhere(eq("fullName", "Ann"), { fullName: set("Ann Lee") })).toBe(1);
      expect((await oldBuild(backend).get("u1"))!.name).toBe("Ann Lee"); // the patch reached the legacy half

      const matched = await current.upsert(eq("fullName", "Ann Lee"), { set: { fullName: "Ann Lee" } });
      expect(matched.uuid).toBe("u1"); // matched the old build's row rather than inserting a duplicate
      expect(await current.all().count()).toBe(1);

      const inserted = await current.upsert(eq("fullName", "Cy"), { setOnInsert: { fullName: "Cy" } });
      expect((await oldBuild(backend).get(inserted.uuid))!.name).toBe("Cy"); // written through on insert
    });
  }

  it("a required legacy half is satisfied by a write through the canonical name", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend(), schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 } });
    const users = orm.define({
      name: "User",
      properties: { fullName: text(), name: text({ required: true, deprecatedSince: 7, mirrors: "fullName" }) }
    });
    users.save(users.createInstance({ fullName: "Ann" }));
    await expect(users.persist()).resolves.toBeDefined();
  });
});

describe("substitution reaches every place a field is named", () => {
  const mirrors = new Map([["fullName", "name"]]);

  it("rewrites inside switch branches", () => {
    const node = switchExpr([[cmp(field("fullName"), "=", "Ann"), 1]], 0).serialize() as unknown as { branches: Array<{ when: unknown }> };
    const out = substituteValue(node as never, mirrors) as unknown as { branches: Array<{ when: unknown }> };
    expect(JSON.stringify(out.branches[0]!.when)).toContain('"name"');
    expect(JSON.stringify(out.branches[0]!.when)).not.toContain("fullName");
  });

  it("leaves an any() predicate alone — it names the element's fields, not the model's", () => {
    const node = any("aliases", eq("fullName", "x")).serialize();
    expect(substituteNode(node, new Map([["aliases", "oldAliases"], ["fullName", "name"]]))).toEqual({
      ...node,
      property: "oldAliases"
    });
  });
});

describe("the window holds beyond plain queries", () => {
  it("wakes a live query naming the canonical field when an old build writes the legacy one", async () => {
    const backend = new InMemoryBackend();
    const current = newBuild(backend);
    current.save(current.createInstance({ uuid: "u1", fullName: "Ann" }));
    await current.persist();

    const live = liveQuery(current.all().filter(eq("fullName", "Bo")));
    live.subscribe(() => {});
    for (let i = 0; i < 50 && live.getSnapshot().data === undefined; i++) await Promise.resolve();
    expect(live.getSnapshot().data).toEqual([]);

    const legacy = oldBuild(backend);
    const record = (await legacy.get("u1"))!;
    record.name = "Bo";
    legacy.save(record);
    await legacy.persist();

    for (let i = 0; i < 50 && live.getSnapshot().data?.length !== 1; i++) await new Promise((r) => setTimeout(r, 0));
    expect(live.getSnapshot().data!.map((u) => u.fullName)).toEqual(["Bo"]);
  });

  it("projects a related record's canonical field from the legacy half", async () => {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend, schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 } });
    const users = orm.define({ name: "User", properties: { fullName: text(), name: text({ deprecatedSince: 7, mirrors: "fullName" }) } });
    const orders = orm.define({ name: "Order", properties: { buyer: relationToOne({ model: "User" }) } });
    const ann = users.createInstance({ uuid: "u1", fullName: "Ann" });
    users.save(ann);
    orders.save(orders.createInstance({ uuid: "o1", buyer: ann } as never));
    await orm.transaction(async () => {});
    await users.persist();

    const legacy = oldBuild(backend);
    const record = (await legacy.get("u1"))!;
    record.name = "Ann Lee";
    legacy.save(record);
    await legacy.persist();

    const fresh = new RepositoryManager({ backend, schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 } });
    fresh.define({ name: "User", properties: { fullName: text(), name: text({ deprecatedSince: 7, mirrors: "fullName" }) } });
    const freshOrders = fresh.define({ name: "Order", properties: { buyer: relationToOne({ model: "User" }) } });
    const [row] = (await freshOrders.all().select({ buyer: { fullName: true } })) as Array<{ buyer: { fullName: string } }>;
    expect(row!.buyer.fullName).toBe("Ann Lee");
  });

  it("substitutes a dotted path into an embedded model's own window", async () => {
    const backend = new InMemoryBackend();
    backend.save("Order", { uuid: "o1", shipTo: { uuid: "a1", city: "Oslo", town: "stale" } }, ctx);
    await backend.persist(ctx);

    const orm = new RepositoryManager({ backend, schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 } });
    orm.define({ name: "Address", properties: { town: text(), city: text({ deprecatedSince: 7, mirrors: "town" }) } });
    const orders = orm.define({ name: "Order", properties: { shipTo: relationToOne({ model: "Address", storage: "embed" }) } });
    expect(await orders.all().filter(eq("shipTo.town", "Oslo")).count()).toBe(1);
  });

  it("applies a read policy naming the canonical field to the legacy half", async () => {
    const store = new InMemoryBackend();
    const policy = new PolicyBackend(store, {
      read: (_model, context) => eq("owner", String((context as unknown as { user: string }).user))
    });
    const asUser = (user: string) =>
      new RepositoryManager({
        backend: policy,
        context: { ...ctx, user } as unknown as Context,
        schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 }
      }).define({ name: "Doc", properties: { owner: text(), ownerId: text({ deprecatedSince: 7, mirrors: "owner" }) } });

    const alice = asUser("alice");
    alice.save(alice.createInstance({ uuid: "d1", owner: "alice" }));
    await alice.persist();
    // An old build, beneath the policy, hands the record to bob through the only field it knows.
    store.save("Doc", { uuid: "d1", owner: "alice", ownerId: "bob" }, ctx);
    await store.persist(ctx);

    expect(await asUser("alice").all().count()).toBe(0);
    expect(await asUser("bob").all().count()).toBe(1);
  });
});

describe("define() refuses a window whose halves differ in type", () => {
  it("refuses an integer canonical over a text legacy field", () => {
    expect(() =>
      new RepositoryManager({ backend: new InMemoryBackend() }).define({
        name: "Item",
        properties: { quantity: integer(), qty: text({ deprecatedSince: 7, mirrors: "quantity" }) }
      })
    ).toThrow(/same type/);
  });
});

describe("scalar() with a custom codec", () => {
  it("keeps its window options", () => {
    const codec = { encode: (v: string) => v, decode: (v: unknown) => String(v) };
    const schema = text()["schema" as never];
    const legacy = scalar(schema, codec, { deprecatedSince: 7, mirrors: "fullName" });
    expect([legacy.deprecatedSince, legacy.mirrors]).toEqual([7, "fullName"]);
  });
});
