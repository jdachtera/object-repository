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
import pg from "pg";
import { createPool, type Pool as MySqlPool } from "mysql2/promise";
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
    } catch {
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
});

describe("MySQL (real engine)", () => {
  let pool: MySqlPool | undefined;
  beforeAll(async () => {
    try {
      pool = createPool(MYSQL_URL);
      for (const t of ["int_person_my", "nested_m", "uniq_my", "upsert_my", "mig_my", "types_my", "_object_repository_migrations", "emb_my", "win_my", "cd_my", "dirty_my", "null_my", "longtext_my", "idxtext_my", "prechk_my"]) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    } catch {
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

    const updates = seen.filter((s) => s.includes("ON DUPLICATE KEY UPDATE"));
    const ageOnly = updates.filter((s) => s.includes("ON DUPLICATE KEY UPDATE `age` = VALUES(`age`)") && !s.includes("`name` = VALUES"));
    const cityOnly = updates.filter((s) => s.includes("ON DUPLICATE KEY UPDATE `city` = VALUES(`city`)") && !s.includes("`age` = VALUES"));
    expect(ageOnly).toHaveLength(1); // ann + bob batched into one multi-row statement
    expect(ageOnly[0]).toContain("), ("); // two value tuples in that one statement, one round trip
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

  // A declared unique index IS created on MySQL, but persist()'s upsert semantics diverge from Postgres:
  // MySQL's `INSERT … ON DUPLICATE KEY UPDATE` matches on *every* unique key (it can't be scoped to the
  // uuid primary key the way Postgres's `ON CONFLICT (uuid)` is), so a colliding secondary-unique value
  // is absorbed as a no-op UPDATE of the existing row rather than raised as an error. The upshot: on
  // MySQL a save whose unique field collides with a different row is silently dropped (the existing row
  // wins, count stays 1, no throw) — whereas the same save rejects on Postgres. This is a documented
  // engine divergence (see README "Cross-engine caveats"); the test pins the real behavior so a future
  // change to the write strategy is a deliberate, visible edit.
  it("creates the UNIQUE index; a secondary-key collision is absorbed by upsert (MySQL divergence)", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const users = orm.define({ name: "uniq_my", properties: { email: text({ unique: true }) } });
    await orm.transaction(async () => users.save(users.createInstance({ email: "a@x.io" })));

    // the index really exists and is UNIQUE (Non_unique = 0)
    const idx = (await pool.query("SHOW INDEX FROM `uniq_my` WHERE `Key_name` = 'uniq_my_email'"))[0] as { Non_unique: number }[];
    expect(idx[0]?.Non_unique).toBe(0);

    // a *different* record with the same email does not throw and is not inserted — the existing row wins
    users.save(users.createInstance({ email: "a@x.io" }));
    await expect(users.persist()).resolves.toBeDefined();
    expect(await users.all().count()).toBe(1);
  });

  it("the pre-write unique check closes the MySQL secondary-unique divergence (opt-in)", async () => {
    if (!pool) return;
    // Default OFF: a colliding secondary-unique value is silently absorbed (pinned above). With the
    // flag ON, it raises the same UniqueConstraintError as every other engine, before the write.
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool, undefined, { uniquePreCheck: true }) });
    const users = orm.define({ name: "prechk_my", properties: { email: text({ unique: true }) } });
    await orm.transaction(async () => users.save(users.createInstance({ email: "a@x.io" })));

    users.save(users.createInstance({ email: "a@x.io" })); // a *different* row, same email
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError); // no longer absorbed
    expect(await users.all().count()).toBe(1);
  });

  it("applies a migration (add + rename column) against a real schema", async () => {
    if (!pool) return;
    const orm = new RepositoryManager({ backend: new MySqlBackend(pool) });
    const report = await orm.migrate([
      { name: "m1_create", up: (m) => m.createTable("mig_my", [{ name: "n", type: "integer" }]) },
      { name: "m2_addcol", up: (m) => m.addColumn("mig_my", "label", "text") },
      { name: "m3_rename", up: (m) => m.renameColumn("mig_my", "label", "tag") }
    ]);
    expect(report.applied).toEqual(["m1_create", "m2_addcol", "m3_rename"]);
    // the renamed column exists and accepts data
    await orm.raw({ sql: "INSERT INTO `mig_my` (`uuid`, `n`, `tag`, `_extra`) VALUES (?, ?, ?, ?)", params: ["r1", 5, "hi", null] });
    expect(await orm.raw<{ tag: string }>({ sql: "SELECT `tag` FROM `mig_my`" })).toEqual([{ tag: "hi" }]);
    // re-running is a no-op
    expect((await orm.migrate([{ name: "m1_create", up: () => {} }])).applied).toEqual([]);
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
    } catch {
      pg_ = undefined;
    }
    try {
      my_ = createPool({ uri: MYSQL_URL });
      for (const t of PARITY_TABLES) await my_.query(`DROP TABLE IF EXISTS \`${t}\``);
    } catch {
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
