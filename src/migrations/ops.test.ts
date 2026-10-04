/**
 * The op IR: classification, phase decomposition, the legacy aliases, and drift hashing. All pure —
 * no store is involved.
 */
import { describe, it, expect } from "vitest";
import { OpRecorder, classify, isWidening, splitPhases, phaseOps, downOps, opsHash, assertNoNarrowingRetype, phaseReorders } from "./ops.js";
import { runMigrations } from "./run.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { UniqueConstraintError } from "../backends/util/unique.js";
import { SYSTEM_CONTEXT, type JsonObject } from "../core/types.js";
import { MigrationBlockedError, MigrationNotSupportedError, SchemaUnknownError, SchemaVersionError } from "./errors.js";
import { eq } from "../expressions/index.js";
import type { Migration, MigrationOp } from "./types.js";

const record = (build: (m: OpRecorder) => void): MigrationOp[] => {
  const recorder = new OpRecorder();
  build(recorder);
  return recorder.ops;
};

describe("classification", () => {
  const cases: Array<[string, MigrationOp, "expand" | "contract"]> = [
    ["createModel", { kind: "createModel", model: "M", fields: [] }, "expand"],
    ["addField", { kind: "addField", model: "M", field: "a", type: "text" }, "expand"],
    ["copyField", { kind: "copyField", model: "M", from: "a", to: "b", type: "text", overwrite: false }, "expand"],
    ["transform (declared expand)", { kind: "transform", model: "M", transform: "t", fields: ["a"], phase: "expand" }, "expand"],
    // Undeclared, a transform may delete or overwrite — nothing short of running it can tell.
    ["transform (default)", { kind: "transform", model: "M", transform: "t", fields: ["a"] }, "contract"],
    ["copyField (overwrite)", { kind: "copyField", model: "M", from: "a", to: "b", type: "text", overwrite: true }, "contract"],
    ["addIndex (plain)", { kind: "addIndex", model: "M", index: { name: "i", fields: [{ path: "a" }] } }, "expand"],
    ["retype (widening)", { kind: "retypeField", model: "M", field: "a", from: "integer", to: "float" }, "expand"],
    ["rawSql (default)", { kind: "rawSql", dialect: "*", statement: "", params: [], phase: "expand" }, "expand"],
    ["dropField", { kind: "dropField", model: "M", field: "a" }, "contract"],
    ["dropModel", { kind: "dropModel", model: "M" }, "contract"],
    ["dropIndex", { kind: "dropIndex", model: "M", index: "i" }, "contract"],
    ["renameField", { kind: "renameField", model: "M", from: "a", to: "b", type: "text" }, "contract"],
    ["retype (narrowing)", { kind: "retypeField", model: "M", field: "a", from: "text", to: "integer" }, "contract"],
    [
      "addIndex (unique)",
      { kind: "addIndex", model: "M", index: { name: "i", fields: [{ path: "a" }], unique: true } },
      "contract"
    ],
    ["rawSql (declared contract)", { kind: "rawSql", dialect: "*", statement: "", params: [], phase: "contract" }, "contract"]
  ];

  for (const [label, op, expected] of cases) {
    it(`${label} is ${expected}`, () => expect(classify(op)).toBe(expected));
  }

  it("applies a retype whose original type is unstated, rather than withholding it", () => {
    // The legacy `alterColumnType` alias can't say what the column was, so there is nothing to judge.
    expect(classify({ kind: "retypeField", model: "M", field: "a", to: "integer" })).toBe("expand");
  });

  it("treats an unrecognised op as destructive", () => {
    // Withholding something harmless is recoverable; running something destructive is not.
    expect(classify({ kind: "somethingNew" } as unknown as MigrationOp)).toBe("contract");
  });
});

describe("the widening lattice", () => {
  it("widens toward more permissive representations", () => {
    expect(isWidening("integer", "float")).toBe(true);
    expect(isWidening("integer", "text")).toBe(true);
    expect(isWidening("date", "scalar")).toBe(true);
    expect(isWidening("text", "json")).toBe(true);
  });

  it("is reflexive but not symmetric", () => {
    expect(isWidening("text", "text")).toBe(true);
    expect(isWidening("float", "integer")).toBe(false);
    expect(isWidening("text", "integer")).toBe(false);
    expect(isWidening("json", "text")).toBe(false);
  });
});

