/**
 * Value expressions (arith / concat) over a null or missing field must produce the SAME result on the
 * compiling SQL backends as on the in-memory reference. The reference coerces a null operand to 0
 * (arith) or "" (concat); SQL's default NULL-propagation would otherwise diverge (`null + 10` → NULL).
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { mul, add, div, mod, concat, field } from "../expressions/values.js";
import { integer, text } from "../properties/factories.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const run = async (backend: Backend) => {
  const orm = new RepositoryManager({ backend });
  const m = orm.define({
    name: "R",
    properties: { a: integer(), b: integer(), name: text(), total: integer(), label: text(), quot: integer(), rem: integer() }
  });
  // `b` is absent (null/missing → 0); `name` is present.
  const inst = m.createInstance({ a: 5, name: "x" });
  m.save(inst);
  await m.persist();
  await m.patch(inst.uuid, {
    total: add(mul(field("a"), field("b")), 10), // 5*0 + 10
    label: concat(field("name"), field("b")), // "x" + ""
    quot: div(field("a"), field("b")), // 5 / 0 → 0 (guarded, not NULL/abort)
    rem: mod(field("a"), field("b")) // 5 % 0 → 0
  });
  const back = (await m.get(inst.uuid))!;
  return { total: back.total, label: back.label, quot: back.quot, rem: back.rem };
};

describe("value expressions coerce null operands identically on SQLite and the reference", () => {
  it("arith→0 / concat→\"\" for null operands, and a zero divisor guards to 0 — matching in-memory", async () => {
    const mem = await run(new InMemoryBackend());
    const sql = await run(new SQLiteBackend(new DatabaseSync(":memory:")));
    expect(sql).toEqual(mem);
    expect(mem).toEqual({ total: 10, label: "x", quot: 0, rem: 0 });
  });
});
