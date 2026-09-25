/**
 * The reference executor. These assertions ARE the specification of what each op means — every
 * backend's native lowering is later held to producing exactly this record set.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { applyOp, type ExecuteOptions } from "./execute.js";
import { SchemaUnknownError, MigrationNotSupportedError } from "./errors.js";
import { everything } from "./paging.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { eq } from "../expressions/index.js";
import type { Backend, FieldSpec, IndexSpec, PersistedChange } from "../core/Backend.js";
import type { Context, JsonObject } from "../core/types.js";
import type { Migration, MigrationOp, RecordTransform } from "./types.js";
import { runMigrations } from "./run.js";

const ctx = SYSTEM_CONTEXT;

const options = (over: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
  ctx,
  batchSize: 2, // deliberately tiny, so every case exercises multi-page paging
  migration: "m",
  phase: "expand",
  // Every store here is schema-aware, so the executor requires a declared layout — in real use
  // `RepositoryManager.migrate` fills this from its own model definitions.
  models: { M: { fields: [], indexes: [] } },
  transforms: {},
  ...over
});

async function seeded(rows: JsonObject[]): Promise<InMemoryBackend> {
  const backend = new InMemoryBackend();
  for (const row of rows) backend.save("M", row, ctx);
  await backend.persist(ctx);
  return backend;
}

const readAll = async (backend: Backend): Promise<JsonObject[]> => {
  const rows = await backend.query({ model: "M", where: everything(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctx);
  return rows;
};

describe("applyOp — reference semantics", () => {
  it("dropField removes the key everywhere it is present", async () => {
    const backend = await seeded([
      { uuid: "a", name: "Ann", legacy: 1 },
      { uuid: "b", name: "Bo" },
      { uuid: "c", name: "Cy", legacy: 3 }
    ]);
    const result = await applyOp(backend, { kind: "dropField", model: "M", field: "legacy" }, options());

    expect(result.rows).toBe(2); // only the two that had it
    expect(await readAll(backend)).toEqual([
      { uuid: "a", name: "Ann" },
      { uuid: "b", name: "Bo" },
      { uuid: "c", name: "Cy" }
    ]);
  });

  it("addField only writes when a fill is given, and never overwrites", async () => {
    const backend = await seeded([{ uuid: "a" }, { uuid: "b", tier: "gold" }]);

    expect((await applyOp(backend, { kind: "addField", model: "M", field: "tier", type: "text" }, options())).rows).toBe(0);

    await applyOp(backend, { kind: "addField", model: "M", field: "tier", type: "text", fill: "free" }, options());
    expect(await readAll(backend)).toEqual([
      { uuid: "a", tier: "free" },
      { uuid: "b", tier: "gold" }
    ]);
  });

  it("copyField respects the overwrite polarity that makes a rename window safe", async () => {
    const rows: JsonObject[] = [
      { uuid: "a", legacy: "L", canonical: "C" }, // a new build already wrote `canonical`
      { uuid: "b", legacy: "L" } // only the old build has written
    ];

    const gentle = await seeded(rows);
    await applyOp(gentle, { kind: "copyField", model: "M", from: "legacy", to: "canonical", type: "text", overwrite: false }, options());
    expect(await readAll(gentle)).toEqual([
      { uuid: "a", legacy: "L", canonical: "C" }, // preserved — must not clobber a new-build write
      { uuid: "b", legacy: "L", canonical: "L" }
    ]);

    const forceful = await seeded(rows);
    await applyOp(forceful, { kind: "copyField", model: "M", from: "legacy", to: "canonical", type: "text", overwrite: true }, options());
    expect(await readAll(forceful)).toEqual([
      { uuid: "a", legacy: "L", canonical: "L" }, // adopted — closing the window takes the legacy value
      { uuid: "b", legacy: "L", canonical: "L" }
    ]);
  });

  it("copyField distinguishes a stored null from an absent key", async () => {
    const backend = await seeded([{ uuid: "a", from: null }, { uuid: "b" }]);
    await applyOp(backend, { kind: "copyField", model: "M", from: "from", to: "to", type: "text", overwrite: false }, options());

    // `null` is a value and copies; an absent key has nothing to copy.
    expect(await readAll(backend)).toEqual([{ uuid: "a", from: null, to: null }, { uuid: "b" }]);
  });

  it("renameField moves the value and removes the old key", async () => {
    const backend = await seeded([{ uuid: "a", name: "Ann" }, { uuid: "b" }]);
    await applyOp(backend, { kind: "renameField", model: "M", from: "name", to: "fullName", type: "text" }, options());

    expect(await readAll(backend)).toEqual([{ uuid: "a", fullName: "Ann" }, { uuid: "b" }]);
  });

  it("retypeField coerces through the shared table", async () => {
    const backend = await seeded([{ uuid: "a", n: 3 }, { uuid: "b", n: 4 }]);
    await applyOp(backend, { kind: "retypeField", model: "M", field: "n", from: "integer", to: "text" }, options());

    expect(await readAll(backend)).toEqual([{ uuid: "a", n: "3" }, { uuid: "b", n: "4" }]);
  });

  it("transform rewrites, and removes the records it returns null for", async () => {
    const backend = await seeded([
      { uuid: "a", keep: true, n: 1 },
      { uuid: "b", keep: false, n: 2 },
      { uuid: "c", keep: true, n: 3 }
    ]);
    const double: RecordTransform = (row) => (row.keep ? { ...row, n: (row.n as number) * 2 } : null);

    await applyOp(
      backend,
      { kind: "transform", model: "M", transform: "double", fields: ["n"] },
      options({ transforms: { double } })
    );

    expect(await readAll(backend)).toEqual([
      { uuid: "a", keep: true, n: 2 },
      { uuid: "c", keep: true, n: 6 }
    ]);
  });

  it("transform honours a where filter", async () => {
    const backend = await seeded([{ uuid: "a", tier: "free" }, { uuid: "b", tier: "paid" }]);
    const mark: RecordTransform = (row) => ({ ...row, marked: true });

    await applyOp(
      backend,
      { kind: "transform", model: "M", transform: "mark", fields: ["marked"], where: eq("tier", "paid").serialize() },
      options({ transforms: { mark } })
    );

    expect(await readAll(backend)).toEqual([{ uuid: "a", tier: "free" }, { uuid: "b", tier: "paid", marked: true }]);
  });

  it("dropModel drains every record", async () => {
    const backend = await seeded([{ uuid: "a" }, { uuid: "b" }, { uuid: "c" }]);
    const result = await applyOp(backend, { kind: "dropModel", model: "M" }, options());

    expect(result.rows).toBe(3);
    expect(await readAll(backend)).toEqual([]);
  });

  it("throws for a transform id the migration never declared", async () => {
    const backend = await seeded([{ uuid: "a" }]);
    await expect(
      applyOp(backend, { kind: "transform", model: "M", transform: "missing", fields: [] }, options())
    ).rejects.toThrow(/not in the migration's `transforms` map/);
  });

  it("throws for raw SQL, rather than skipping it", async () => {
    const backend = await seeded([{ uuid: "a" }]);
    await expect(
      applyOp(backend, { kind: "rawSql", dialect: "*", statement: "SELECT 1", params: [], phase: "expand" }, options())
    ).rejects.toThrow(MigrationNotSupportedError);
  });
});

describe("executor invariants", () => {
  /** Wraps a backend to capture the `dirty` hints the executor emits. */
  function capturing(inner: Backend): { backend: Backend; saves: PersistedChange[] } {
    const saves: PersistedChange[] = [];
    const backend: Backend = {
      capabilities: inner.capabilities,
      query: (plan, c) => inner.query(plan, c),
      queryUuids: (plan, c) => inner.queryUuids(plan, c),
      save: (model, rec, c: Context, dirty) => {
        saves.push({ model, record: rec, dirty });
        inner.save(model, rec, c, dirty);
      },
      remove: (model, rec, c) => inner.remove(model, rec, c),
      persist: (c) => inner.persist(c),
      changes: (listener, c) => inner.changes(listener, c)
    };
    return { backend, saves };
  }

  it("always passes an explicit dirty hint that includes uuid", async () => {
    // Without a hint, Mongo writes `$set: <whole record>` and an absent key keeps its stored value,
    // so a save-based dropField would silently no-op there.
    const { backend, saves } = capturing(await seeded([{ uuid: "a", legacy: 1 }]));
    await applyOp(backend, { kind: "dropField", model: "M", field: "legacy" }, options());

    expect(saves).toHaveLength(1);
    expect(saves[0]!.dirty).toEqual(["uuid", "legacy"]);
  });

  it("never lists uuid twice, even when an op names it", async () => {
    const { backend, saves } = capturing(await seeded([{ uuid: "a", n: 1 }]));
    const identity: RecordTransform = (row) => ({ ...row, n: 2 });
    await applyOp(
      backend,
      { kind: "transform", model: "M", transform: "id", fields: ["uuid", "n"] },
      options({ transforms: { id: identity } })
    );

    expect(saves[0]!.dirty).toEqual(["uuid", "n"]);
  });

  it("refuses a generic pass against a columnar backend with no registered layout", async () => {
    const fields: FieldSpec[] = [{ name: "name", type: "text" }];
    const indexes: IndexSpec[] = [];
    const registrations: string[] = [];
    const inner = new InMemoryBackend();
    const schemaAware = Object.assign(inner, {
      columnar: true,
      registerModel: (model: string) => {
        registrations.push(model);
      }
    }) as unknown as Backend;

    await expect(
      applyOp(schemaAware, { kind: "dropField", model: "M", field: "x" }, options({ models: {} }))
    ).rejects.toThrow(SchemaUnknownError);

    // ...and succeeds once the layout is supplied.
    await applyOp(schemaAware, { kind: "dropField", model: "M", field: "x" }, options({ models: { M: { fields, indexes } } }));
    expect(registrations).toContain("M");
  });
});

