import { describe, it, expect, vi } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { text, relationToOne } from "../properties/factories.js";

interface Customer {
  uuid: string;
  name: string;
}
interface Order {
  uuid: string;
  ref: string;
  customer: Customer | null;
}

describe("projection-driven loading", () => {
  function setup() {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const customers = orm.define({ name: "Customer", properties: { name: text() } });
    const orders = orm.define({
      name: "Order",
      properties: { ref: text(), customer: relationToOne<Customer>({ model: "Customer" }) }
    });
    return { backend, customers, orders };
  }

  it("does not load a relation that is not selected", async () => {
    const { backend, customers, orders } = setup();
    const ada = customers.createInstance({ name: "Ada" });
    customers.save(ada);
    orders.save(orders.createInstance({ ref: "o1", customer: ada }));
    await orders.persist();

    const querySpy = vi.spyOn(backend, "query");

    querySpy.mockClear();
    await orders.all().select({ ref: true });
    expect(querySpy.mock.calls.some((call) => call[0].model === "Customer")).toBe(false);

    querySpy.mockClear();
    const withCustomer = await orders.all().select({ ref: true, customer: { name: true } });
    expect(querySpy.mock.calls.some((call) => call[0].model === "Customer")).toBe(true);
    expect(withCustomer[0]).toEqual({ ref: "o1", customer: { name: "Ada" } });
  });

  it("does not pollute the identity map with partially-loaded instances", async () => {
    const { customers, orders } = setup();
    const ada = customers.createInstance({ name: "Ada" });
    customers.save(ada);
    orders.save(orders.createInstance({ ref: "o1", customer: ada }));
    await orders.persist();

    // A projection that omits `customer` must not leave a customerless Order in the cache.
    await orders.all().select({ ref: true });

    const [full] = await orders.all().list();
    expect(full!.customer?.name).toBe("Ada"); // a later full query still loads the relation
  });
});
