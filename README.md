# object-repository

A composable, isomorphic TypeScript ORM. One typed query language that runs everywhere — in
memory, in the browser (IndexedDB), across a network, and offline-with-sync — because **every
layer is a `Backend`**: stores, access control, network transport, and sync are all the same
contract, composed.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design and rationale.

```bash
pnpm install
pnpm test          # vitest
pnpm test:coverage # vitest --coverage (v8; ratcheted thresholds)
pnpm typecheck     # tsc --noEmit
pnpm build         # tsup -> dist/ (ESM + d.ts)
pnpm demo          # build + run examples/multi-backend.ts
pnpm demo:chat     # realtime chat: 3 clients + 1 server over WebSocket
pnpm demo:stats    # high-volume stats: aggregate push-down over HTTP
pnpm demo:web      # interactive web demos hub on http://localhost:8080
```

See [`examples/`](./examples) for runnable demos:

- **`multi-backend`** — one model + one block of query/write code against in-memory, SQLite, and
  IndexedDB (and live Mongo if `MONGO_URL` is set), checked byte-for-byte identical.
- **`realtime-chat`** — the same model in three "browser" clients talking to one server over a
  `WebSocketTransport`; messages fan out live via the server's change feed.
- **`stats-aggregation`** — `groupBy` over a `RemoteBackend` pushes down to a server-side `GROUP BY`,
  so only the summary rows cross the wire (≈14,000× less data than fetching the table).
- **`web`** — an interactive three-demo hub (no bundler; the page imports the built ORM):
  **offline sync** (per-device IndexedDB + `SyncBackend`, edit offline, converge across devices,
  last-write-wins conflicts), **live stats** (browser `RemoteBackend` pushing `groupBy` down to a
  server SQLite table), and **realtime chat** (browser clients over a `WebSocketTransport`, fanned
  out by the change feed).

## Quick start

```ts
import { RepositoryManager, text, integer, eq, gt } from "object-repository";

const orm = new RepositoryManager();            // defaults to an in-memory backend

const users = orm.define({
  name: "User",
  properties: { name: text(), age: integer() }
});

const peter = users.createInstance({ name: "Peter", age: 35 }); // peter.age: number (inferred)
users.save(peter);
await users.persist();

// insert-or-update by a key (setOnInsert applies only on insert):
await users.upsert(eq("name", "Peter"), { set: { age: 36 }, setOnInsert: { name: "Peter" } });

// atomic writes: everything the callback queues commits together (a real DB transaction on
// SQLite / Postgres / MySQL), or rolls back and re-throws — nothing is persisted:
await orm.transaction(async () => {
  users.save(users.createInstance({ name: "Ada", age: 36 }));
  users.save(users.createInstance({ name: "Grace", age: 45 }));
});

// interactive: the `tx` scope's repositories read/write on the transaction's own connection, so a
// write you persist mid-callback is visible to the next read — before commit:
await orm.transaction(async (tx) => {
  const accounts = tx.repository<typeof users>("User");
  const ada = (await accounts.all().filter(eq("name", "Ada")).list())[0]!;
  accounts.save({ ...ada, age: ada.age + 1 });
  await accounts.persist(); // now visible to the next read in this tx; atomic on commit
});

const adults = await users.all().filter(gt("age", 18)).sort("age").list();
const peters = await users.all().filter(eq("name", "Peter")).list(); // peters[0] === peter

// versioned migrations for non-additive schema changes (rename/drop/retype + data backfills);
// each runs once, tracked in _orm_migrations, and rollback() reverts via down():
await orm.migrate([
  { name: "0001_add_status", up: (m) => m.addColumn("User", "status", "text") },
  { name: "0002_backfill", up: (m) => m.sql(`UPDATE "User" SET "status" = 'active'`) },
  { name: "0003_rename", up: (m) => m.renameColumn("User", "status", "state"), down: (m) => m.renameColumn("User", "state", "status") }
]);
```

