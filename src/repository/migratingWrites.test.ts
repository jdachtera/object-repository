/**
 * The migration runner queues its pages on the manager's own backend. An application write made through
 * the same manager meanwhile would share that queue: flushed with a page, or discarded with one that
 * failed — silently. So while `migrate()` or `rollback()` runs, the manager's repositories refuse writes.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { RepositoryManager } from "./RepositoryManager.js";
import { integer, text } from "../properties/factories.js";
import type { JsonObject } from "../core/types.js";
import type { Migration } from "../migrations/types.js";

function app() {
  const orm = new RepositoryManager({ backend: new InMemoryBackend() });
  const items = orm.define({ name: "Item", properties: { price: integer(), note: text() } });
  return { orm, items };
}

describe("writes while the manager is migrating", () => {
  it("are refused, rather than lost with a page that fails", async () => {
    const { orm, items } = app();
    await items.save(items.createInstance({ price: 1 })).persist();
    let attempted: unknown = null;
    const failing: Migration = {
      name: "0001_fails",
      transforms: {
        boom: (row: JsonObject) => {
          // The application, mid-migration, writes through the same manager.
          try {
            items.save(items.createInstance({ price: 2 }));
          } catch (error) {
            attempted = error;
          }
          throw new Error("transform failed");
        }
      },
      up: (m) => m.transform("Item", "boom", ["price"])
    };
    await expect(orm.migrate([failing])).rejects.toThrow("transform failed");
    expect(String(attempted)).toMatch(/save\(\) on "Item" while migrate\(\) is running/);
  });

  it("are refused by persist() and remove() too, and allowed again once it finishes", async () => {
    const { orm, items } = app();
    const [item] = [items.createInstance({ price: 1 })];
    await items.save(item!).persist();
    const attempts: Array<Promise<string>> = [];
    const outcome = (what: string, write: () => unknown) =>
      attempts.push(
        (async () => {
          try {
            await write();
            return `${what}: allowed`;
          } catch {
            return `${what}: refused`;
          }
        })()
      );
    const probe: Migration = {
      name: "0001_probe",
      transforms: {
        probe: (row: JsonObject) => {
          outcome("persist", () => items.persist());
          outcome("remove", () => items.remove(item!, { hard: true }));
          outcome("transaction", () => orm.transaction(async () => {}));
          return row;
        }
      },
      up: (m) => m.transform("Item", "probe", ["price"], undefined, { phase: "expand" })
    };
    await orm.migrate([probe]);
    expect(await Promise.all(attempts)).toEqual(["persist: refused", "remove: refused", "transaction: refused"]);
    await items.save(items.createInstance({ price: 3 })).persist();
    expect((await items.all().list()).length).toBe(2);
  });

  it("persists writes queued before it starts, rather than committing them with a page or dropping them", async () => {
    const { orm, items } = app();
    items.save(items.createInstance({ price: 7 })); // queued, never persisted by the application
    const failing: Migration = {
      name: "0001_fails",
      transforms: {
        boom: () => {
          throw new Error("transform failed");
        }
      },
      up: (m) => m.transform("Item", "boom", ["price"])
    };
    await expect(orm.migrate([failing])).rejects.toThrow("transform failed");
    expect((await items.all().list()).map((item) => item.price)).toEqual([7]);
  });
});