describe("a document store without a registered layout", () => {
  it("runs a generic pass, keeping the registration it has", async () => {
    const registrations: string[] = [];
    const store = Object.assign(new InMemoryBackend(), {
      registerModel: (model: string) => {
        registrations.push(model);
      }
    }) as unknown as Backend;
    await expect(applyOp(store, { kind: "dropField", model: "M", field: "x" }, options({ models: {} }))).resolves.toBeDefined();
    expect(registrations).toEqual([]);
  });
});

describe("idempotence", () => {
  const ops: MigrationOp[] = [
    { kind: "dropField", model: "M", field: "legacy" },
    { kind: "copyField", model: "M", from: "a", to: "b", type: "text", overwrite: false },
    { kind: "renameField", model: "M", from: "c", to: "d", type: "text" },
    { kind: "retypeField", model: "M", field: "n", from: "integer", to: "text" },
    { kind: "addField", model: "M", field: "tier", type: "text", fill: "free" }
  ];

  for (const op of ops) {
    it(`${op.kind} is a no-op on a second run`, async () => {
      const backend = await seeded([{ uuid: "a", legacy: 1, a: "A", c: "C", n: 5 }]);
      await applyOp(backend, op, options());
      const afterFirst = await readAll(backend);

      const second = await applyOp(backend, op, options());
      expect(second.rows).toBe(0);
      expect(await readAll(backend)).toEqual(afterFirst);
    });
  }
});

