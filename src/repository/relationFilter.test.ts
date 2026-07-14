import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { text, relationToOne, relationToMany } from "../properties/factories.js";
import { eq } from "../expressions/builders.js";
import type { Backend } from "../core/Backend.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

interface Customer {
  uuid: string;
  name: string;
  country: string;
}
interface Order {
  uuid: string;
  ref: string;
  customer: Customer | null;
}

function runSuite(name: string, makeBackend: () => Backend) {
  describe(`cross-relation filtering on ${name}`, () => {
    it("filters parents by a referenced to-one relation's field", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      const customers = orm.define({ name: "Customer", properties: { name: text(), country: text() } });
      const orders = orm.define({
        name: "Order",
        properties: { ref: text(), customer: relationToOne<Customer>({ model: "Customer" }) }
      });

      const ada = customers.createInstance({ name: "Ada", country: "GB" });
      const bo = customers.createInstance({ name: "Bo", country: "DE" });
      customers.save(ada).save(bo);
      await customers.persist();

      orders.save(orders.createInstance({ ref: "o1", customer: ada }));
      orders.save(orders.createInstance({ ref: "o2", customer: bo }));
      orders.save(orders.createInstance({ ref: "o3", customer: bo }));
      await orders.persist();

      // "orders whose customer is in DE" — resolved by sub-querying Customer, then a local uuid filter.
      const german = (await orders.all().filter(eq("customer.country", "DE")).list()) as unknown as Order[];
      expect(german.map((o) => o.ref).sort()).toEqual(["o2", "o3"]);

      // count goes through the same rewrite
      expect(await orders.all().filter(eq("customer.country", "GB")).count()).toBe(1);
    });

    it("filters parents by a referenced to-many relation's field", async () => {
      const orm = new RepositoryManager({ backend: makeBackend() });
      interface Tag {
        uuid: string;
        label: string;
      }
      const tags = orm.define({ name: "Tag", properties: { label: text() } });
      const posts = orm.define({
        name: "Post",
        properties: { title: text(), tags: relationToMany<Tag>({ model: "Tag" }) }
      });

      const ts = tags.createInstance({ label: "ts" });
      const db = tags.createInstance({ label: "db" });
      tags.save(ts).save(db);
      await tags.persist();

      posts.save(posts.createInstance({ title: "p1", tags: [ts] }));
      posts.save(posts.createInstance({ title: "p2", tags: [ts, db] }));
      posts.save(posts.createInstance({ title: "p3", tags: [db] }));
      await posts.persist();

      const tagged = await posts.all().filter(eq("tags.label", "ts")).list();
      expect(tagged.map((p) => p.title).sort()).toEqual(["p1", "p2"]);
    });
  });
}

runSuite("InMemoryBackend", () => new InMemoryBackend());
runSuite("SQLiteBackend", () => new SQLiteBackend(new DatabaseSync(":memory:")));
