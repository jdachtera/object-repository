/**
 * D1Backend runs the compiling SQLite backend over an *asynchronous*, batch-only driver. The fake D1
 * here is backed by `node:sqlite` but exposes D1's shape (`prepare().bind().all()/run()`, `batch()`,
 * async everywhere), so this proves the async seam round-trips end to end and that `persist` commits
 * through `batch()` — without a real Workers runtime.
 */
import { describe, it, expect, vi } from "vitest";
import { D1Backend, type D1Database, type D1PreparedStatement } from "./sqlite/D1Backend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { eq, gt } from "../expressions/index.js";
import { inc } from "../repository/patch.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** A minimal async D1 over node:sqlite — every call returns a Promise; `batch` is one transaction. */
class FakeD1 implements D1Database {
  constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}
  prepare(sql: string): D1PreparedStatement {
    return new FakeStmt(this.db, sql);
  }
  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return { count: 0 };
  }
}

class FakeStmt implements D1PreparedStatement {
  private params: unknown[] = [];
  constructor(private readonly db: InstanceType<typeof DatabaseSync>, private readonly sql: string) {}
  bind(...params: unknown[]): D1PreparedStatement {
    this.params = params;
    return this;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] };
  }
  async run(): Promise<unknown> {
    return this.db.prepare(this.sql).run(...(this.params as never[]));
  }
}

describe("D1Backend (async, batch-based SQLite over a fake D1)", () => {
  it("round-trips the full stack through the async driver", async () => {
    const d1 = new FakeD1(new DatabaseSync(":memory:"));
    const orm = new RepositoryManager({ backend: new D1Backend(d1) });
    const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });

    for (const [name, age] of [["Ann", 30], ["Bo", 40], ["Cy", 20]] as const) {
      users.save(users.createInstance({ name, age }));
    }
    await users.persist();

    expect(await users.all().count()).toBe(3);
    expect((await users.all().filter(gt("age", 25)).sort("age").list()).map((u) => u.name)).toEqual(["Ann", "Bo"]);
    const byAge = await users.all().groupBy("age", (a) => ({ n: a.count() }));
    expect(byAge.find((g) => g.key === 30)!.n).toBe(1);

    // patch (async UPDATE) + re-read
    const ann = (await users.all().filter(eq("name", "Ann")).list())[0]!;
    await users.patch(ann.uuid, { age: inc(1) });
    expect((await users.get(ann.uuid))!.age).toBe(31);

    // remove + persist
    users.remove(ann);
    await users.persist();
    expect(await users.all().count()).toBe(2);
  });

  it("commits writes through D1 batch() (its only atomicity primitive)", async () => {
    const d1 = new FakeD1(new DatabaseSync(":memory:"));
    const batchSpy = vi.spyOn(d1, "batch");
    const orm = new RepositoryManager({ backend: new D1Backend(d1) });
    const items = orm.define({ name: "Item", properties: { label: text() } });

    items.save(items.createInstance({ label: "a" }));
    items.save(items.createInstance({ label: "b" }));
    await items.persist();

    expect(batchSpy).toHaveBeenCalledTimes(1); // both writes in one atomic batch, not BEGIN/COMMIT
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(2);
    expect(await items.all().count()).toBe(2);
  });

  it("re-saving a uuid updates in place via ON CONFLICT in the batch", async () => {
    const d1 = new FakeD1(new DatabaseSync(":memory:"));
    const orm = new RepositoryManager({ backend: new D1Backend(d1) });
    const items = orm.define({ name: "Doc", properties: { title: text() } });
    const doc = items.createInstance({ title: "v1" });
    items.save(doc);
    await items.persist();
    doc.title = "v2";
    items.save(doc);
    await items.persist();
    expect(await items.all().count()).toBe(1);
    expect((await items.get(doc.uuid))!.title).toBe("v2");
  });
});
