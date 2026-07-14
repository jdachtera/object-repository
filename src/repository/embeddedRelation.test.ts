import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { text, integer, relationToMany, relationToOne } from "../properties/factories.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

interface LineItem {
  uuid: string;
  sku: string;
  price: number;
}
interface Address {
  uuid: string;
  city: string;
}
interface Order {
  uuid: string;
  ref: string;
  shipTo: Address | null;
  items: LineItem[];
}

function defineOrders(orm: RepositoryManager) {
  const lineItems = orm.define({ name: "LineItem", properties: { sku: text(), price: integer() } });
  const addresses = orm.define({ name: "Address", properties: { city: text() } });
  const orders = orm.define({
    name: "Order",
    properties: {
      ref: text(),
      shipTo: relationToOne<Address>({ model: "Address", storage: "embed" }),
      items: relationToMany<LineItem>({ model: "LineItem", storage: "embed" })
    }
  });
  return { lineItems, addresses, orders };
}

function runEmbedSuite(name: string, makeBackend: () => Backend) {
  describe(`embedded relations on ${name}`, () => {
    it("stores owned children inline and rebuilds them on a cold read", async () => {
      const backend = makeBackend();

      const writer = new RepositoryManager({ backend });
      const w = defineOrders(writer);
      const order = w.orders.createInstance({
        ref: "A1",
        shipTo: w.addresses.createInstance({ city: "Berlin" }),
        items: [
          w.lineItems.createInstance({ sku: "X", price: 10 }),
          w.lineItems.createInstance({ sku: "Y", price: 20 })
        ]
      });
      w.orders.save(order);
      await w.orders.persist();

      // Owned children are NOT independently stored — they live inside the order document.
      expect(await w.lineItems.all().list()).toHaveLength(0);
      expect(await w.addresses.all().list()).toHaveLength(0);

      // Cold read through a fresh manager over the same backend.
      const reader = new RepositoryManager({ backend });
      const r = defineOrders(reader);
      const [loaded] = (await r.orders.all().list()) as unknown as Order[];

      expect(loaded!.ref).toBe("A1");
      expect(loaded!.shipTo?.city).toBe("Berlin");
      expect(loaded!.items.map((i) => i.sku)).toEqual(["X", "Y"]);
      expect(loaded!.items[1]!.price).toBe(20);
    });

    it("removing the parent removes the embedded children with it", async () => {
      const backend = makeBackend();
      const orm = new RepositoryManager({ backend });
      const { orders, lineItems } = defineOrders(orm);

      const order = orders.createInstance({ ref: "A1", items: [lineItems.createInstance({ sku: "X", price: 1 })] });
      orders.save(order);
      await orders.persist();
      orders.remove(order);
      await orders.persist();

      expect(await orders.all().list()).toHaveLength(0);
      expect(await lineItems.all().list()).toHaveLength(0);
    });
  });
}

runEmbedSuite("InMemoryBackend", () => new InMemoryBackend());
runEmbedSuite("SQLiteBackend", () => new SQLiteBackend(new DatabaseSync(":memory:")));