describe("renameField decomposition", () => {
  const ops = record((m) => m.renameField("User", "name", "fullName", "text"));

  it("splits into a non-clobbering expand and a re-copying contract", () => {
    expect(splitPhases(ops, false)).toEqual({
      expand: [
        { kind: "addField", model: "User", field: "fullName", type: "text" },
        { kind: "copyField", model: "User", from: "name", to: "fullName", type: "text", overwrite: false, fromType: "text" }
      ],
      contract: [
        // The step everybody forgets: old writers kept writing `name` for the whole window, so the
        // drop must be preceded by a copy that DOES overwrite.
        { kind: "copyField", model: "User", from: "name", to: "fullName", type: "text", overwrite: true, exact: true, fromType: "text" },
        { kind: "dropField", model: "User", field: "name", closes: { renamedTo: "fullName" } }
      ]
    });
  });

  it("stays whole when no window was requested, so SQL keeps its metadata rename", () => {
    expect(splitPhases(ops, true)).toEqual({
      expand: [{ kind: "renameField", model: "User", from: "name", to: "fullName", type: "text" }],
      contract: []
    });
  });
});

describe("the legacy builder aliases", () => {
  it("record the same portable ops as their modern spellings", () => {
    const legacy = record((m) => {
      m.createTable("User", [{ name: "name", type: "text" }]);
      m.addColumn("User", "age", "integer");
      m.dropColumn("User", "old");
      m.alterColumnType("User", "age", "float");
      m.createIndex("User", "by_name", ["name"], true);
      m.dropTable("Stale");
    });

    expect(legacy).toEqual([
      { kind: "createModel", model: "User", fields: [{ name: "name", type: "text" }] },
      { kind: "addField", model: "User", field: "age", type: "integer" },
      { kind: "dropField", model: "User", field: "old" },
      // No `from`: the legacy alias never knew the original type, so the widening check can't run
      // and it keeps its historical behaviour of simply applying.
      { kind: "retypeField", model: "User", field: "age", to: "float" },
      // Named exactly as given, as the original builder did: raw SQL may name it later.
      { kind: "addIndex", model: "User", index: { name: "by_name", fields: [{ path: "name" }], unique: true }, exactName: true },
      { kind: "dropModel", model: "Stale" }
    ]);
  });

  it("keeps the original builder's uuid column type indexable: text, not the LONGTEXT fallback", () => {
    expect(record((m) => m.addColumn("Order", "userId", "uuid"))).toEqual([{ kind: "addField", model: "Order", field: "userId", type: "text" }]);
  });

  it("keeps MySQL's index column types, which have nowhere to live on IndexSpec", () => {
    const [op] = record((m) => m.createIndex("User", "by_email", ["email"], false, { email: "text" }));
    expect(op).toMatchObject({ kind: "addIndex", columnTypes: { email: "text" } });
  });

  it("falls back to an opaque type for an unrecognised legacy type tag", () => {
    const [op] = record((m) => m.addColumn("User", "blob", "varchar(255)"));
    expect(op).toMatchObject({ kind: "addField", type: "scalar" });
  });
});

describe("the recorder covers every op kind", () => {
  it("records each portable spelling verbatim", () => {
    const ops = record((m) => {
      m.createModel("M", [{ name: "a", type: "text" }], [{ name: "i", fields: [{ path: "a" }] }]);
      m.dropModel("Gone");
      m.addField("M", "a", "text", { fill: "x" });
      m.dropField("M", "b");
      m.copyField("M", "a", "b", "text", { overwrite: true });
      m.retypeField("M", "n", "integer", "float");
      m.addIndex("M", { name: "by_a", fields: [{ path: "a" }] });
      m.dropIndex("M", "by_a");
      m.transform("M", "t", ["a"], eq("a", 1));
      m.transform("M", "t", ["a"], undefined, { phase: "expand" });
      m.sql("UPDATE x SET y = 1", [], { phase: "contract" });
    });

    expect(ops).toEqual([
      { kind: "createModel", model: "M", fields: [{ name: "a", type: "text" }], indexes: [{ name: "i", fields: [{ path: "a" }] }] },
      { kind: "dropModel", model: "Gone" },
      { kind: "addField", model: "M", field: "a", type: "text", fill: "x" },
      { kind: "dropField", model: "M", field: "b" },
      { kind: "copyField", model: "M", from: "a", to: "b", type: "text", overwrite: true },
      { kind: "retypeField", model: "M", field: "n", from: "integer", to: "float" },
      { kind: "addIndex", model: "M", index: { name: "by_a", fields: [{ path: "a" }] } },
      { kind: "dropIndex", model: "M", index: "by_a" },
      { kind: "transform", model: "M", transform: "t", fields: ["a"], where: eq("a", 1).serialize() },
      { kind: "transform", model: "M", transform: "t", fields: ["a"], phase: "expand" },
      { kind: "rawSql", dialect: "*", statement: "UPDATE x SET y = 1", params: [], phase: "contract" }
    ]);
  });

  it("defaults raw SQL to the expand phase and copyField to non-clobbering", () => {
    const [raw] = record((m) => m.sql("SELECT 1"));
    expect(raw).toMatchObject({ phase: "expand", params: [] });

    const [copy] = record((m) => m.copyField("M", "a", "b", "text"));
    expect(copy).toMatchObject({ overwrite: false });
  });

  it("maps renameColumn onto the portable rename with an opaque type", () => {
    expect(record((m) => m.renameColumn("M", "a", "b"))).toEqual([
      { kind: "renameField", model: "M", from: "a", to: "b", type: "scalar" }
    ]);
  });
});

