/**
 * The op IR: classification, phase decomposition, the legacy aliases, and drift hashing. All pure —
 * no store is involved.
 */
import { describe, it, expect } from "vitest";
import { OpRecorder, classify, isWidening, splitPhases, phaseOps, downOps, opsHash, assertNoNarrowingRetype } from "./ops.js";
import { MigrationBlockedError, MigrationNotSupportedError, SchemaUnknownError, SchemaVersionError } from "./errors.js";
import { eq } from "../expressions/index.js";
import type { MigrationOp } from "./types.js";

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
    ["transform", { kind: "transform", model: "M", transform: "t", fields: ["a"] }, "expand"],
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
        { kind: "copyField", model: "User", from: "name", to: "fullName", type: "text", overwrite: false }
      ],
      contract: [
        // The step everybody forgets: old writers kept writing `name` for the whole window, so the
        // drop must be preceded by a copy that DOES overwrite.
        { kind: "copyField", model: "User", from: "name", to: "fullName", type: "text", overwrite: true },
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
      { kind: "addIndex", model: "User", index: { name: "by_name", fields: [{ path: "name" }], unique: true } },
      { kind: "dropModel", model: "Stale" }
    ]);
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
