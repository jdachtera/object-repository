import { describe, it, expect, vi } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { text, integer, relationToOne } from "../properties/factories.js";
import { mul, field } from "../expressions/index.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

describe("projection push-down (only selected fields fetched)", () => {
  it("passes the needed fields to the backend query plan", async () => {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const products = orm.define({
      name: "Product",
      properties: { name: text(), price: integer(), qty: integer(), secret: text() }
    });
    products.save(products.createInstance({ name: "Widget", price: 10, qty: 3, secret: "hush" }));
    await products.persist();

    const querySpy = vi.spyOn(backend, "query");
    const rows = await products.all().select({ name: true, total: mul(field("price"), field("qty")) });

    // The plan projects exactly the referenced fields (+ uuid), not `secret`.
    const project = querySpy.mock.calls[0]![0].project!;
    expect(new Set(project)).toEqual(new Set(["name", "price", "qty"]));

    // And the backend returned only those fields (in-memory honours the projection).
    const returned = await backend.query(
      { model: "Product", where: { type: "all" }, order: [], paging: { start: 0 }, project: ["name", "price", "qty"] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undefined as any
    );
    expect(Object.keys(returned[0]!).sort()).toEqual(["name", "price", "qty", "uuid"]);

    // The computed projection result is still correct.
    expect(rows[0]).toEqual({ name: "Widget", total: 30 });
  });

  it("works the same on SQLite (json_object projection)", async () => {
    const orm = new RepositoryManager({ backend: new SQLiteBackend(new DatabaseSync(":memory:")) });
    const products = orm.define({
      name: "Product",
      properties: { name: text(), price: integer(), qty: integer(), secret: text() }
    });
    products.save(products.createInstance({ name: "Widget", price: 10, qty: 3, secret: "hush" }));
    await products.persist();

    const rows = await products.all().select({ name: true, total: mul(field("price"), field("qty")) });
    expect(rows[0]).toEqual({ name: "Widget", total: 30 });
  });
});
