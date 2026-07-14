import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { integer } from "../properties/factories.js";

describe("reference reducer + sort coverage", () => {
  it("min/max reductions and a stable sort with duplicate keys", async () => {
    const orm = new RepositoryManager();
    const m = orm.define({ name: "M", properties: { x: integer() } });
    for (const x of [3, 1, 2, 2]) m.save(m.createInstance({ x }));
    await m.persist();

    // min/max go through reduceWithExpr's Math.min / Math.max branches
    expect(await m.all().aggregate((a) => ({ lo: a.min("x"), hi: a.max("x") }))).toEqual({ lo: 1, hi: 3 });

    // sorting past a pair of equal keys (2, 2) exercises the comparator's "equal → 0" path
    expect((await m.all().sort("x").list()).map((i) => i.x)).toEqual([1, 2, 2, 3]);
  });
});