The instance type is **inferred from the property map** (the `z.infer` of this ORM), so
`createInstance`, query predicates, and results are all type-checked end to end — no codegen. Pull
the inferred type out with `Model<>` when you need to name it:

```ts
import { Model } from "object-repository";
const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });
type User = Model<typeof users>;   // { uuid: string; name: string; age: number }
```

(Scalar fields infer automatically; **relations** still take a target-type annotation —
`relationToMany<EventModel>(…)` — because a mutually-recursive `User ⇄ Event` type can't infer
itself mid-definition. That's the one place you write the shape by hand.)

## Models & properties

Scalars carry a [Standard Schema](https://standardschema.dev) validator (a zero-dependency
built-in by default, or bring Zod / ArkType / Valibot) and a codec for serialization. When the
validator's output is a *subtype* of the base — an enum, a literal union — it also **narrows the
field's type**: `text({ schema: z.enum(["song", "exercise"]) })` is typed `"song" | "exercise"`, not
`string`, so the model matches a zod-typed collection exactly:

```ts
import { text, integer, float, boolean, date, json, array, embedded } from "object-repository";
import { z } from "zod";

orm.define({
  name: "Account",
  timestamps: true,                    // auto createdAt (first save) + updatedAt (every save/patch); typed as Date
  properties: {
    handle:  text({ unique: true, schema: z.string().min(3) }),
    tier:    text({ schema: z.enum(["free", "pro"]) }), // model type is "free" | "pro", validated on write
    age:     integer({ index: true }),
    balance: float({ default: 0 }),      // fills an absent field (a `() => …` factory works too)
    role:    text({ required: true, default: "member" }), // required at save; the default satisfies it
    active:  boolean(),
    createdAt: date(),                 // model holds a Date; stored as an epoch int
    tags:    array<string>(),          // native JSON array (push/addToSet/pull patch ops)
    prefs:   json<{ theme: string }>(),// opaque blob — model holds an object, stored as a JSON string
    // nested subdoc, queryable by dotted path. Either name the type…
    billing: embedded<{ customerId: string; plan: { tier: string } }>(),
    // …or pass a zod (Standard Schema) validator — the model type is *inferred* from it AND it
    // validates every write. A discriminated union survives intact, matching a zod-typed collection.
    // `json(schema)` takes the same form (opaque blob); `embedded(schema)` stays dotted-path queryable:
    subscription: embedded(
      z.discriminatedUnion("provider", [
        z.object({ provider: z.literal("stripe"), customerId: z.string() }),
        z.object({ provider: z.literal("apple"), orderId: z.string() })
      ])
    )
  },
  // model-level indexes: compound, unique, TTL, text, partial (built per backend's capabilities)
  indexes: [
    { fields: ["handle", { path: "createdAt", descending: true }], unique: true },
    { name: "ttl", fields: ["createdAt"], ttlSeconds: 60 * 60 * 24 * 30 } // Mongo TTL
  ]
});
```

## Querying

```ts
users.all()
  .filter(gt("age", 30))   // eq/neq/gt/lt/gte/lte/and/or/not/inList/contains/between
  .sort("age", true)
  .slice(0, 10)
  .list();

// keyset (cursor) pagination — seeks past the last row instead of OFFSET, so it pushes down
// and never skips rows; the cursor is opaque and bound to the sort:
let p = await users.all().sort("age").page({ limit: 20 });
while (p.hasMore) p = await users.all().sort("age").page({ limit: 20, after: p.nextCursor });

// advanced pipeline (typed; runs in memory, pushed down where the backend supports it)
await users.patch(id, { total: mul(field("price"), field("qty")) }); // computed write, server-side (a bare value expression is a `setExpr`; `op.set(…)` is the explicit form)
await users.all().count();
await users.all().filter(gt("age", 30)).select({ name: true, age: true });   // typed projection → { name: string; age: number }[]
await users.all().aggregate((a) => ({ adults: a.sum(cond(cmp(field("age"), ">=", 18), 1, 0)) })); // cond/switch
await users.all().distinct("city");
await users.all().aggregate((a) => ({ total: a.count(), avgAge: a.avg("age") }));
await users.all().groupBy("city", (a) => ({ headcount: a.count(), distinctNames: a.countDistinct("name") })); // COUNT(DISTINCT)
await users.all().groupByExpr(year(field("createdAt")), (a) => ({ signups: a.count() })); // time buckets
await users.all().groupByExpr(dateToString(field("createdAt"), "%Y-%m-%d", "Europe/Berlin"), (a) => ({ n: a.count() })); // tz-aware
await payments.all().sort("createdAt").windowed({ partitionBy: "userId" }, (w) => ({ paymentNo: w.rowNumber(), rank: w.rank() })); // OVER(...)

// escape hatch for what the compiler can't express — runs through the ORM's own connection/pool,
// not the bare driver. SQL backends take { sql, params }; Mongo takes { collection, pipeline }.
const pairs = await orm.raw<{ a: string; b: string }>({
  sql: `SELECT a.name a, b.name b FROM "User" a JOIN "User" b ON a.age = b.age AND a.name < b.name`
});
```

### Typed filters (`where`) — the zod-collection-grade surface

`filter(eq("age", 30))` is composable but stringly-typed: a field typo or a wrong-typed value only
surfaces at runtime. `where({ … })` is the type-safe alternative — a mapped type over the model that
checks **field names and value types at compile time**, including nested dotted paths, exactly like a
zod-typed Mongo collection. It desugars to the same expression AST, so it runs identically everywhere.

```ts
users.all().where({ age: { $gte: 30 }, "sub.tier": "gold" }).sort("age");
users.all().where({ $or: [{ name: "bo" }, { age: { $gt: 35 } }] });

users.all().where({ naem: "x" });                 // ✗ compile error — unknown field
users.all().where({ age: "old" });                // ✗ compile error — age is a number
users.all().where({ "sub.details.seats": "many" }); // ✗ compile error — wrong type at a dotted path
await users.patch(id, { age: "old" });            // ✗ compile error — typed patch spec too
```

### Reactive queries (`liveQuery`)

Any query can be made **live** — it re-runs and pushes fresh results after every committed change to its
model (a local write, or one over the change feed: cascades, remote/sync writes). The core ships one
framework-agnostic primitive; the React/Solid/Vue/Svelte hooks are ~5-line adapters kept **out of the
package**, so `object-repository` never depends on a UI framework.

```ts
import { liveQuery } from "object-repository";

const live = liveQuery(users.all().where({ active: true }).sort("name"));
const stop = live.subscribe(() => render(live.getSnapshot())); // { data, error, loading }, stable ref

// imperative sugar:
const stop2 = users.all().subscribe((rows) => render(rows));
```

`getSnapshot`/`subscribe` are shaped for React's `useSyncExternalStore` and Solid's `from`; the runner
is pluggable (`liveQuery(coll, c => c.count())`). Invalidation is **predicate-scoped** — a query re-runs
only when the changed record matches its filter before or after the write, so a write to a row outside
the filter never wakes it. See [`docs/reactive.md`](./docs/reactive.md) for the copy-paste `useQuery` /
`createQuery` hooks.

## Relations

```ts
import { relationToMany } from "object-repository";

interface UserModel { uuid: string; name: string; events: EventModel[]; }
interface EventModel { uuid: string; title: string; users: UserModel[]; }

const usersRepo = orm.define({ name: "User", properties: {
  name: text(),
  events: relationToMany<EventModel>({ model: "Event", remoteProperty: "users" })
}});
const eventsRepo = orm.define({ name: "Event", properties: {
  title: text(),
  users: relationToMany<UserModel>({ model: "User", remoteProperty: "events" })
}});

const peter = usersRepo.createInstance({ name: "Peter", events: [birthday, interview] });
usersRepo.save(peter);     // also keeps event.users in sync and cascades the save
await usersRepo.persist();
```

Relations resolve targets by model name (no definition-order problem), eager-load through a
shared identity map (cycle-safe), and maintain the inverse side on save. Loading is **batched** —
a relation across N rows is fetched with one `WHERE uuid IN (…)` query per level, not N (no N+1).

## Backends, decorators, transports — all the same contract

Every store and layer ships from its own subpath, so a bundle only ever pulls the backend it imports
(`object-repository` core carries no server-driver code at all):

```ts
import { InMemoryBackend } from "object-repository";                     // core: the in-memory reference store
import { IndexedDBBackend } from "object-repository/indexeddb";          // browser store
import { SQLiteBackend, D1Backend } from "object-repository/sqlite";     // node:sqlite on the server, D1 on the edge
import { PostgresBackend } from "object-repository/postgres";            // inject a pg client
import { MySqlBackend } from "object-repository/mysql";                  // inject a mysql2 client
import { MongoBackend } from "object-repository/mongo";                  // document store
import { PolicyBackend, observe } from "object-repository/decorators";   // authorization + observability wrappers
import { SyncBackend, InMemorySyncTarget } from "object-repository/sync"; // offline-first replication
import {
  RemoteBackend, BackendAdapter,                          // transport client/server
  InProcessTransport, HttpTransport, WebSocketTransport
} from "object-repository/transport";

// Trace every operation without losing push-down (the wrapper mirrors the inner's capabilities):
new RepositoryManager({
  backend: observe(new PostgresBackend(pool), {
    slowThresholdMs: 50,
    onSlowQuery: (op) => console.warn(`slow ${op.operation} on ${op.model}: ${op.durationMs}ms`)
  })
});

// Browser store with native index push-down:
new RepositoryManager({ backend: new IndexedDBBackend() });

// Server SQL store — filters/sort/paging/COUNT compile to SQL (node:sqlite injected):
new RepositoryManager({ backend: new SQLiteBackend(new DatabaseSync("app.db")) });

// MongoDB — the AST compiles to a Mongo query filter (driver Db injected):
new RepositoryManager({ backend: new MongoBackend(mongoDb) });

// Postgres / MySQL — inject any pg / mysql2 client. Each model is a real, typed table (one column
// per scalar field + a JSON overflow column), so filters/sort/COUNT/aggregate compile to plain
// column SQL and indexes are real column indexes; anything the compiler can't express falls back to
// the in-memory reference. Great fit for serverless SQL (Neon, PlanetScale, Turso-style clients):
new RepositoryManager({ backend: new PostgresBackend(new Pool({ connectionString })) });
new RepositoryManager({ backend: new MySqlBackend(createPool(uri)) });

// opt into connection resilience — per-call timeout + safe retry/backoff (reads & whole transactions
// retry transient failures; writes only time out, so a retry can't double-apply):
new RepositoryManager({ backend: new PostgresBackend(pool, { timeoutMs: 5000, retries: 3 }) });

// Adopt an existing ObjectId-keyed collection (_id + FK fields ⇄ hex strings):
new RepositoryManager({
  backend: new MongoBackend(mongoDb, objectIdIdentity(ObjectId, { Fav: ["userId"] })),
  generateId: () => new ObjectId().toString()
});

// Row-level security by wrapping any backend:
const secured = new PolicyBackend(new InMemoryBackend(), {
  read:  (model, ctx) => eq("owner", ctx.identity!.id),
  write: (model, record, ctx) => record.owner === ctx.identity?.id
});

// Client/server — the same ORM, just a different backend:
const remote = new RemoteBackend(new HttpTransport("http://localhost:3000"), capabilities);
new RepositoryManager({ backend: remote });

// Offline-first sync between replicas:
const device = new SyncBackend({ local: new IndexedDBBackend(), remote: syncTarget });
// ...write offline, then:
await device.reconcile(ctx);
```

The query language and model code are identical across all of these — embedded, client/server,
and offline-sync are backend swaps, not rewrites.

### Migrating between stores

Because every store is the same `Backend` contract and records cross it as plain JSON, moving data
from one store to another is a library primitive, not a bespoke script. Two pieces compose into a
zero-downtime cutover:

```ts
import { copyBackend, multiWriteBackend } from "object-repository/decorators";

// 1. Backfill history from the old store into the new one, in batches (any pair — in-memory → Postgres,
//    SQLite → Mongo, …). The target must already have its models provisioned (define them on a manager).
const report = await copyBackend(oldStore, newStore, {
  models: ["User", "Post"],
  batchSize: 1000,
  onBatch: (p) => console.log(`${p.model}: ${p.copied}`),
  // optional: filter a subset, or transform/skip each record
  where: (model) => (model === "Post" ? gt("createdAt", cutoff).serialize() : undefined),
  transform: (record) => (record.deleted ? null : record)
});

// 2. Point the app at a dual-write backend so live traffic keeps the new store in lock-step. Reads and
//    the change feed still come from the primary; every write also lands in the secondary.
const orm = new RepositoryManager({ backend: multiWriteBackend({ primary: oldStore, secondaries: [newStore] }) });

// 3. Once the secondary is verified consistent, flip the primary (swap the two) and drop the old store.
```

`copyBackend` reads through `source.query`, so ordering + paging hold even on scan-only stores.
`multiWriteBackend` fans a server-side `patch`/`patchMany`/`upsert` to every store only when *all* of
them support it (otherwise the write falls back to save/remove, which always fan). It is not a
two-phase commit: `persist` flushes the primary first (the source of truth), then the secondaries;
the default `"strict"` policy rejects on a secondary failure (the primary has already committed, so a
lagging secondary is reconciled by re-running `copyBackend`), or pass `onSecondaryError` to
log-and-tolerate. Cross-store interactive transactions aren't offered, so the manager falls back to
write-batching — which still fans out.

### Cross-engine caveats

The library targets exact parity across backends, but a few things are genuinely engine-specific and
are pinned by live-engine tests (`src/backends/sqlIntegration.test.ts`) so any change is deliberate:

- **Secondary `unique` indexes under `persist()` diverge between Postgres and MySQL.** The declared
  index is created on both. But `persist()` upserts by `uuid`, and the two engines scope that upsert
  differently: Postgres uses `ON CONFLICT (uuid) DO UPDATE`, so a *different* row colliding on a
  secondary unique field is **not** caught by the conflict target and the write **rejects** (you see
  the violation). MySQL's `INSERT … ON DUPLICATE KEY UPDATE` can't be scoped to one key — it matches
  on *every* unique key, so the same collision is absorbed as a no-op UPDATE of the existing row: no
  error, the new record is silently dropped, and the row count is unchanged. If you rely on secondary
  unique constraints to surface conflicting writes, do it on Postgres, or validate uniqueness in a
  command/middleware before `persist()`.

## Commands (task-based RPC)

The backend contract is the **data plane** (typed queries + entity writes + sync). For the
**command plane** — server-side operations that aren't CRUD (`checkout`, `sendInvite`) with their own
input/output types and side effects — define commands and dispatch them over the *same* transport. No
codegen: the client imports only the command map's *type*.

```ts
// server.ts — handlers run server-side (close over your repositories/services)
export const commands = {
  checkout: command({
    input: z.object({ cartId: z.string() }),          // validated on the server
    use: [requireRole("customer")],                   // middleware guards (authz, rate limit, ctx augmentation)
    handler: async ({ cartId }, ctx) => {
      const receipt = await orders.createInstance(/* … */);
      orders.save(receipt); await orders.persist();    // a normal write…
      return receipt.uuid;
    }
  })
};
new BackendAdapter(backend, fingerprint, commands);    // register on the server adapter

// client.ts — fully typed from `typeof commands`, no codegen
import type { commands } from "./server";
const rpc = orm.commands<typeof commands>(transport);
const receiptId = await rpc.checkout({ cartId });      // typed input + result
```

It **integrates with the data system**: the change events a command's writes produce come back with
its reply and are fed through this manager's backend, so the mutation invalidates the same query
caches and drives the same reactive reloads as a local write — even over request/response HTTP with no
live subscription.

## Mongo query compatibility (migration on-ramp)

An opt-in facade parses MongoDB's query syntax into the portable AST, so a Mongo-flavoured app can run
its queries **unchanged on any backend** — including SQL. It's the literal inverse of the Mongo
*compiler*, so results are identical across stores.

```ts
import { mongoCollection } from "object-repository/compat/mongo";  // subpath — not pulled into the core bundle

const people = mongoCollection(repo);                // repo can be on Postgres, SQLite, in-memory, …
await people.find({ age: { $gte: 30 }, $or: [{ city: "eu" }, { vip: true }] })
            .sort({ age: -1 }).limit(20).toArray();  // ← a Mongo query, running on SQL
await people.countDocuments({ role: { $in: ["admin", "owner"] } });
await people.aggregate([{ $match: { active: true } }, { $group: { _id: "$city", n: { $sum: 1 } } }]);

// writes too — insert / update / delete / findOneAndUpdate, with $-operators mapped to atomic patches:
await people.findOneAndUpdate({ _id }, { $inc: { plays: 1 }, $set: { seenAt: now } });  // returns the doc
await people.updateMany({ active: false }, { $set: { archived: true } });               // native UPDATE … WHERE
await people.updateOne({ email }, { $setOnInsert: { email }, $set: { name } }, { upsert: true });
```

It maps the common, portable subset and **throws loudly** on anything it can't express exactly
(`$where`, arbitrary regexes, unsupported stages) rather than silently diverging.

## Packaging & tree-shaking

Pure ESM, `"sideEffects": false`, and **one subpath export per backend** — so a bundle physically
cannot pull a store it didn't import. The `object-repository` core entry (`RepositoryManager`, the expression and
property layers, the query builder, and the in-memory reference backend) reaches **no** server-driver
code at all; each store lives behind its own subpath:

| Import from        | Gets you                                              |
| ------------------ | ----------------------------------------------------- |
| `object-repository`              | core + `InMemoryBackend` (isomorphic; zero driver code) |
| `object-repository/indexeddb`    | `IndexedDBBackend`                                    |
| `object-repository/sqlite`       | `SQLiteBackend`, `D1Backend` (Cloudflare D1)          |
| `object-repository/sql`          | `SqlBackend` + dialects, migrations, resilience toolkit |
| `object-repository/postgres`     | `PostgresBackend` (inject a `pg` client)              |
| `object-repository/mysql`        | `MySqlBackend` (inject a `mysql2` client)             |
| `object-repository/mongo`        | `MongoBackend`                                        |
| `object-repository/decorators`   | `PolicyBackend`, `observe`, `multiWriteBackend`, `copyBackend`, … |
| `object-repository/sync`         | `SyncBackend`, `InMemorySyncTarget`                   |
| `object-repository/transport`    | `RemoteBackend`, HTTP/WS/in-process transports        |
| `object-repository/compat/mongo` | the Mongo query-language facade (`mongoCollection`)   |

`object-repository/postgres` never drags in the MySQL preset (or vice versa), `object-repository/mongo` never pulls the SQL
compiler, and `object-repository` core never pulls any of them — verified by bundling each entry in isolation. No
driver is bundled either (you inject `pg` / `mysql2` / `mongodb` / `node:sqlite`), so nothing forces
those deps on consumers. The published output is pure ESM with explicit file extensions, so it runs
unchanged on Node, Bun, and Deno.