describe("phaseOps / downOps", () => {
  it("reduces a migration's up() through the gate", async () => {
    const phased = await phaseOps(
      { name: "m", schemaVersion: 5, up: (m) => m.dropField("User", "legacy") },
      false
    );
    expect(phased.expand).toEqual([]);
    expect(phased.contract).toEqual([{ kind: "dropField", model: "User", field: "legacy" }]);
  });

  it("returns down() ops in the order authored, not reordered by phase", async () => {
    const ops = await downOps({
      name: "m",
      up: () => undefined,
      // Sequencing matters: the index has to go before the column it covers.
      down: (m) => {
        m.dropIndex("User", "by_nickname");
        m.dropField("User", "nickname");
        m.addField("User", "name", "text");
      }
    });
    expect(ops.map((op) => op.kind)).toEqual(["dropIndex", "dropField", "addField"]);
  });

  it("has no ops for a migration without a down()", async () => {
    expect(await downOps({ name: "m", up: () => undefined })).toEqual([]);
  });
});

describe("narrowing retypes are refused before anything runs", () => {
  it("throws, naming the field and the suggested alternative", () => {
    const ops = record((m) => m.retypeField("User", "age", "text", "integer"));
    expect(() => assertNoNarrowingRetype("0007_age", ops)).toThrow(MigrationBlockedError);
    try {
      assertNoNarrowingRetype("0007_age", ops);
    } catch (error) {
      expect((error as MigrationBlockedError).blockers[0]).toMatchObject({ code: "NARROWING_RETYPE" });
      expect((error as Error).message).toContain("User.age");
    }
  });

  it("permits a widening retype", () => {
    const ops = record((m) => m.retypeField("User", "age", "integer", "float"));
    expect(() => assertNoNarrowingRetype("0007_age", ops)).not.toThrow();
  });
});

describe("errors carry structured fields, not just messages", () => {
  it("MigrationNotSupportedError names the op and the backend", () => {
    const op: MigrationOp = { kind: "rawSql", dialect: "*", statement: "SELECT 1", params: [], phase: "expand" };
    const error = new MigrationNotSupportedError(op, "MongoBackend");
    expect(error.name).toBe("MigrationNotSupportedError");
    expect(error.op).toBe(op);
    expect(error.backend).toBe("MongoBackend");
    expect(error.message).toContain("rawSql"); // an op with no model reads cleanly
    expect(error.message).not.toContain("undefined");
  });

  it("MigrationNotSupportedError names the model when the op has one", () => {
    const error = new MigrationNotSupportedError({ kind: "dropModel", model: "User" }, "SQLiteBackend");
    expect(error.message).toContain('"User"');
  });

  it("SchemaUnknownError names the model and points at the fix", () => {
    const error = new SchemaUnknownError("User");
    expect(error.model).toBe("User");
    expect(error.message).toContain("options.models");
  });

  it("SchemaVersionError carries both versions", () => {
    const error = new SchemaVersionError(7, 5, "declared 7, stored 9");
    expect(error.name).toBe("SchemaVersionError");
    expect([error.schemaVersion, error.minSupported]).toEqual([7, 5]);
  });

  it("MigrationBlockedError renders every blocker", () => {
    const error = new MigrationBlockedError([
      { code: "CHECKSUM_DRIFT", migration: "m1", message: "edited after apply" },
      { code: "VERSION_REGRESSION", message: "older build" }
    ]);
    expect(error.blockers).toHaveLength(2);
    expect(error.message).toContain("CHECKSUM_DRIFT");
    expect(error.message).toContain("VERSION_REGRESSION");
  });
});

describe("opsHash", () => {
  const ops = record((m) => m.addField("User", "age", "integer"));

  it("is stable across key reordering", () => {
    const reordered: MigrationOp[] = [{ type: "integer", field: "age", model: "User", kind: "addField" } as MigrationOp];
    expect(opsHash(reordered)).toBe(opsHash(ops));
  });

  it("changes when an op changes", () => {
    const other = record((m) => m.addField("User", "age", "float"));
    expect(opsHash(other)).not.toBe(opsHash(ops));
  });

  it("distinguishes order", () => {
    const a = record((m) => {
      m.addField("User", "a", "text");
      m.addField("User", "b", "text");
    });
    const b = record((m) => {
      m.addField("User", "b", "text");
      m.addField("User", "a", "text");
    });
    expect(opsHash(a)).not.toBe(opsHash(b));
  });
});

