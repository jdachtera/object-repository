/**
 * A generic e-commerce catalog (products, customers, orders, usage events, wishlists, sessions) modeled
 * in this ORM's definitions — a realism benchmark. It deliberately packs the awkward shapes a real
 * MongoDB app throws at an ORM into six collections: per-locale translated subdocuments, a
 * discriminated-union payment method, arrays-of-objects, scalar-array membership, and TTL / partial /
 * unique / compound / text indexes. `surface.test.ts` replays representative query shapes against these
 * models through the Mongo compat facade and native builders; whatever can't be expressed IS the gap
 * list (docs/QUERY_SURFACE.md).
 *
 * Modeling decisions (each a "surface" data point, not silently glossed):
 * - Document `_id: ObjectId` → the ORM's `uuid` (string). A Mongo deployment would use `objectIdIdentity`.
 * - `createdAt`/`updatedAt` are explicit `date()` fields here; `timestamps: true` is the idiomatic
 *   equivalent where a model has both.
 * - `Translated<T>` = `{en?, de?, fr?}` storefront copy → `json<Translated>` columns. Faithful storage,
 *   but a declared json column is opaque to SQL push-down → per-locale filters scan (see gap report).
 * - Discriminated unions: `customers.paymentMethod` (on `provider`) is modeled natively — an `embedded()`
 *   fed a zod `discriminatedUnion`, so the model type is *inferred* from the schema and validated on
 *   every write, and deep dotted filters into it push down.
 * - Arrays of objects (`orders.items`) → `json`, since the native `array()` stores scalar elements only.
 * - Enum fields transcribe to `text({ schema: z.enum(...) })`, so the model type is the literal union.
 */
import { z } from "zod";
import type { RepositoryManager } from "../../repository/RepositoryManager.ts";
import { text, integer, float, boolean, date, json, array, embedded } from "../../properties/factories.ts";
import { eq, exists } from "../../expressions/builders.ts";

export type Translated = { en?: string; de?: string; fr?: string };

const LOCALES = ["en", "de", "fr"] as const;
const CURRENCIES = ["USD", "EUR", "GBP"] as const;
const PRICING_VARIANTS = ["control", "discount", "bundle"] as const;

/** Define every shop collection on `object-repository`. Returns the repositories keyed like the app's schema map. */
export function defineShopModels(orm: RepositoryManager) {
  const products = orm.define({
    name: "products",
    properties: {
      sku: text({ unique: true }),
      name: json<Translated>(),
      description: json<Translated>(),
      status: text({ schema: z.enum(["draft", "active", "archived"]) }),
      price: float(),
      currency: text({ schema: z.enum(CURRENCIES) }),
      stock: integer({ default: 0 }),
      category: text({ index: true }),
      tags: array<string>(),
      sourceLocale: text({ schema: z.enum(LOCALES) }),
      isPublished: boolean({ default: false }),
      isFeatured: boolean({ default: false }),
      createdAt: date(),
      updatedAt: date()
    },
    indexes: [
      { name: "sku", fields: ["sku"], unique: true },
      // per-locale B-tree indexes: <field>.<locale> into the translated subdocuments
      ...["name", "description"].flatMap((f) => LOCALES.map((l) => ({ name: `${f}_${l}`, fields: [`${f}.${l}`] }))),
      { name: "productTextSearch", fields: ["name", "description"], text: true },
      { name: "category_status", fields: ["category", "status"] }
    ]
  });

  const customers = orm.define({
    name: "customers",
    properties: {
      email: text({ schema: z.string().email(), index: true }),
      givenName: text(),
      familyName: text(),
      tags: array<string>(),
      externalId: text(),
      isEmailVerified: boolean({ default: false }),
      createdAt: date(),
      updatedAt: date(),
      // discriminated union on `provider` (card/paypal/giftcard) with per-provider detail shapes.
      // embedded() (not json()) so dotted filters — paymentMethod.customerId,
      // paymentMethod.details.status/… — traverse and push down. The zod schema is the single source of
      // truth: the model type is *inferred* from it and it validates every write.
      paymentMethod: embedded(
        z.discriminatedUnion("provider", [
          z.object({
            provider: z.literal("card"),
            customerId: z.string(),
            details: z.object({ status: z.string(), brand: z.string().optional(), last4: z.string().optional() })
          }),
          z.object({
            provider: z.literal("paypal"),
            customerId: z.string().optional(),
            details: z.object({ status: z.string(), payerId: z.string().optional() })
          }),
          z.object({
            provider: z.literal("giftcard"),
            customerId: z.string().optional(),
            details: z.object({ status: z.string(), balance: z.number().optional() })
          })
        ])
      ),
      settings: json<Record<string, unknown>>()
    },
    indexes: [
      { name: "email", fields: ["email"], unique: true },
      { name: "externalId", fields: ["externalId"], unique: true, where: exists("externalId") },
      // dotted path into the paymentMethod subdocument — partial unique
      { name: "paymentMethod_customerId", fields: ["paymentMethod.customerId"], unique: true, where: exists("paymentMethod.customerId") }
    ]
  });

  const orders = orm.define({
    name: "orders",
    properties: {
      customerId: text({ index: true }),
      requestId: text({ unique: true }), // idempotency key for upsert-by-requestId ($setOnInsert)
      status: text({ schema: z.enum(["pending", "paid", "shipped", "delivered", "cancelled"]) }),
      total: float(),
      currency: text({ schema: z.enum(CURRENCIES) }),
      // object-element array → json() (the native array() only stores scalar JsonValue elements)
      items: json<Array<{ sku: string; quantity: number; price: number; name?: string }>>(),
      placedAt: date(),
      createdAt: date(),
      updatedAt: date()
    },
    indexes: [
      { name: "customerId_createdAt", fields: ["customerId", { path: "createdAt", descending: true }] },
      { name: "status_createdAt", fields: ["status", { path: "createdAt", descending: true }] },
      { name: "requestId_unique", fields: ["requestId"], unique: true, where: exists("requestId") }
    ]
  });

  const events = orm.define({
    name: "events",
    properties: {
      customerId: text({ index: true }),
      productId: text(),
      eventType: text({
        schema: z.enum(["viewed", "added_to_cart", "checkout_started", "purchased", "purchase_failed"])
      }),
      variant: text({ schema: z.enum(PRICING_VARIANTS) }),
      timestamp: date(),
      error: text()
    },
    indexes: [
      { name: "eventType_productId", fields: ["eventType", "productId"] },
      { name: "eventType_customerId", fields: ["eventType", "customerId"] },
      { name: "eventType_timestamp", fields: ["eventType", { path: "timestamp", descending: true }] },
      { name: "funnel", fields: ["eventType", "timestamp", "customerId"] }
    ]
  });

  const wishlistItems = orm.define({
    name: "wishlistItems",
    properties: { productId: text({ index: true }), customerId: text({ index: true }) },
    // hyphenated compound index name — a non-identifier char that once broke SQL provisioning
    indexes: [{ name: "productId-customerId", fields: ["customerId", "productId"], unique: true }]
  });

  const sessions = orm.define({
    name: "sessions",
    properties: {
      customerId: text({ index: true }),
      sessionId: text({ unique: true }),
      createdAt: date(),
      updatedAt: date(),
      platform: text({ schema: z.enum(["web", "android", "ios"]) })
    },
    // TTL index: sessions expire 30 days after the last touch
    indexes: [{ name: "autoExpire", fields: ["updatedAt"], ttlSeconds: 2_592_000 }]
  });

  return { products, customers, orders, events, wishlistItems, sessions };
}