## API reference

The full public surface — every exported factory, builder, class, backend, transport, and type — is
documented inline with JSDoc. Generate a browsable Markdown reference from it with:

```sh
pnpm docs:api      # TypeDoc → docs/api/ (git-ignored; regenerate on demand)
```

The generated tree has one page per public entry point (`index`, each backend subpath, `sync`,
`transport`, and `compat/mongo`). TypeDoc is configured
with `validation.notDocumented`, so the run also reports any exported member that lacks a doc comment
— a coverage signal you can drive toward zero. (Every exported *function/factory* is documented today;
the remaining gaps are mostly trivial result/option interface fields.)

## Status

A TypeScript port and expansion of an old WIP JS ORM. Implemented: typed models + Standard
Schema validation, relations, an expression AST that evaluates in memory and compiles to native
queries, six backends (in-memory, IndexedDB with index push-down, SQLite with full SQL push-down,
Postgres and MySQL over a shared dialect layer, MongoDB), policy (authz) and sync (offline-first,
HLC + tombstones + durable outbox)
decorators, in-process / HTTP+SSE / WebSocket transports, and an advanced query pipeline
(select/count/distinct/aggregate/groupBy) with count and aggregate/groupBy push-down (SQL
`GROUP BY` / Mongo `$group`, in-memory reference fallback) — including **across the transport**, so
a remote `groupBy` reduces on the server and only the summary rows cross the wire.

