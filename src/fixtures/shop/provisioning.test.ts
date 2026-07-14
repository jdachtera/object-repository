/**
 * The shop catalog (a generic e-commerce schema) defines and provisions across backends. This pins the
 * model definitions themselves; `surface.test.ts` replays representative query shapes to find gaps.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "../../repository/RepositoryManager.js";
import { InMemoryBackend } from "../../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../../backends/sqlite/SQLiteBackend.js";
import { defineShopModels } from "./models.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

describe("shop catalog defines + provisions", () => {
  it("all 6 collections define on the in-memory reference", () => {
    const m = defineShopModels(new RepositoryManager({ backend: new InMemoryBackend() }));
    expect(Object.keys(m).length).toBe(6);
  });

  it("all 6 provision on SQLite — real tables + indexes, including the hyphenated compound index", async () => {
    // Regression: a developer-supplied index name with non-identifier chars (wishlistItems'
    // "productId-customerId") previously threw `Invalid SQL identifier` during provisioning.
    const orm = new RepositoryManager({ backend: new SQLiteBackend(new DatabaseSync(":memory:")) });
    const m = defineShopModels(orm);

    const p = m.products.createInstance({ sku: "SKU-1", name: { en: "Über Widget", de: "Über-Widget" }, status: "active", sourceLocale: "de", isPublished: true });
    m.products.save(p);
    await m.products.persist();
    expect(await m.products.all().count()).toBe(1);

    const w = m.wishlistItems.createInstance({ customerId: "c1", productId: "p1" });
    m.wishlistItems.save(w);
    await m.wishlistItems.persist();
    expect(await m.wishlistItems.all().count()).toBe(1);
  });
});
