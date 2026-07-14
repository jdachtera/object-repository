import { describe, it, expect, vi } from "vitest";
import { HooksBackend, type Hooks } from "./decorators/HooksBackend.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;

describe("HooksBackend", () => {
  it("beforeSave derives a field, afterSave fires once durable", async () => {
    const audit: string[] = [];
    const hooks: Hooks = {
      beforeSave(model, record) {
        if (model === "Order") record.total = Number(record.price) * Number(record.qty);
      },
      afterSave(model, record) {
        audit.push(`${model}:${record.uuid}:${record.total}`);
      }
    };
    const orm = new RepositoryManager({ backend: new HooksBackend(new InMemoryBackend(), hooks) });
    const orders = orm.define({ name: "Order", properties: { price: integer(), qty: integer(), total: integer() } });

    const order = orders.createInstance({ price: 10, qty: 3, total: 0 });
    orders.save(order);
    expect(audit).toHaveLength(0); // not yet persisted
    await orders.persist();

    const [stored] = await orders.all().list();
    expect(stored!.total).toBe(30); // derived by the hook
    expect(audit).toEqual([`Order:${order.uuid}:30`]);
  });

  it("beforeSave can reject a write by throwing (invariant)", async () => {
    const hooks: Hooks = {
      beforeSave(_model, record) {
        if (Number(record.qty) <= 0) throw new Error("qty must be positive");
      }
    };
    const orm = new RepositoryManager({ backend: new HooksBackend(new InMemoryBackend(), hooks) });
    const orders = orm.define({ name: "Order", properties: { qty: integer() } });

    expect(() => orders.save(orders.createInstance({ qty: 0 }))).toThrow("qty must be positive");
    await orders.persist();
    expect(await orders.all().count()).toBe(0); // nothing was queued
  });

  it("fires beforeRemove / afterRemove around deletes and leaves reads untouched", async () => {
    const beforeRemove = vi.fn();
    const afterRemove = vi.fn();
    const orm = new RepositoryManager({
      backend: new HooksBackend(new InMemoryBackend(), { beforeRemove, afterRemove })
    });
    const items = orm.define({ name: "Item", properties: { name: text() } });

    const item = items.createInstance({ name: "x" });
    items.save(item);
    await items.persist();

    items.remove(item);
    expect(beforeRemove).toHaveBeenCalledWith("Item", expect.objectContaining({ uuid: item.uuid }), ctx);
    expect(afterRemove).not.toHaveBeenCalled(); // not until persist
    await items.persist();
    expect(afterRemove).toHaveBeenCalledWith("Item", expect.objectContaining({ uuid: item.uuid }), ctx);
    expect(await items.all().count()).toBe(0);
  });
});