Filters on **dotted paths into embedded objects** (in the `_extra` overflow) also push down, to
type-exact JSON extraction (`jsonb #>` / `JSON_EXTRACT`) — verified against real Postgres 16 and
MySQL 8 (`sqlIntegration.test.ts`, gated on `PG_URL`/`MYSQL_URL`) so it never diverges from the
in-memory reference. So do to-one relation-reference filters and the `isNull`/`isNotNull` predicate
(→ `IS [NOT] NULL`).

Also implemented, mostly as opt-ins that keep the default behaviour unchanged: **dirty / field-level
change tracking** (`save()` writes only the changed columns/fields), **soft deletes**
(`define({ softDelete: true })` — a `deletedAt` marker + a live filter that pushes down to
`IS NULL`, with `includeDeleted()` / `restore()` / a hard-delete hatch), **computed / virtual
fields** (`computed()`), **seeding factories** (`defineFactory` + `sequence`), an opt-in **pre-write
unique check** (`{ uniquePreCheck: true }` → a friendly `UniqueConstraintError` on SQL/Mongo), MySQL
`TEXT` columns with index-prefix lengths (no more `varchar(255)` truncation), and opt-in
**field-level sync** (`SyncBackend({ fieldLevel: true })` — concurrent edits to different fields of a
record merge instead of clobbering).

Every server backend takes an injected client (a `node:sqlite` `DatabaseSync`, a `mongodb` `Db`, or a
`pg` / `mysql2` client), so the library carries no driver dependency. The Postgres and MySQL backends
share a `SqlDialect` compiler and map each model to a **real columnar table** (typed column per
field + a JSON overflow column), pushing the common filter/sort/aggregate ops down to SQL and falling
back to the in-memory reference for anything a dialect doesn't yet emit.

The SQLite backend's driver seam is **async-tolerant** (`T | Promise<T>`), so the *same* compiling
backend runs over a synchronous embedded driver (`node:sqlite`, `better-sqlite3`) on the server and
over an asynchronous, batch-only one on the edge — `new D1Backend(env.DB)` is a thin preset for
**Cloudflare D1** (async binding style + `db.batch` for atomic writes), the same way `PostgresBackend`
/ `MySqlBackend` are presets over `SqlBackend`. See `ARCHITECTURE.md` for the design, and
[`docs/PRODUCTION_ROADMAP.md`](./docs/PRODUCTION_ROADMAP.md) for what's next.