describe("a versioned migration whose split would reorder it", () => {
  const codes = (ops: MigrationOp[]) => phaseReorders("m", ops).map((blocker) => blocker.code);
  const add = (field: string): MigrationOp => ({ kind: "addField", model: "U", field, type: "text" });
  const drop = (field: string): MigrationOp => ({ kind: "dropField", model: "U", field });
  const rename = (from: string, to: string): MigrationOp => ({ kind: "renameField", model: "U", from, to, type: "text" });

  it("refuses an expand step after a contract step on the same field", () => {
    expect(codes([drop("x"), add("x")])).toEqual(["PHASE_REORDER"]); // the late drop deletes the new field
    expect(codes([rename("a", "b"), add("a")])).toEqual(["PHASE_REORDER"]); // a is still the legacy field
    expect(codes([rename("a", "b"), { kind: "retypeField", model: "U", field: "b", from: "text", to: "json" }])).toEqual(["PHASE_REORDER"]);
    expect(codes([{ kind: "copyField", model: "U", from: "a", to: "b", type: "text", overwrite: true }, { kind: "copyField", model: "U", from: "b", to: "c", type: "text", overwrite: false }])).toEqual([
      "PHASE_REORDER"
    ]);
    // A transform sees whole records: anything withheld on the model before it would still be there.
    expect(codes([drop("x"), { kind: "transform", model: "U", transform: "t", fields: ["y"], phase: "expand" }])).toEqual(["PHASE_REORDER"]);
    expect(codes([{ kind: "addIndex", model: "U", index: { name: "i", fields: [{ path: "x" }], unique: true } }, add("x")])).toEqual(["PHASE_REORDER"]);
    // A rename's own expand half runs early too: into a name dropped or renamed away before it.
    expect(codes([drop("x"), rename("y", "x")])).toEqual(["PHASE_REORDER"]);
    expect(codes([rename("x", "z"), rename("y", "x")])).toEqual(["PHASE_REORDER"]);
  });

  it("allows steps the split leaves in order", () => {
    expect(codes([add("x"), drop("x")])).toEqual([]); // expand then contract: the split keeps that order
    expect(codes([drop("x"), add("y")])).toEqual([]); // different fields
    expect(codes([drop("x"), { kind: "addField", model: "V", field: "x", type: "text" }])).toEqual([]); // different models
    expect(codes([rename("a", "b"), add("c")])).toEqual([]);
    expect(codes([drop("x"), drop("y")])).toEqual([]); // contract after contract keeps its order
  });

  it("is checked only for a migration the split applies to", async () => {
    const backend = new InMemoryBackend();
    const reorder = (schemaVersion?: number): Migration => ({
      name: "m",
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      up: (m) => {
        m.dropField("U", "x");
        m.addField("U", "x", "text");
      }
    });
    const models = { U: { fields: [], indexes: [] } };
    await expect(runMigrations(backend, [reorder(2)], { models, schemaVersion: 2 })).rejects.toMatchObject({ blockers: [{ code: "PHASE_REORDER" }] });
    await expect(runMigrations(new InMemoryBackend(), [reorder()], { models })).resolves.toMatchObject({ applied: ["m"] });
  });
});

describe("a unique index over data that already violates it", () => {
  const models = { U: { fields: [], indexes: [] } };
  const unique = (field: string): Migration => ({ name: `u_${field}`, up: (m) => m.addIndex("U", { name: field, fields: [{ path: field }], unique: true }) });
  async function seeded(rows: JsonObject[]) {
    const backend = new InMemoryBackend();
    for (const row of rows) backend.save("U", row, SYSTEM_CONTEXT);
    await backend.persist(SYSTEM_CONTEXT);
    return backend;
  }

  it("is refused with the same error on every store, before any store builds it", async () => {
    const backend = await seeded([{ uuid: "a", email: "x" }, { uuid: "b", email: "x" }]);
    await expect(runMigrations(backend, [unique("email")], { models, batchSize: 1 })).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it("allows any number of records without a value, as SQL does", async () => {
    const backend = await seeded([{ uuid: "a" }, { uuid: "b", email: null }, { uuid: "c", email: "x" }]);
    await expect(runMigrations(backend, [unique("email")], { models })).resolves.toMatchObject({ applied: ["u_email"] });
  });
});
