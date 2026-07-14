import { describe, it, expect, expectTypeOf } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { text, integer, relationToOne, relationToMany } from "../properties/factories.js";
import { mul, field } from "../expressions/index.js";

interface Customer {
  uuid: string;
  name: string;
  country: string;
}
interface LineItem {
  uuid: string;
  sku: string;
  price: number;
  qty: number;
}
interface Order {
  uuid: string;
  ref: string;
  customer: Customer | null;
  items: LineItem[];
}

function ordersRepo() {
  const orm = new RepositoryManager();
  const customers = orm.define({ name: "Customer", properties: { name: text(), country: text() } });
  const items = orm.define({ name: "LineItem", properties: { sku: text(), price: integer(), qty: integer() } });
  const orders = orm.define({
    name: "Order",
    properties: {
      ref: text(),
      customer: relationToOne<Customer>({ model: "Customer" }),
      items: relationToMany<LineItem>({ model: "LineItem", storage: "embed" })
    }
  });
  return { customers, items, orders };
}

describe("nested select (selection-object projection)", () => {
  it("projects scalars and nested relations (to-one + embedded array) — typed", async () => {
    const { customers, items, orders } = ordersRepo();

    const ada = customers.createInstance({ name: "Ada", country: "GB" });
    customers.save(ada);
    await customers.persist();

    const order = orders.createInstance({
      ref: "A1",
      customer: ada,
      items: [
        items.createInstance({ sku: "X", price: 10, qty: 2 }),
        items.createInstance({ sku: "Y", price: 5, qty: 4 })
      ]
    });
    orders.save(order);
    await orders.persist();

    const rows = await orders.all().select({
      ref: true,
      customer: { name: true, country: true },
      items: { sku: true }
    });

    const row = rows[0]!;
    expect(row.ref).toBe("A1");
    expect(row.customer).toEqual({ name: "Ada", country: "GB" });
    expect(row.items).toEqual([{ sku: "X" }, { sku: "Y" }]);

    expectTypeOf(row.ref).toEqualTypeOf<string>();
    expectTypeOf(row.customer).toEqualTypeOf<{ name: string; country: string } | null>();
    expectTypeOf(row.items).toEqualTypeOf<Array<{ sku: string }>>();
  });

  it("computes scalar fields per row", async () => {
    const orm = new RepositoryManager();
    const lines = orm.define({ name: "Line", properties: { price: integer(), qty: integer() } });
    lines.save(lines.createInstance({ price: 10, qty: 3 }));
    lines.save(lines.createInstance({ price: 4, qty: 5 }));
    await lines.persist();

    const rows = await lines.all().sort("price").select({
      price: true,
      total: mul(field("price"), field("qty"))
    });
    expect(rows.map((r) => r.total)).toEqual([20, 30]); // 4*5, 10*3
    expect(rows[0]).toEqual({ price: 4, total: 20 });
  });

  it("returns null for an unset to-one relation", async () => {
    const { orders } = ordersRepo();
    const order = orders.createInstance({ ref: "B1" });
    orders.save(order);
    await orders.persist();
    const [row] = await orders.all().select({ ref: true, customer: { name: true } });
    expect(row).toEqual({ ref: "B1", customer: null });
  });
});