describe("a transform keeps each record's identity", () => {
  async function seededItems() {
    const backend = new InMemoryBackend();
    backend.save("Item", { uuid: "a", n: 1 }, SYSTEM_CONTEXT);
    backend.save("Item", { uuid: "b", n: 2 }, SYSTEM_CONTEXT);
    await backend.persist(SYSTEM_CONTEXT);
    return backend;
  }
  const items = { Item: { fields: [], indexes: [] } };

  it("refuses to change a uuid, which would insert a duplicate the scan then revisits", async () => {
    const backend = await seededItems();
    const migration: Migration = {
      name: "m",
      transforms: { rekey: (row) => ({ ...row, uuid: `${String(row.uuid)}-new` }) },
      up: (m) => m.transform("Item", "rekey", [])
    };
    await expect(runMigrations(backend, [migration], { models: items })).rejects.toThrow(/changed a record's uuid/);
    expect((await backend.query({ model: "Item", where: { type: "all" }, order: [], paging: { start: 0 } }, SYSTEM_CONTEXT)).map((r) => r.uuid).sort()).toEqual(["a", "b"]);
  });

  it("keeps the uuid a transform leaves out", async () => {
    const backend = await seededItems();
    const migration: Migration = {
      name: "m",
      transforms: { strip: (row) => ({ n: Number(row.n) * 10 }) },
      up: (m) => m.transform("Item", "strip", ["n"])
    };
    await runMigrations(backend, [migration], { models: items });
    const rows = await backend.query({ model: "Item", where: { type: "all" }, order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, SYSTEM_CONTEXT);
    expect(rows).toEqual([{ uuid: "a", n: 10 }, { uuid: "b", n: 20 }]);
  });
});
