/**
 * Live Postgres / MySQL integration — validates the real `PostgresBackend` / `MySqlBackend` against
 * actual engines, which pg-mem can't (type-exact behavior, real transactional rollback, real unique
 * enforcement). Connection: `PG_URL` / `MYSQL_URL` if set, else the local defaults; if an engine
 * isn't reachable the block soft-skips, so it never breaks the build offline.
 *
 * This is the harness the JSON-path push-down work needs — pg-mem can't run the type-exact `jsonb #>`
 * operators, so nested-path push-down can only be verified against a real engine here.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { exclusiveLiveDbs, requireLiveDb } from "../testing/liveDb.testutil.js";
import pg from "pg";
import { createPool, type Pool as MySqlPool } from "mysql2/promise";
import type { MigrationBuilder } from "../migrations/types.js";
import { runMigrations } from "../migrations/run.js";
import { planMigrations } from "../migrations/plan.js";
import { PostgresBackend } from "./sql/PostgresBackend.js";
import { MySqlBackend } from "./sql/MySqlBackend.js";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer, float, date, boolean, embedded, relationToOne } from "../properties/factories.js";
import { gt, eq, inList, div, mod, field, isNull, isNotNull } from "../expressions/index.js";
import type { Expression } from "../expressions/index.js";
import { inc } from "../repository/patch.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { UniqueConstraintError } from "./util/unique.js";
import type { Backend } from "../core/Backend.js";

// Shared across the embedded()/windowed()/countDistinct push-down tests below (one per engine): a
// declared embedded() subdocument (NOT the `_extra` overflow NESTED_QUERIES above exercises), rows
// for a partitioned ranking, and rows with a duplicate value to distinct-count. Table names are
// engine-suffixed (`_pg`/`_my`) so both describe blocks can run against a shared local Postgres/MySQL
// without colliding.
type Sub = { provider: string; customerId?: string; status?: string };
const EMBEDDED_ROWS = [
  { name: "a", subscription: { provider: "stripe", customerId: "cus_1", status: "active" } },
  { name: "b", subscription: { provider: "apple", customerId: "cus_2", status: "canceled" } },
  { name: "c", subscription: { provider: "stripe", customerId: "cus_3", status: "active" } }
];
const WINDOW_ROWS = [
  { user: "u1", amount: 10 },
  { user: "u1", amount: 30 },
  { user: "u2", amount: 20 },
  { user: "u2", amount: 5 }
];
const DISTINCT_ROWS = [
  { day: "mon", userId: "u1" },
  { day: "mon", userId: "u1" }, // dup — 1 distinct
  { day: "mon", userId: "u2" },
  { day: "tue", userId: "u1" }
];

const ctx = SYSTEM_CONTEXT;

// Records with embedded objects under undeclared keys — they land in the `_extra` overflow, which is
// exactly where nested-path push-down applies (and what the in-memory reference's getPath traverses).
const NESTED = [
  { uuid: "1", name: "a", address: { city: "NYC" }, meta: { level: 2 } },
  { uuid: "2", name: "b", address: { city: "LA" }, meta: { level: 5 } },
  { uuid: "3", name: "c", address: { city: "NYC" }, meta: { level: 3 } }
];
const NESTED_QUERIES: Expression[] = [
  eq("address.city", "NYC"), // → 1, 3
  eq("meta.level", 2), // → 1 only (type-exact number: 2 ≠ 3/5)
  inList("address.city", ["NYC", "LA"]) // → 1, 2, 3
];
async function seedNested(be: Backend): Promise<void> {
  await (be as Backend & { registerModel(m: string, i: never[], f: never[]): unknown }).registerModel("nested_m", [], []);
  for (const doc of NESTED) be.save("nested_m", { ...doc }, ctx);
  await be.persist(ctx);
}
async function idsFor(be: Backend, where: Expression): Promise<string[]> {
  const rows = await be.query(
    { model: "nested_m", where: where.serialize(), order: [{ property: "uuid", descending: false }], paging: { start: 0 } },
    ctx
  );
  return rows.map((r) => String(r.uuid));
}

const PG_URL = process.env.PG_URL ?? "postgres://test:test@127.0.0.1:5432/test";
const MYSQL_URL = process.env.MYSQL_URL ?? "mysql://test:test@127.0.0.1:3306/test";

let releaseLiveDbs: () => Promise<void> = async () => {};
beforeAll(async () => {
  releaseLiveDbs = await exclusiveLiveDbs(PG_URL, MYSQL_URL);
}, 700_000);
afterAll(async () => {
  await releaseLiveDbs();
});

const DATA = [
  { name: "Ann", age: 30, city: "eu" },
  { name: "Bob", age: 45, city: "us" },
  { name: "Cy", age: 30, city: "eu" },
  { name: "Di", age: 19, city: "us" }
];

describe("Postgres (real engine)", () => {
  let pool: pg.Pool | undefined;
  beforeAll(async () => {
    try {
      pool = new pg.Pool({ connectionString: PG_URL });
      for (const t of ["int_person", "int_tx", "nested_m", "iso_pg", "uniq_pg", "types_pg", "emb_pg", "win_pg", "cd_pg", "dirty_pg", "null_pg", "prechk_pg", "prechk2_pg", "soft_pg", "rel_cust_pg", "rel_ord_pg"]) await pool.query(`DROP TABLE IF EXISTS "${t}"`);
    } catch (error) {
      requireLiveDb(error);
      pool = undefined;
    }
  });
  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("columnar CRUD + filter/sort/count/aggregate/patch", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new PostgresBackend(pool) });
    const people = orm.define({ name: "int_person", properties: { name: text(), age: integer(), city: text() } });
    await orm.transaction(async () => {
      for (const p of DATA) people.save(people.createInstance(p));
    });

    expect(await people.all().count()).toBe(4);
    // sort by (age, name) so ties (Ann & Cy are both 30) are deterministic across engines
    expect((await people.all().filter(gt("age", 20)).sort("age").sort("name").list()).map((p) => p.name)).toEqual(["Ann", "Cy", "Bob"]);

    const byCity = await people.all().groupBy("city", (a) => ({ n: a.count(), avg: a.avg("age") }));
    const eu = byCity.find((g) => g.key === "eu")!;
    expect([eu.n, eu.avg]).toEqual([2, 30]);

    const ann = (await people.all().filter(gt("age", 29)).sort("name").list())[0]!;
    await people.patch(ann.uuid, { age: inc(1) }); // real server-side UPDATE … SET age = age + 1
    expect((await people.get(ann.uuid))!.age).toBe(31);
  });

  it("a real transaction rollback actually reverts (pg-mem can't verify this)", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new PostgresBackend(pool) });
    const t = orm.define({ name: "int_tx", properties: { n: integer() } }); // int_tx dropped in beforeAll

    await orm.transaction(async () => t.save(t.createInstance({ n: 1 })));
    expect(await t.all().count()).toBe(1);

    await expect(
      orm.transaction(async () => {
        t.save(t.createInstance({ n: 2 }));
        throw new Error("boom");
      })
    ).rejects.toThrow(/boom/);
    expect(await t.all().count()).toBe(1); // the n:2 row was really rolled back
  });

  it("nested-path eq/in pushes down to jsonb #> and matches the in-memory reference", async () => {
    if (!pool) return;
    const reference = new InMemoryBackend();
    await seedNested(reference);

    await pool.query('DROP TABLE IF EXISTS "nested_m"');
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      connect: () => pool!.connect()
    });
    await seedNested(spy);
    seen.length = 0;

    for (const where of NESTED_QUERIES) {
      expect(await idsFor(spy, where), JSON.stringify(where.serialize())).toEqual(await idsFor(reference, where));
    }
    expect(seen.some((s) => s.includes("#>"))).toBe(true); // ran as JSON extraction, not a scan
  });

  it("embedded() dotted-path filter pushes down to jsonb #> and matches the in-memory reference", async () => {
    if (!pool) return;
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const users = orm.define({ name: "emb_pg", properties: { name: text(), subscription: embedded<Sub>() } });
      for (const row of EMBEDDED_ROWS) users.save(users.createInstance(row));
      return users;
    };
    const refUsers = seed(new InMemoryBackend());
    await refUsers.persist();

    await pool.query('DROP TABLE IF EXISTS "emb_pg"');
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      connect: () => pool!.connect()
    });
    const users = seed(spy);
    await users.persist();
    seen.length = 0;

    const names = (r: { all(): { filter(e: Expression): { sort(f: string): { list(): Promise<{ name: string }[]> } } } }) =>
      r.all().filter(eq("subscription.status", "active")).sort("name").list();
    expect((await names(users)).map((u) => u.name)).toEqual((await names(refUsers)).map((u) => u.name));
    expect(seen.some((s) => s.includes("#>"))).toBe(true); // pushed down, not a scan
  });

  it("windowed() rank() pushes down to RANK() OVER (…) and matches the in-memory reference", async () => {
    if (!pool) return;
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const events = orm.define({ name: "win_pg", properties: { user: text(), amount: integer() } });
      for (const row of WINDOW_ROWS) events.save(events.createInstance(row));
      return events;
    };
    const refEvents = seed(new InMemoryBackend());
    await refEvents.persist();

    await pool.query('DROP TABLE IF EXISTS "win_pg"');
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      connect: () => pool!.connect()
    });
    const events = seed(spy);
    await events.persist();
    seen.length = 0;

    const ranked = (r: typeof events) =>
      r
        .all()
        .sort("amount", true)
        .windowed({ partitionBy: "user" }, (w) => ({ r: w.rank() }))
        .then((rows) => rows.map((x) => ({ user: x.user, amount: x.amount, r: x.r })).sort((a, b) => (a.user + a.r).localeCompare(b.user + b.r)));
    expect(await ranked(events)).toEqual(await ranked(refEvents));
    expect(seen.some((s) => s.includes("OVER ("))).toBe(true); // pushed down, not the in-memory fallback
  });

  it("countDistinct pushes down to COUNT(DISTINCT …) and matches the in-memory reference", async () => {
    if (!pool) return;
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const events = orm.define({ name: "cd_pg", properties: { day: text(), userId: text() } });
      for (const row of DISTINCT_ROWS) events.save(events.createInstance(row));
      return events;
    };
    const refEvents = seed(new InMemoryBackend());
    await refEvents.persist();

    await pool.query('DROP TABLE IF EXISTS "cd_pg"');
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      connect: () => pool!.connect()
    });
    const events = seed(spy);
    await events.persist();
    seen.length = 0;

    const byDay = (r: typeof events) =>
      r
        .all()
        .groupBy("day", (a) => ({ users: a.countDistinct("userId") }))
        .then((rows) => [...rows].sort((a, b) => String(a.key).localeCompare(String(b.key))));
    expect(await byDay(events)).toEqual(await byDay(refEvents));
    expect(seen.some((s) => s.toUpperCase().includes("DISTINCT"))).toBe(true); // pushed down, not scanned
  });

  it("save()-triggered UPDATE only touches the changed column (dirty-field tracking)", async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS "dirty_pg"');
    const seen: string[] = [];
    // `persist()`'s writes run inside a transaction on a checked-out connection (not the top-level
    // `query`), so the connection returned by `connect()` needs its own spy too.
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      connect: async () => {
        const conn = await pool!.connect();
        return { query: (t: string, p: unknown[]) => { seen.push(t); return conn.query(t, p); }, release: () => conn.release() };
      }
    });
    const orm = new RepositoryManager({ backend: spy });
    const users = orm.define({ name: "dirty_pg", properties: { name: text(), age: integer(), city: text() } });
    const ann = users.createInstance({ name: "Ann", age: 30, city: "eu" });
    const bob = users.createInstance({ name: "Bob", age: 45, city: "us" });
    const cy = users.createInstance({ name: "Cy", age: 30, city: "eu" });
    users.save(ann).save(bob).save(cy);
    await users.persist();
    seen.length = 0;

    ann.age = 31; // only `age` changed
    bob.age = 46; // same shape as ann's change — should share one batched statement
    cy.city = "us"; // a different column changed — its own statement
    users.save(ann).save(bob).save(cy);
    await users.persist();

    const updates = seen.filter((s) => s.includes("ON CONFLICT"));
    const ageOnly = updates.filter((s) => s.includes(`DO UPDATE SET "age" = excluded."age"`) && !s.includes('"name" = excluded'));
    const cityOnly = updates.filter((s) => s.includes(`DO UPDATE SET "city" = excluded."city"`) && !s.includes('"age" = excluded'));
    expect(ageOnly).toHaveLength(1); // ann + bob batched into one multi-row statement
    expect(ageOnly[0]).toContain("), ("); // two value tuples in that one statement, one round trip
    expect(cityOnly).toHaveLength(1); // cy, alone (different dirty signature)

    // Re-read through a fresh, unrelated repository — a real query, not the identity-map cache.
    const reader = new RepositoryManager({ backend: new PostgresBackend(pool) }).define({
      name: "dirty_pg",
      properties: { name: text(), age: integer(), city: text() }
    });
    expect(await reader.get(ann.uuid)).toMatchObject({ name: "Ann", age: 31, city: "eu" });
    expect(await reader.get(bob.uuid)).toMatchObject({ name: "Bob", age: 46, city: "us" });
    expect(await reader.get(cy.uuid)).toMatchObject({ name: "Cy", age: 30, city: "us" });
  });

  it("isNull/isNotNull push down to IS [NOT] NULL and match the in-memory reference", async () => {
    if (!pool) return;
    const rows = [
      { name: "a", age: 20 },
      { name: "b" }, // age absent → NULL column
      { name: "c" },
      { name: "d", age: 40 }
    ];
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const people = orm.define({ name: "null_pg", properties: { name: text(), age: integer() } });
      for (const row of rows) people.save(people.createInstance(row));
      return people;
    };
    const ref = seed(new InMemoryBackend());
    await ref.persist();

    await pool.query('DROP TABLE IF EXISTS "null_pg"');
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => { seen.push(t); return pool!.query(t, p); },
      connect: () => pool!.connect()
    });
    const people = seed(spy);
    await people.persist();
    seen.length = 0;

    const names = async (r: typeof people, e: Expression) => (await r.all().filter(e).sort("name").list()).map((x) => x.name);
    expect(await names(people, isNull("age"))).toEqual(await names(ref, isNull("age")));
    expect(await names(people, isNotNull("age"))).toEqual(await names(ref, isNotNull("age")));
    expect(await names(people, isNull("age"))).toEqual(["b", "c"]);
    expect(seen.some((s) => /"age"\s+IS\s+NULL/i.test(s))).toBe(true); // pushed down, not scanned
    expect(seen.some((s) => /"age"\s+IS\s+NOT\s+NULL/i.test(s))).toBe(true);
  });

  it("interactive transaction: uncommitted writes are visible in-tx but isolated from other connections", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new PostgresBackend(pool) });
    orm.define({ name: "iso_pg", properties: { n: integer() } });
    const outsideCount = async () => Number((await pool!.query('SELECT COUNT(*)::int AS n FROM "iso_pg"')).rows[0]!.n);

    await orm.transaction(async (tx) => {
      const items = tx.repository("iso_pg");
      items.save(items.createInstance({ n: 1 }));
      await items.persist(); // INSERT on the tx's checked-out connection, uncommitted
      expect(await items.all().count()).toBe(1); // the tx sees its own uncommitted row…
      expect(await outsideCount()).toBe(0); // …but a separate pool connection does NOT (real isolation)
    });
    expect(await outsideCount()).toBe(1); // committed → now visible everywhere

    await expect(
      orm.transaction(async (tx) => {
        const items = tx.repository("iso_pg");
        items.save(items.createInstance({ n: 99 }));
        await items.persist();
        throw new Error("rollback");
      })
    ).rejects.toThrow(/rollback/);
    expect(await outsideCount()).toBe(1); // the n:99 write was truly rolled back
  });

  it("enforces a real UNIQUE index (a duplicate insert throws)", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new PostgresBackend(pool) });
    const users = orm.define({ name: "uniq_pg", properties: { email: text({ unique: true }) } });
    await orm.transaction(async () => users.save(users.createInstance({ email: "a@x.io" })));

    users.save(users.createInstance({ email: "a@x.io" })); // duplicate
    await expect(users.persist()).rejects.toThrow(); // the DB unique index rejects it
    expect(await users.all().count()).toBe(1);
  });

  it("a to-one relation filter pushes down to a jsonb extraction and matches the reference (no crash)", async () => {
    if (!pool) return;
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const customers = orm.define({ name: "rel_cust_pg", properties: { country: text() } });
      const orders = orm.define({
        name: "rel_ord_pg",
        properties: { ref: text(), customer: relationToOne<{ uuid: string; country: string }>({ model: "rel_cust_pg" }) }
      });
      return { customers, orders };
    };
    const refSeed = async (backend: Backend) => {
      const { customers, orders } = seed(backend);
      const de = customers.createInstance({ country: "DE" });
      const us = customers.createInstance({ country: "US" });
      customers.save(de).save(us);
      await customers.persist();
      orders.save(orders.createInstance({ ref: "o1", customer: de }));
      orders.save(orders.createInstance({ ref: "o2", customer: us }));
      await orders.persist();
      return orders;
    };
    const ref = await refSeed(new InMemoryBackend());

    await pool.query('DROP TABLE IF EXISTS "rel_ord_pg"');
    await pool.query('DROP TABLE IF EXISTS "rel_cust_pg"');
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => { seen.push(t); return pool!.query(t, p); },
      connect: () => pool!.connect()
    });
    const orders = await refSeed(spy);
    seen.length = 0;

    const refs = async (r: typeof orders) => (await r.all().filter(eq("customer.country", "DE")).sort("ref").list()).map((o) => o.ref);
    expect(await refs(orders)).toEqual(await refs(ref)); // matches the in-memory reference (was a crash before)
    expect(await refs(orders)).toEqual(["o1"]);
    expect(seen.some((s) => s.includes("#>"))).toBe(true); // the relation ref filter pushed down to _extra
  });

  it("soft-delete's live filter pushes down to deletedAt IS NULL (opt-in)", async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS "soft_pg"');
    const seen: string[] = [];
    const spy = new PostgresBackend({
      query: (t: string, p: unknown[]) => { seen.push(t); return pool!.query(t, p); },
      connect: () => pool!.connect()
    });
    const orm = new RepositoryManager({ backend: spy });
    const notes = orm.define({ name: "soft_pg", properties: { title: text() }, softDelete: true });
    const a = notes.createInstance({ title: "a" });
    const b = notes.createInstance({ title: "b" });
    notes.save(a).save(b);
    await notes.persist();
    notes.remove(a);
    await notes.persist();
    seen.length = 0;

    expect((await notes.all().sort("title").list()).map((n) => n.title)).toEqual(["b"]); // a is hidden
    expect(seen.some((s) => /"deletedAt"\s+IS\s+NULL/i.test(s))).toBe(true); // pushed down, not scanned
    expect(await notes.all().count()).toBe(1);
    expect(await notes.all().includeDeleted().count()).toBe(2); // still in the store
  });

  it("pre-write unique check raises the friendly error before the write (opt-in)", async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS "prechk_pg"');
    const seen: string[] = [];
    const spy = new PostgresBackend(
      {
        query: (t: string, p: unknown[]) => { seen.push(t); return pool!.query(t, p); },
        connect: async () => {
          const conn = await pool!.connect();
          return { query: (t: string, p: unknown[]) => { seen.push(t); return conn.query(t, p); }, release: () => conn.release() };
        }
      },
      undefined,
      { uniquePreCheck: true }
    );
    const orm = new RepositoryManager({ backend: spy });
    const users = orm.define({ name: "prechk_pg", properties: { email: text({ unique: true }) } });
    users.save(users.createInstance({ email: "a@x.io" }));
    await users.persist();
    seen.length = 0;

    users.save(users.createInstance({ email: "a@x.io" })); // duplicate
    const err = await users.persist().catch((e) => e);
    expect(err).toBeInstanceOf(UniqueConstraintError); // friendly error, not a raw pg error
    expect(seen.some((s) => /SELECT uuid FROM "prechk_pg" WHERE uuid NOT IN/.test(s))).toBe(true); // pre-check ran
    expect(await users.all().count()).toBe(1); // nothing extra landed

    // compound unique key on a real engine (pg-mem can't run the compound pre-check SELECT)
    const bookings = orm.define({
      name: "prechk2_pg",
      properties: { day: text(), room: text() },
      indexes: [{ name: "day_room", fields: ["day", "room"], unique: true }]
    });
    bookings.save(bookings.createInstance({ day: "mon", room: "A" }));
    bookings.save(bookings.createInstance({ day: "mon", room: "B" })); // partial overlap → ok
    await bookings.persist();
    bookings.save(bookings.createInstance({ day: "mon", room: "A" })); // full tuple repeats
    const cErr = await bookings.persist().catch((e) => e);
    expect(cErr).toBeInstanceOf(UniqueConstraintError);
    expect((cErr as UniqueConstraintError).fields).toEqual(["day", "room"]);
  });

  it("migrates, journals, and is a no-op on re-run — against a real server", async () => {
    // pg-mem accepts a NUL byte in text; PostgreSQL rejects it. A journal id containing one was written
    // by every test here and could never be written in production, so this has to run on the real engine.
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS "mig_pg", "_object_repository_migration_log", "_object_repository_schema_state"`);
    const orm = new RepositoryManager({ backend: new PostgresBackend(pool) });
    const migrations = [
      { name: "m1_create", up: (m: MigrationBuilder) => m.createTable("mig_pg", [{ name: "n", type: "integer" }]) },
      { name: "m2_addcol", up: (m: MigrationBuilder) => m.addColumn("mig_pg", "label", "text") },
      { name: "m3_rename", up: (m: MigrationBuilder) => m.renameColumn("mig_pg", "label", "tag") }
    ];
    expect((await orm.migrate(migrations)).applied).toEqual(["m1_create", "m2_addcol", "m3_rename"]);
    await orm.raw({ sql: `INSERT INTO "mig_pg" ("uuid", "n", "tag", "_extra") VALUES ($1, $2, $3, $4)`, params: ["r1", 5, "hi", null] });
    expect(await orm.raw<{ tag: string }>({ sql: `SELECT "tag" FROM "mig_pg"` })).toEqual([{ tag: "hi" }]);

    const again = await orm.migrate(migrations);
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual(["m1_create", "m2_addcol", "m3_rename"]);
  });

  it("runs the documented rename timeline against a real server", async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS "tl_pg", "_object_repository_migration_log", "_object_repository_schema_state"`);
    const migrations = [
      { name: "tl_rename", schemaVersion: 7, up: (m: MigrationBuilder) => m.renameField("tl_pg", "name", "fullName", "text") }
    ];
    const v6 = new RepositoryManager({ backend: new PostgresBackend(pool) });
    const users = v6.define({ name: "tl_pg", properties: { name: text() } });
    users.save(users.createInstance({ uuid: "u1", name: "Ann" }));
    await users.persist();

    const shipped = await new RepositoryManager({
      backend: new PostgresBackend(pool),
      schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 }
    }).migrate(migrations);
    expect(shipped.expanded).toEqual(["tl_rename"]);
    expect(shipped.deferred).toHaveLength(1);

    const released = await new RepositoryManager({
      backend: new PostgresBackend(pool),
      schema: { schemaVersion: 7, minSupportedSchemaVersion: 7 }
    }).migrate(migrations, { applyContracts: true });
    expect(released.contracted).toEqual(["tl_rename"]);
    expect(await pool.query(`SELECT "fullName" FROM "tl_pg"`).then((r) => r.rows)).toEqual([{ fullName: "Ann" }]);
  });

  it("round-trips scalar types faithfully (int / float / date / bool)", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new PostgresBackend(pool) });
    const m = orm.define({ name: "types_pg", properties: { i: integer(), f: float(), d: date(), b: boolean() } });
    const when = new Date("2021-03-04T05:06:07.000Z");
    const inst = m.createInstance({ i: 42, f: 3.14, d: when, b: true });
    m.save(inst);
    await m.persist();

    const back = (await m.get(inst.uuid))!;
    expect(back.i).toBe(42); // pg returns bigint as a string → decoded back to a number
    expect(back.f).toBeCloseTo(3.14, 5);
    expect(back.d).toBeInstanceOf(Date);
    expect((back.d as Date).getTime()).toBe(when.getTime()); // date stored as epoch bigint, decoded to Date
    expect(back.b).toBe(true);
  });
  it("builds the unique indexes a migration pass set aside, once the data allows it", async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS "dedupe_pg", "_object_repository_migration_log", "_object_repository_schema_state"`);
    const backend = new PostgresBackend(pool);
    const byEmail = { name: "email", fields: [{ path: "email" }], unique: true };
    const models = { dedupe_pg: { fields: [{ name: "email", type: "text" as const }], indexes: [byEmail] } };
    await backend.registerModel("dedupe_pg", [], models.dedupe_pg.fields);
    backend.save("dedupe_pg", { uuid: "u1", email: "a@x" }, ctx);
    backend.save("dedupe_pg", { uuid: "u2", email: "a@x" }, ctx);
    await backend.persist(ctx);
    await backend.registerModel("dedupe_pg", [byEmail], models.dedupe_pg.fields); // over duplicates: fails quietly

    await runMigrations(
      backend,
      [
        {
          name: "0070_dedupe",
          transforms: { dedupe: (row: Record<string, unknown>) => (row.uuid === "u2" ? null : row) } as never,
          up: (m) => m.transform("dedupe_pg", "dedupe", ["email"], undefined, { phase: "contract" })
        }
      ],
      { models, applyContracts: true, skipLock: true }
    );
    backend.save("dedupe_pg", { uuid: "u3", email: "a@x" }, ctx);
    await expect(backend.persist(ctx)).rejects.toThrow();
  });
});

describe("MySQL (real engine)", () => {
  let pool: MySqlPool | undefined;
  beforeAll(async () => {
    try {
      pool = createPool(MYSQL_URL);
      for (const t of ["int_person_my", "nested_m", "uniq_my", "upsert_my", "mig_my", "types_my", "_object_repository_migrations", "emb_my", "win_my", "cd_my", "dirty_my", "null_my", "longtext_my", "idxtext_my", "prechk_my"]) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    } catch (error) {
      requireLiveDb(error);
      pool = undefined;
    }
  });
  afterAll(async () => {
    await pool?.end().catch(() => {});
  });

  it("columnar CRUD + filter/sort/count/aggregate", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const people = orm.define({ name: "int_person_my", properties: { name: text(), age: integer(), city: text() } });
    await orm.transaction(async () => {
      for (const p of DATA) people.save(people.createInstance(p));
    });

    expect(await people.all().count()).toBe(4);
    expect((await people.all().filter(gt("age", 20)).sort("age").sort("name").list()).map((p) => p.name)).toEqual(["Ann", "Cy", "Bob"]);

    const byCity = await people.all().groupBy("city", (a) => ({ n: a.count(), avg: a.avg("age") }));
    const us = byCity.find((g) => g.key === "us")!;
    expect([us.n, us.avg]).toEqual([2, 32]); // (45 + 19) / 2
  });

  it("nested-path eq/in pushes down to JSON_EXTRACT and matches the in-memory reference", async () => {
    if (!pool) return;
    const reference = new InMemoryBackend();
    await seedNested(reference);

    await pool.query("DROP TABLE IF EXISTS `nested_m`");
    const seen: string[] = [];
    const spy = new MySqlBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      getConnection: () => pool!.getConnection()
    } as never);
    await seedNested(spy);
    seen.length = 0;

    for (const where of NESTED_QUERIES) {
      expect(await idsFor(spy, where), JSON.stringify(where.serialize())).toEqual(await idsFor(reference, where));
    }
    expect(seen.some((s) => s.includes("JSON_EXTRACT"))).toBe(true);
  });

  it("embedded() dotted-path filter pushes down to JSON_EXTRACT and matches the in-memory reference", async () => {
    if (!pool) return;
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const users = orm.define({ name: "emb_my", properties: { name: text(), subscription: embedded<Sub>() } });
      for (const row of EMBEDDED_ROWS) users.save(users.createInstance(row));
      return users;
    };
    const refUsers = seed(new InMemoryBackend());
    await refUsers.persist();

    await pool.query("DROP TABLE IF EXISTS `emb_my`");
    const seen: string[] = [];
    const spy = new MySqlBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      getConnection: () => pool!.getConnection()
    } as never);
    const users = seed(spy);
    await users.persist();
    seen.length = 0;

    const names = (r: { all(): { filter(e: Expression): { sort(f: string): { list(): Promise<{ name: string }[]> } } } }) =>
      r.all().filter(eq("subscription.status", "active")).sort("name").list();
    expect((await names(users)).map((u) => u.name)).toEqual((await names(refUsers)).map((u) => u.name));
    expect(seen.some((s) => s.includes("JSON_EXTRACT"))).toBe(true);
  });

  it("windowed() rank() pushes down to RANK() OVER (…) and matches the in-memory reference", async () => {
    if (!pool) return;
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const events = orm.define({ name: "win_my", properties: { user: text(), amount: integer() } });
      for (const row of WINDOW_ROWS) events.save(events.createInstance(row));
      return events;
    };
    const refEvents = seed(new InMemoryBackend());
    await refEvents.persist();

    await pool.query("DROP TABLE IF EXISTS `win_my`");
    const seen: string[] = [];
    const spy = new MySqlBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      getConnection: () => pool!.getConnection()
    } as never);
    const events = seed(spy);
    await events.persist();
    seen.length = 0;

    const ranked = (r: typeof events) =>
      r
        .all()
        .sort("amount", true)
        .windowed({ partitionBy: "user" }, (w) => ({ r: w.rank() }))
        .then((rows) => rows.map((x) => ({ user: x.user, amount: x.amount, r: x.r })).sort((a, b) => (a.user + a.r).localeCompare(b.user + b.r)));
    expect(await ranked(events)).toEqual(await ranked(refEvents));
    expect(seen.some((s) => s.includes("OVER ("))).toBe(true);
  });

  it("countDistinct pushes down to COUNT(DISTINCT …) and matches the in-memory reference", async () => {
    if (!pool) return;
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const events = orm.define({ name: "cd_my", properties: { day: text(), userId: text() } });
      for (const row of DISTINCT_ROWS) events.save(events.createInstance(row));
      return events;
    };
    const refEvents = seed(new InMemoryBackend());
    await refEvents.persist();

    await pool.query("DROP TABLE IF EXISTS `cd_my`");
    const seen: string[] = [];
    const spy = new MySqlBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      getConnection: () => pool!.getConnection()
    } as never);
    const events = seed(spy);
    await events.persist();
    seen.length = 0;

    const byDay = (r: typeof events) =>
      r
        .all()
        .groupBy("day", (a) => ({ users: a.countDistinct("userId") }))
        .then((rows) => [...rows].sort((a, b) => String(a.key).localeCompare(String(b.key))));
    expect(await byDay(events)).toEqual(await byDay(refEvents));
    expect(seen.some((s) => s.toUpperCase().includes("DISTINCT"))).toBe(true);
  });

  it("save()-triggered UPDATE only touches the changed column (dirty-field tracking)", async () => {
    if (!pool) return;
    await pool.query("DROP TABLE IF EXISTS `dirty_my`");
    const seen: string[] = [];
    // `persist()`'s writes run inside a transaction on a checked-out connection (not the top-level
    // `query`), so the connection returned by `getConnection()` needs its own spy too.
    const spy = new MySqlBackend({
      query: (t: string, p: unknown[]) => {
        seen.push(t);
        return pool!.query(t, p);
      },
      getConnection: async () => {
        const conn = await pool!.getConnection();
        return {
          query: (t: string, p: unknown[]) => { seen.push(t); return conn.query(t, p); },
          beginTransaction: () => conn.beginTransaction(),
          commit: () => conn.commit(),
          rollback: () => conn.rollback(),
          release: () => conn.release()
        };
      }
    } as never);
    const orm = new RepositoryManager({ backend: spy });
    const users = orm.define({ name: "dirty_my", properties: { name: text(), age: integer(), city: text() } });
    const ann = users.createInstance({ name: "Ann", age: 30, city: "eu" });
    const bob = users.createInstance({ name: "Bob", age: 45, city: "us" });
    const cy = users.createInstance({ name: "Cy", age: 30, city: "eu" });
    users.save(ann).save(bob).save(cy);
    await users.persist();
    seen.length = 0;

    ann.age = 31; // only `age` changed
    bob.age = 46; // same shape as ann's change — should share one batched statement
    cy.city = "us"; // a different column changed — its own statement
    users.save(ann).save(bob).save(cy);
    await users.persist();

    const updates = seen.filter((s) => s.startsWith("UPDATE `dirty_my`"));
    const ageOnly = updates.filter((s) => s.includes("SET `age` = CASE") && !s.includes("`name` = CASE"));
    const cityOnly = updates.filter((s) => s.includes("SET `city` = CASE") && !s.includes("`age` = CASE"));
    expect(ageOnly).toHaveLength(1); // ann + bob batched into one statement
    expect(ageOnly[0]!.match(/WHEN \?/g)).toHaveLength(2); // both rows in that one statement, one round trip
    expect(cityOnly).toHaveLength(1); // cy, alone (different dirty signature)

    // Re-read through a fresh, unrelated repository — a real query, not the identity-map cache.
    const reader = new RepositoryManager({ backend: new MySqlBackend(pool) }).define({
      name: "dirty_my",
      properties: { name: text(), age: integer(), city: text() }
    });
    expect(await reader.get(ann.uuid)).toMatchObject({ name: "Ann", age: 31, city: "eu" });
    expect(await reader.get(bob.uuid)).toMatchObject({ name: "Bob", age: 46, city: "us" });
    expect(await reader.get(cy.uuid)).toMatchObject({ name: "Cy", age: 30, city: "us" });
  });

  it("isNull/isNotNull push down to IS [NOT] NULL and match the in-memory reference", async () => {
    if (!pool) return;
    const rows = [
      { name: "a", age: 20 },
      { name: "b" },
      { name: "c" },
      { name: "d", age: 40 }
    ];
    const seed = (backend: Backend) => {
      const orm = new RepositoryManager({ backend });
      const people = orm.define({ name: "null_my", properties: { name: text(), age: integer() } });
      for (const row of rows) people.save(people.createInstance(row));
      return people;
    };
    const ref = seed(new InMemoryBackend());
    await ref.persist();

    await pool.query("DROP TABLE IF EXISTS `null_my`");
    const seen: string[] = [];
    const spy = new MySqlBackend({
      query: (t: string, p: unknown[]) => { seen.push(t); return pool!.query(t, p); },
      getConnection: () => pool!.getConnection()
    } as never);
    const people = seed(spy);
    await people.persist();
    seen.length = 0;

    const names = async (r: typeof people, e: Expression) => (await r.all().filter(e).sort("name").list()).map((x) => x.name);
    expect(await names(people, isNull("age"))).toEqual(await names(ref, isNull("age")));
    expect(await names(people, isNotNull("age"))).toEqual(await names(ref, isNotNull("age")));
    expect(await names(people, isNull("age"))).toEqual(["b", "c"]);
    expect(seen.some((s) => /`age`\s+IS\s+NULL/i.test(s))).toBe(true); // pushed down, not scanned
    expect(seen.some((s) => /`age`\s+IS\s+NOT\s+NULL/i.test(s))).toBe(true);
  });

  it("stores long text without truncation (TEXT column, not varchar(255))", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const docs = orm.define({ name: "longtext_my", properties: { body: text() } });
    const long = "x".repeat(5000); // well past varchar(255)
    const d = docs.createInstance({ body: long });
    docs.save(d);
    await docs.persist();
    expect((await docs.get(d.uuid))!.body).toBe(long); // round-trips intact, not truncated to 255
    expect((await docs.get(d.uuid))!.body.length).toBe(5000);
  });

  it("indexes a TEXT column via a key-length prefix (no error, filter still works)", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const users = orm.define({ name: "idxtext_my", properties: { email: text({ index: true }) } });
    const u = users.createInstance({ email: "person@example.com" });
    users.save(u);
    await users.persist(); // provisioning must build `email`(255) — a bare TEXT index would error
    expect((await users.all().filter(eq("email", "person@example.com")).list()).map((x) => x.uuid)).toEqual([u.uuid]);
    // confirm the index really exists with a prefix length
    const idx = (await pool.query("SHOW INDEX FROM `idxtext_my` WHERE `Key_name` = 'idxtext_my_email'"))[0] as { Sub_part: number | null }[];
    expect(idx[0]?.Sub_part).toBe(255);
  });

  it("a row another writer deletes between the check and the update is written, not silently lost", async () => {
    if (!pool) return;
    await pool.query("DROP TABLE IF EXISTS `race2_my`");
    const plain = new MySqlBackend(pool);
    await plain.registerModel("race2_my", [], [{ name: "name", type: "text" }]);
    plain.save("race2_my", { uuid: "r1", name: "old" }, ctx);
    await plain.persist(ctx);

    let raced = false;
    const racing = new MySqlBackend({
      query: (sql: string, params: unknown[]) => pool!.query(sql, params),
      getConnection: async () => {
        const conn = await pool!.getConnection();
        return {
          query: async (sql: string, params: unknown[]) => {
            const result = await conn.query(sql, params);
            if (!raced && sql.startsWith("SELECT `uuid`") && !sql.includes("FOR UPDATE")) {
              raced = true;
              await pool!.query("DELETE FROM `race2_my` WHERE `uuid` = 'r1'"); // another writer
            }
            return result;
          },
          beginTransaction: () => conn.beginTransaction(),
          commit: () => conn.commit(),
          rollback: () => conn.rollback(),
          release: () => conn.release()
        };
      }
    } as never);
    await racing.registerModel("race2_my", [], [{ name: "name", type: "text" }]);
    racing.save("race2_my", { uuid: "r1", name: "mine" }, ctx);
    await racing.persist(ctx);
    expect(raced).toBe(true);
    const [rows] = (await pool.query("SELECT `uuid`, `name` FROM `race2_my`")) as unknown as [Array<{ uuid: string; name: string }>];
    expect(rows).toEqual([{ uuid: "r1", name: "mine" }]);
  });

  const dropMigrationTables = async (table: string) => {
    for (const t of [table, "_object_repository_migration_log", "_object_repository_schema_state"]) await pool!.query(`DROP TABLE IF EXISTS \`${t}\``);
  };

  it("a migration indexes a TEXT column before the model is defined in this process", async () => {
    if (!pool) return;
    await dropMigrationTables("idxmig_my");
    await pool.query("CREATE TABLE `idxmig_my` (`uuid` varchar(36) PRIMARY KEY, `email` longtext, `_extra` longtext)");
    const backend = new MySqlBackend(pool); // fresh: nothing registered, as at a deploy step
    const index = { name: "email", fields: [{ path: "email" }], unique: true };
    await runMigrations(backend, [{ name: "0001_idx", up: (m) => m.addIndex("idxmig_my", index) }], {
      models: { idxmig_my: { fields: [{ name: "email", type: "text" }], indexes: [index] } }
    });
    const [rows] = (await pool.query("SHOW INDEX FROM `idxmig_my` WHERE Key_name = 'idxmig_my_email'")) as unknown as [Array<{ Sub_part: number }>];
    expect(rows.map((row) => row.Sub_part)).toEqual([255]);
  });

  it("a migration creates a model's indexes table-scoped and prefix-lengthed", async () => {
    if (!pool) return;
    await dropMigrationTables("newmodel_my");
    const index = { name: "email", fields: [{ path: "email" }], unique: true };
    await runMigrations(
      new MySqlBackend(pool),
      [{ name: "0001_create", up: (m) => m.createModel("newmodel_my", [{ name: "email", type: "text" }], [index]) }],
      { models: { newmodel_my: { fields: [{ name: "email", type: "text" }], indexes: [index] } } }
    );
    const [rows] = (await pool.query("SHOW INDEX FROM `newmodel_my` WHERE Column_name = 'email'")) as unknown as [Array<{ Key_name: string; Sub_part: number }>];
    expect(rows.map((row) => [row.Key_name, row.Sub_part])).toEqual([["newmodel_my_email", 255]]);
  });

  it("a field add after a registration in the same phase finds the column registration added", async () => {
    if (!pool) return;
    await dropMigrationTables("livecols_my");
    await pool.query("CREATE TABLE `livecols_my` (`uuid` varchar(36) PRIMARY KEY, `name` longtext, `_extra` longtext)");
    await pool.query("INSERT INTO `livecols_my` (`uuid`, `name`) VALUES ('l1', 'Ann')");
    const models = { livecols_my: { fields: [{ name: "name", type: "text" as const }, { name: "tier", type: "text" as const }], indexes: [] } };
    const report = await runMigrations(
      new MySqlBackend(pool),
      [
        {
          name: "0001_tier",
          transforms: { touch: (row) => row },
          up: (m) => {
            m.addIndex("livecols_my", { name: "name", fields: [{ path: "name" }] }); // reads the columns
            m.transform("livecols_my", "touch", ["name"]); // registers the layout: provisions `tier`
            m.addField("livecols_my", "tier", "text", { fill: "free" });
          }
        }
      ],
      { models }
    );
    expect(report.applied).toEqual(["0001_tier"]);
    const [rows] = (await pool.query("SELECT `tier` FROM `livecols_my`")) as unknown as [Array<{ tier: string }>];
    expect(rows).toEqual([{ tier: "free" }]);
  });

  const cents = (failOn?: string) => ({
    name: "0001_cents",
    transforms: {
      cents: (row: Record<string, unknown>) => {
        if (row.uuid === failOn) throw new Error(`boom on ${failOn}`);
        return { ...row, price: Number(row.price) * 100 };
      }
    }
  });
  const pricesIn = async (table: string) =>
    ((await pool!.query(`SELECT \`price\` FROM \`${table}\` ORDER BY \`uuid\``)) as unknown as [Array<{ price: number }>])[0].map((row) => Number(row.price));

  it("a phase whose DDL commits mid-way resumes instead of re-applying a transform", async () => {
    if (!pool) return;
    await dropMigrationTables("ddlcommit_my");
    const backend = new MySqlBackend(pool);
    const models = { ddlcommit_my: { fields: [{ name: "price", type: "integer" as const }], indexes: [] } };
    await backend.registerModel("ddlcommit_my", [], models.ddlcommit_my.fields);
    [1, 2, 3, 4].forEach((price, i) => backend.save("ddlcommit_my", { uuid: `i${i}`, price }, ctx));
    await backend.persist(ctx);

    const migration = (failOn?: string) => ({
      ...cents(failOn),
      up: (m: MigrationBuilder) => {
        m.addField("ddlcommit_my", "note", "text"); // DDL: MySQL commits whatever is open
        m.transform("ddlcommit_my", "cents", ["price"], undefined, { phase: "expand" });
      }
    });
    await expect(runMigrations(backend, [migration("i2")], { models, batchSize: 2 })).rejects.toThrow("boom on i2");
    await runMigrations(backend, [migration()], { models, batchSize: 2 });
    expect(await pricesIn("ddlcommit_my")).toEqual([100, 200, 300, 400]);
  });

  it("a resumed phase doesn't re-provision a column an op before the resume point dropped", async () => {
    if (!pool) return;
    await dropMigrationTables("resumedrop_my");
    const backend = new MySqlBackend(pool);
    const models = {
      resumedrop_my: { fields: [{ name: "price", type: "integer" as const }, { name: "legacy", type: "text" as const }], indexes: [] }
    };
    await backend.registerModel("resumedrop_my", [], models.resumedrop_my.fields);
    [1, 2, 3, 4].forEach((price, i) => backend.save("resumedrop_my", { uuid: `i${i}`, price, legacy: "x" }, ctx));
    await backend.persist(ctx);

    const migration = (failOn?: string) => ({
      ...cents(failOn),
      up: (m: MigrationBuilder) => {
        m.dropField("resumedrop_my", "legacy");
        m.transform("resumedrop_my", "cents", ["price"], undefined, { phase: "contract" });
      }
    });
    await expect(runMigrations(backend, [migration("i2")], { models, batchSize: 2, applyContracts: true })).rejects.toThrow("boom on i2");
    // A fresh process: its layouts still declare `legacy`.
    await runMigrations(new MySqlBackend(pool), [migration()], { models, batchSize: 2, applyContracts: true });
    const [columns] = (await pool.query("SHOW COLUMNS FROM `resumedrop_my`")) as unknown as [Array<{ Field: string }>];
    expect(columns.map((column) => column.Field)).not.toContain("legacy");
    expect(await pricesIn("resumedrop_my")).toEqual([100, 200, 300, 400]);
  });

  it("a plan previews the SQL a run will execute, following earlier ops", async () => {
    if (!pool) return;
    await dropMigrationTables("preview_my");
    await pool.query("CREATE TABLE `preview_my` (`uuid` varchar(36) PRIMARY KEY, `name` longtext, `_extra` longtext)");
    const plan = await planMigrations(new MySqlBackend(pool), [
      {
        name: "0001_preview",
        up: (m) => {
          m.renameField("preview_my", "name", "fullName", "text");
          m.addField("preview_my", "nick", "text");
          m.copyField("preview_my", "fullName", "nick", "text");
        }
      }
    ]);
    expect(plan.steps.map((step) => [step.op.kind, step.lowering])).toEqual([
      ["renameField", "native"],
      ["addField", "native"],
      ["copyField", "native"]
    ]);
    expect(plan.steps[0]!.preview).toEqual(["ALTER TABLE `preview_my` RENAME COLUMN `name` TO `fullName`"]);
  });

  it("a native JSON-quoting retype isn't run again when a later op in its phase fails", async () => {
    if (!pool) return;
    await dropMigrationTables("retypecrash_my");
    const backend = new MySqlBackend(pool);
    const before = { retypecrash_my: { fields: [{ name: "name", type: "text" as const }, { name: "price", type: "integer" as const }], indexes: [] } };
    await backend.registerModel("retypecrash_my", [], before.retypecrash_my.fields);
    ["a", "b", "c", "d"].forEach((name, i) => backend.save("retypecrash_my", { uuid: `i${i}`, name, price: i + 1 }, ctx));
    await backend.persist(ctx);

    const models = { retypecrash_my: { fields: [{ name: "name", type: "json" as const }, { name: "price", type: "integer" as const }], indexes: [] } };
    const migration = (failOn?: string) => ({
      ...cents(failOn),
      up: (m: MigrationBuilder) => {
        m.retypeField("retypecrash_my", "name", "text", "json"); // native: UPDATE … JSON_QUOTE
        m.transform("retypecrash_my", "cents", ["price"], undefined, { phase: "expand" });
      }
    });
    // Fails on the transform's first page: nothing after the retype has been journalled yet.
    await expect(runMigrations(backend, [migration("i0")], { models, batchSize: 2 })).rejects.toThrow("boom on i0");
    await runMigrations(new MySqlBackend(pool), [migration()], { models, batchSize: 2 });
    const [rows] = (await pool.query("SELECT `name` FROM `retypecrash_my` ORDER BY `uuid`")) as unknown as [Array<{ name: string }>];
    expect(rows.map((row) => row.name)).toEqual(['"a"', '"b"', '"c"', '"d"']);
    expect(await pricesIn("retypecrash_my")).toEqual([100, 200, 300, 400]);
  });

  it("a plan's preview ignores a withheld contract's effect on later steps", async () => {
    if (!pool) return;
    await dropMigrationTables("withheld_my");
    await pool.query("CREATE TABLE `withheld_my` (`uuid` varchar(36) PRIMARY KEY, `name` longtext, `nick` longtext, `_extra` longtext)");
    const plan = await planMigrations(
      new MySqlBackend(pool),
      [
        { name: "0001_rename", schemaVersion: 5, up: (m) => m.renameField("withheld_my", "name", "fullName", "text") },
        { name: "0002_nick", up: (m) => m.copyField("withheld_my", "name", "nick", "text") }
      ],
      { schemaVersion: 5, minSupportedSchemaVersion: 0 }
    );
    const copy = plan.steps.find((step) => step.migration === "0002_nick")!;
    expect(copy.lowering).toBe("native"); // the rename's drop of `name` is withheld: `name` is still there
  });

  it("follows a committed column drop even when journalling it then fails", async () => {
    if (!pool) return;
    await dropMigrationTables("stalecols_my");
    const backend = new MySqlBackend(pool);
    const models = { stalecols_my: { fields: [{ name: "name", type: "text" as const }, { name: "legacy", type: "text" as const }], indexes: [] } };
    await backend.registerModel("stalecols_my", [], models.stalecols_my.fields);
    backend.save("stalecols_my", { uuid: "s1", name: "a", legacy: "x" }, ctx);
    await backend.persist(ctx);

    const transaction = backend.transaction.bind(backend);
    backend.transaction = async () => {
      throw new Error("connection lost"); // the journal write after the DDL
    };
    await expect(
      runMigrations(backend, [{ name: "0001_drop", up: (m) => m.dropField("stalecols_my", "legacy") }], { models, applyContracts: true, skipLock: true })
    ).rejects.toThrow("connection lost");
    backend.transaction = transaction;

    backend.save("stalecols_my", { uuid: "s2", name: "b" }, ctx);
    await expect(backend.persist(ctx)).resolves.toBeDefined(); // not "Unknown column 'legacy'"
  });

  it("a unique-key clash whose value mentions the primary key is still refused", async () => {
    if (!pool) return;
    await pool.query("DROP TABLE IF EXISTS `uniq2_my`");
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const users = orm.define({ name: "uniq2_my", properties: { email: text({ unique: true }) } });
    const tricky = "x' for key 'PRIMARY";
    await users.save(users.createInstance({ email: tricky })).persist();
    users.save(users.createInstance({ email: tricky }));
    await expect(users.persist()).rejects.toThrow(/Duplicate entry/);
    expect(await users.all().count()).toBe(1);
  });

  it("a concurrent writer inserting the same new uuid first settles as last-write-wins, not an error", async () => {
    if (!pool) return;
    await pool.query("DROP TABLE IF EXISTS `race_my`");
    await new MySqlBackend(pool).registerModel("race_my", [], [{ name: "name", type: "text" }]);
    let raced = false;
    // Between this writer's existence check and its insert, another process inserts the same uuid.
    const racing = new MySqlBackend({
      query: (sql: string, params: unknown[]) => pool!.query(sql, params),
      getConnection: async () => {
        const conn = await pool!.getConnection();
        return {
          query: async (sql: string, params: unknown[]) => {
            const result = await conn.query(sql, params);
            if (!raced && sql.startsWith("SELECT `uuid`")) {
              raced = true;
              await pool!.query("INSERT INTO `race_my` (`uuid`, `name`) VALUES ('r1', 'other')");
            }
            return result;
          },
          beginTransaction: () => conn.beginTransaction(),
          commit: () => conn.commit(),
          rollback: () => conn.rollback(),
          release: () => conn.release()
        };
      }
    } as never);
    await racing.registerModel("race_my", [], [{ name: "name", type: "text" }]);
    racing.save("race_my", { uuid: "r1", name: "mine" }, ctx);
    await racing.persist(ctx);
    expect(raced).toBe(true);
    const [rows] = (await pool.query("SELECT `uuid`, `name` FROM `race_my`")) as unknown as [Array<{ uuid: string; name: string }>];
    expect(rows).toEqual([{ uuid: "r1", name: "mine" }]);
  });

  it("re-saving a uuid updates in place via ON DUPLICATE KEY UPDATE (no duplicate row)", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const items = orm.define({ name: "upsert_my", properties: { name: text() } });
    const r = items.createInstance({ name: "x" });
    items.save(r);
    await items.persist();
    r.name = "y";
    items.save(r); // same uuid
    await items.persist();
    expect(await items.all().count()).toBe(1);
    expect((await items.get(r.uuid))!.name).toBe("y");
  });

  // `INSERT … ON DUPLICATE KEY UPDATE` fires on *every* unique key, so persisting a new record whose
  // unique field collided with a different row used to overwrite that row. New uuids are now plainly
  // inserted and existing ones updated by uuid, so the collision is an error — as on Postgres.
  it("creates the UNIQUE index, and a secondary-key collision is refused — never another row rewritten", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const users = orm.define({ name: "uniq_my", properties: { email: text({ unique: true }), name: text() } });
    const alice = users.createInstance({ email: "a@x.io", name: "Alice" });
    await orm.transaction(async () => users.save(alice));

    // the index really exists and is UNIQUE (Non_unique = 0)
    const idx = (await pool.query("SHOW INDEX FROM `uniq_my` WHERE `Key_name` = 'uniq_my_email'"))[0] as { Non_unique: number }[];
    expect(idx[0]?.Non_unique).toBe(0);

    // a *different* record with the same email is refused, and Alice's row is untouched
    users.save(users.createInstance({ email: "a@x.io", name: "Mallory" }));
    await expect(users.persist()).rejects.toThrow();
    const fresh = new RepositoryManager({ backend: new MySqlBackend(pool) }).define({ name: "uniq_my", properties: { email: text(), name: text() } });
    expect(await fresh.all().count()).toBe(1);
    expect((await fresh.get(alice.uuid))!.name).toBe("Alice");
  });

  it("the pre-write unique check closes the MySQL secondary-unique divergence (opt-in)", async () => {
    if (!pool) return;
    // Default OFF: the database refuses the colliding insert (above). With the flag ON, it raises the
    // same friendly UniqueConstraintError as every other engine, before the write.
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool, undefined, { uniquePreCheck: true }) });
    const users = orm.define({ name: "prechk_my", properties: { email: text({ unique: true }) } });
    await orm.transaction(async () => users.save(users.createInstance({ email: "a@x.io" })));

    users.save(users.createInstance({ email: "a@x.io" })); // a *different* row, same email
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError); // no longer absorbed
    expect(await users.all().count()).toBe(1);
  });

  it("applies a migration (add + rename column) against a real schema", async () => {
    if (!pool) return;
    // The journal persists in the database, so a previous run's rows would make this one a no-op.
    await pool.query("DROP TABLE IF EXISTS `mig_my`, `_object_repository_migration_log`, `_object_repository_schema_state`");
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const migrations = [
      { name: "m1_create", up: (m: MigrationBuilder) => m.createTable("mig_my", [{ name: "n", type: "integer" }]) },
      { name: "m2_addcol", up: (m: MigrationBuilder) => m.addColumn("mig_my", "label", "text") },
      { name: "m3_rename", up: (m: MigrationBuilder) => m.renameColumn("mig_my", "label", "tag") }
    ];
    const report = await orm.migrate(migrations);
    expect(report.applied).toEqual(["m1_create", "m2_addcol", "m3_rename"]);
    // the renamed column exists and accepts data
    await orm.raw({ sql: "INSERT INTO `mig_my` (`uuid`, `n`, `tag`, `_extra`) VALUES (?, ?, ?, ?)", params: ["r1", 5, "hi", null] });
    expect(await orm.raw<{ tag: string }>({ sql: "SELECT `tag` FROM `mig_my`" })).toEqual([{ tag: "hi" }]);
    // re-running the same set is a no-op. (It must be the same bodies: an applied migration whose
    // body changed is refused as CHECKSUM_DRIFT, so an empty stand-in no longer works here.)
    expect((await orm.migrate(migrations)).applied).toEqual([]);
  });

  it("journals a migration name longer than the key column, which only a hashed id can fit", async () => {
    if (!pool) return;
    await pool.query("DROP TABLE IF EXISTS `mig_long_my`, `_object_repository_migration_log`, `_object_repository_schema_state`");
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const name = `0042_${"a_rather_descriptive_migration_name_".repeat(3)}`; // well past varchar(64)
    const migrations = [{ name, up: (m: MigrationBuilder) => m.createTable("mig_long_my", [{ name: "n", type: "integer" }]) }];
    expect((await orm.migrate(migrations)).applied).toEqual([name]);
    expect((await orm.migrate(migrations)).skipped).toEqual([name]);
  });

  it("round-trips scalar types faithfully (int / float / date / bool)", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const m = orm.define({ name: "types_my", properties: { i: integer(), f: float(), d: date(), b: boolean() } });
    const when = new Date("2021-03-04T05:06:07.000Z");
    const inst = m.createInstance({ i: 42, f: 3.14, d: when, b: true });
    m.save(inst);
    await m.persist();

    const back = (await m.get(inst.uuid))!;
    expect(back.i).toBe(42);
    expect(back.f).toBeCloseTo(3.14, 5);
    expect((back.d as Date).getTime()).toBe(when.getTime());
    expect(back.b).toBe(true); // MySQL tinyint(1) → decoded back to boolean
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cross-engine PARITY vs the in-memory reference — the divergences that only show up on a real
// Postgres/MySQL (integer division, mod on floats, case-folding collation, NULL ordering, long
// text). Each scenario asserts the engine agrees with `InMemoryBackend` (the documented reference).
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function parity(makeBackend: () => Backend) {
  const orm = new RepositoryManager({ backend: makeBackend() });

  // 1) float division + JS-remainder mod, incl. a zero divisor (guarded to 0)
  const arith = orm.define({ name: "par_arith", properties: { a: float(), b: float(), q: float(), r: float() } });
  for (const [a, b] of [[9, 2], [4.5, 2], [5, 0]] as const) {
    const inst = arith.createInstance({ a, b });
    arith.save(inst);
    await arith.persist();
    await arith.patch(inst.uuid, { q: div(field("a"), field("b")), r: mod(field("a"), field("b")) });
  }
  const arithRows = (await arith.all().sort("a").list()).map((x) => ({ q: x.q, r: x.r }));

  // 2) case-sensitive equality (MySQL's default collation folds case)
  const names = orm.define({ name: "par_case", properties: { name: text() } });
  for (const n of ["Foo", "foo", "BAR"]) names.save(names.createInstance({ name: n }));
  await names.persist();
  const caseCount = await names.all().filter(eq("name", "foo")).count();

  // 3) NULL ordering — reference sorts nulls first on ASC (Postgres defaults to last)
  const scores = orm.define({ name: "par_null", properties: { name: text(), score: integer() } });
  for (const row of [{ name: "a", score: 2 }, { name: "b" }, { name: "c", score: 1 }]) {
    scores.save(scores.createInstance(row));
  }
  await scores.persist();
  const nullOrder = (await scores.all().sort("score").list()).map((x) => x.name);

  return { arithRows, caseCount, nullOrder };
}

const PARITY_TABLES = ["par_arith", "par_case", "par_null"];

describe("cross-engine parity vs the in-memory reference", () => {
  let pg_: pg.Pool | undefined;
  let my_: MySqlPool | undefined;
  let reference: Awaited<ReturnType<typeof parity>>;

  beforeAll(async () => {
    reference = await parity(() => new InMemoryBackend());
    try {
      pg_ = new pg.Pool({ connectionString: PG_URL });
      for (const t of PARITY_TABLES) await pg_.query(`DROP TABLE IF EXISTS "${t}"`);
    } catch (error) {
      requireLiveDb(error);
      pg_ = undefined;
    }
    try {
      my_ = createPool({ uri: MYSQL_URL });
      for (const t of PARITY_TABLES) await my_.query(`DROP TABLE IF EXISTS \`${t}\``);
    } catch (error) {
      requireLiveDb(error);
      my_ = undefined;
    }
  });
  afterAll(async () => {
    await pg_?.end().catch(() => {});
    await my_?.end().catch(() => {});
  });

  it("the reference itself has the expected shape (sanity)", () => {
    expect(reference.arithRows).toEqual([
      { q: 2.25, r: 0.5 }, // a=4.5,b=2
      { q: 0, r: 0 }, //     a=5,  b=0 (guarded)
      { q: 4.5, r: 1 } //    a=9,  b=2
    ]);
    expect(reference.caseCount).toBe(1); // only "foo", not "Foo"
    expect(reference.nullOrder).toEqual(["b", "c", "a"]); // null (b) first, then 1, then 2
  });

  it("Postgres agrees with the reference on every divergence", async () => {
    if (!pg_) return;
    expect(await parity(() => new PostgresBackend(pg_!))).toEqual(reference);
  });

  it("MySQL agrees with the reference on every divergence", async () => {
    if (!my_) return;
    expect(await parity(() => new MySqlBackend(my_!))).toEqual(reference);
  });
});
