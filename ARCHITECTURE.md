# Architecture

`object-repository` is a composable, isomorphic persistence + sync library. This document is the design
reference: the decisions behind the shape of the code, not a tutorial. Current limitations and
planned work are tracked separately in [docs/PRODUCTION_ROADMAP.md](docs/PRODUCTION_ROADMAP.md).

---

## 1. Vision

One library that can:

- **Query the same way everywhere** — browser stores (IndexedDB, WebSQL, localStorage,
  cookies, in-memory) and server stores (SQL, Mongo) behind one API.
- **Compose layers** — caching, access control, network transport, and offline sync are
  all just *backends* that wrap other backends.
- **Run isomorphically** — the exact same code runs embedded (no server), or split across
  a client/server boundary, by swapping a transport.
- **Be type-safe end to end** — a model definition infers the instance type, which flows
  into query predicates and results.

Two sub-systems, with very different difficulty curves:

- **(A) the query/persistence layer** — the core of the library: models, expressions, backends.
- **(B) the sync engine** — designed as *one more composable backend* (§9), not a separate
  subsystem, so it doesn't expand the core.

---

## 2. Core principle: the `Backend` interface is the spine (and the protocol)

Every layer implements the **same** `Backend` contract. The Repository only ever talks to
"a backend" and never knows how deep the stack goes. Because the contract is serializable,
**the backend interface doubles as the network protocol** — HTTP/WebSocket are just
*transports* that carry backend operations across a process boundary.

```
SERVER   HttpAdapter / WsAdapter      ← transport: deserialize ops, authenticate
           └─ PolicyBackend           ← authz: rewrite/reject queries by context
                └─ MongoBackend        ← the real store

CLIENT   SyncBackend                   ← offline-first composite
           ├─ IndexedDBBackend         ← local durable reads/writes
           └─ HttpClientBackend         ← same Backend interface; every op is an RPC
                └─ (HTTP for req/resp, WS for the change feed)
```

Each box satisfies `Backend`. `HttpClientBackend.query(plan)` serializes the plan, ships it,
and the server adapter deserializes and runs it against whatever it wraps. Neither end cares
how the other is composed.

### Core contract

`query` / `save` / `remove` / `persist` / `pull` / `push` / `changes`, every method taking a
`Context`, plus a `capabilities` descriptor. See `src/core/Backend.ts`.

---

## 3. Query planning: compile the AST, don't scan

- **The Expression AST stays backend-agnostic.** Each backend *compiles* it to its native
  query language instead of evaluating it.
- `match()` is the **reference/fallback evaluator** — used by backends that cannot push a
  predicate down (localStorage, cookies, in-memory), and as the ground truth every backend's
  compiled behavior is checked against.

```
Compare("age",">",30)
  SQL       → "age > $1", [30]
  Mongo     → { age: { $gt: 30 } }
  IndexedDB → IDBKeyRange.lowerBound(30, true) on an "age" index
  in-memory → expression.match(json)            ← the fallback
```

### Capability-based planning

Stores differ wildly in power, so the public API targets the **intersection** of what all
stores can do, and each backend declares a `capabilities` descriptor used to *optimize*:

| Store           | indexes | ranges | sort pushdown | joins | tx  |
| --------------- | ------- | ------ | ------------- | ----- | --- |
| localStorage    | no      | no     | no            | no    | no  |
| IndexedDB       | yes     | yes    | partial       | no    | yes |
| SQL (SQLite/PG) | yes     | yes    | yes           | yes   | yes |
| Mongo           | yes     | yes    | yes           | no    | yes |

The planner pushes down what a backend supports and **falls back to fetch-then-`match()`** for
the remainder. Sorting and paging are part of the `QueryPlan` and are applied either by the
backend (pushdown) or by the planner after the fact — never silently dropped.

---

## 4. Expression AST + serialization = the RPC payload

Every expression node implements `stringify()` / `toHash()` (used for cache keys). That is
exactly what lets a query travel over the wire. The complement is the inverse:

- **`Expression.parse(json) → Expression`** rehydrates the AST on the server before it runs
  against the store (`src/expressions`, the peer of `stringify()`).

`stringify()` + `parse()` together are the query half of the wire protocol — putting
`stringify()` on every node is what makes the network-transparent design possible.

---

## 5. Properties, validation, and types (Standard Schema)

Validators (Zod / ArkType / Valibot) are great at static type inference and runtime
validation, but they validate **shapes**, not ORM semantics (relations, storage hints, lazy
loading, query value types). And **Standard Schema** deliberately standardizes only
validation + type inference, **not introspection** — but an ORM needs introspection for
storage layout, indexes, and migrations.

Therefore:

- **The property/metadata map stays the introspectable source of truth.** It drives DDL for
  SQL, object-stores + indexes for IndexedDB, and collection shape for Mongo — from one
  definition. Migrations become "diff the schema, emit per-backend DDL."
- **Each scalar property delegates validation to a Standard Schema validator**, so users can
  bring Zod / ArkType / Valibot / a built-in default. No required dependency.
- **Codecs/morphs handle serialization** (Date ↔ epoch int, JSON parse/stringify) as a single,
  uniform mechanism rather than ad hoc per-property hooks.
- **The static model type is inferred from the property map** (relations included), so
  `eq("age", value)` types `value` to the field's type and results are typed — end to end.

Relations (`relationToOne` / `relationToMany`) remain pure ORM metadata; no validator is
involved.

```ts
// The real definition is InferModel in src/properties/infer.ts. A scalar contributes its
// Runtime type (the first type arg — NOT the stored/output type), so an enum schema yields a
// literal union; a computed field contributes its return type; a to-one relation is `M | null`;
// a to-many relation is `M[]`.
type Infer<P> = {
  [K in keyof P]:
      P[K] extends ComputedProperty<infer R>        ? R
    : P[K] extends ScalarProperty<infer R, any>     ? R
    : P[K] extends RelationToOneProperty<infer M>   ? M | null
    : P[K] extends RelationToManyProperty<infer M>  ? M[]
    : never
} & { uuid: string };
```

A fourth property kind, **`computed()`**, is a virtual field derived from an instance's other fields
on every read — never stored, validated, or sent to a backend, so it lives entirely in the reference
(Repository) layer and can't diverge across backends. `softDelete: true` and `timestamps: true` are
model-level opt-ins that *inject* properties (a nullable `deletedAt` marker, `createdAt`/`updatedAt`)
and widen the inferred type the same way.

---

## 6. Relations across backends

You cannot `JOIN` across, say, Mongo and IndexedDB. The portable default is
**decompose-and-stitch**: a relational filter is split into per-repository sub-queries keyed
by uuid, then results are stitched (`Repository.preprocessWhere`). A real `JOIN` is a
**per-backend optimization** applied only when both sides share a SQL backend — not the
baseline.

Note: query rewriting for relations and query rewriting for **access policy** (Section 8) are
the *same mechanism* — an AST → AST transform before execution.

---

## 7. Reactivity and the change feed

Sync is *push*, but the request/response contract only answers "the value now." So the
`Backend` interface includes a **`changes()` channel** (a stream / subscription). When remote
data arrives, `reconcile()` feeds "these uuids changed" into the `QueryCache`, which already
knows how to invalidate and re-run cached queries. This is worth having even without sync, for
reactive UIs.

---

## 8. Access control as a composable layer

Authorization is **not** baked into the transport — it is a `PolicyBackend` decorator that
wraps the store and **rewrites the query AST** before execution (e.g. inject
`AND owner == currentUser`) or rejects disallowed operations. Keeping it separate from
transport means the same rules apply over HTTP, WS, and in-process.

- The **adapter** does *authentication* (who are you, from the token).
- The **`PolicyBackend`** does *authorization* (what may you see/do) via AST rewriting.

### Context threading

Every backend op takes an ambient `Context` (identity, permissions, request id). The adapter
establishes it from the token and threads it down; the `PolicyBackend` consumes it. Context
threading runs through every layer by design — retrofitting it later would touch every call site.

---

## 9. Sync as a composite backend

Sync is not a bolt-on subsystem — it is a **stateful decorator** implementing `Backend`
(`SyncBackend`, `src/sync`):

```ts
class SyncBackend<T> implements Backend<T> {
  constructor(private local: Backend<T>, private remote: SyncTarget<T>, private merge: ConflictPolicy) {}
  get capabilities() { return this.local.capabilities; }   // reads come from local

  query(plan, ctx) { return this.local.query(plan, ctx); }            // offline-first: read local
  save(x, ctx)     { this.local.save(x, ctx); this.outbox.enqueue(x); } // optimistic + queue
  remove(x, ctx)   { this.local.tombstone(x, ctx); this.outbox.enqueue(x); }
  persist(ctx)     { return this.local.persist(ctx); }                // durable locally + queued

  async reconcile(ctx) {                                              // background, not req/resp
    const incoming = await this.remote.pull(this.cursor, ctx);
    for (const c of incoming) await this.merge(this.local, c);         // composite owns conflicts
    await this.remote.push(this.outbox.drain(), ctx);
  }
}
```

- **Reads delegate to local** (offline-first); **writes are optimistic-local + queued**.
- The composite is the natural home for **conflict resolution** because it holds both handles.
- The **remote is usually a `SyncTarget`, not a full `Backend`** — a thinner
  `pull(since)` / `push(changes)` / `checkpoint` interface. A real queryable server can
  implement `Backend`, but most remotes are sync endpoints, not ad-hoc query stores.
- The composite **owns its own state** (cursor, outbox, HLC, tombstones). That state can live
  in the local backend under a reserved `_sync` store — the interface recurses on itself.

### Storage primitives sync needs

Wired into the storage seam so they're available whether or not a given deployment uses sync:

1. **Changelog** — a hook in `persist()` that appends per-record changes.
2. **Tombstones** — soft-delete markers so deletes propagate.
3. **Versioning** — a monotonic per-record version / **hybrid logical clock (HLC)**
   (`src/sync/hlc.ts`) so replicas can order edits.

Conflict policy (LWW / CRDT / server-authoritative) is a **product decision** per deployment,
not something the library hardcodes. The default is whole-record last-write-wins by HLC version;
`SyncBackend({ fieldLevel: true })` opts into **per-field** LWW — each record also carries a
`_fieldVersions` map, so concurrent edits to different fields merge (each field's higher version
wins) instead of the whole higher-versioned record clobbering the other.

### Identity & idempotency

Client-generated 32-char uuids are an asset, not an accident: the client mints stable IDs
offline (no server round-trip), and **push becomes an idempotent upsert-by-uuid** — replaying
a queued write after a flaky network is safe.

### Prior art (for extending sync further)

RxDB, PouchDB/CouchDB replication, Replicache, ElectricSQL, PowerSync, WatermelonDB, TinyBase.
Sync is where ambitious local-first ORMs tend to die; know which wheel you're choosing to
rebuild and why.

---

## 10. Transport as a backend boundary

Define the wire contract once (serialized backend ops), then implement transports against it:

- **`http`** — request/response ops (query, save, pull, push).
- **`ws` / SSE** — the server→client `changes()` feed.
- **`in-process`** — direct call, no serialization. The same app runs embedded with no server,
  and the server + policy + adapter stack becomes unit-testable with zero network.

Swapping embedded ↔ client/server is a transport choice, not a rewrite. That is the payoff of
the symmetry. See `src/core/Transport.ts`.

---

## 11. Advanced queries and leveraging each backend

The central tension: leverage each backend's full power (SQL joins/aggregates, Mongo pipelines,
compound/full-text indexes) **while keeping every query runnable on every backend** — down to a
dumb key-value store. One principle dissolves it:

> **Query *semantics* are defined by the in-memory reference implementation. Backends are
> *accelerators*, never the source of truth.** Whatever a backend can push down natively, it does
> — for speed. Whatever it can't, the engine runs in memory *after* fetching. A backend can change
> a query's **performance**, never its **result**. That is what makes "compatible everywhere" hold
> by construction.

This is already true for *filtering* (`Expression.compile` push-down + `match()` fallback, §3),
and generalizes to **every** operation via the `QueryPlan` pipeline (filter, sort, limit/offset,
project, aggregate, groupBy, window). Each stage has two faces, exactly like an expression:
reference semantics (in memory) and compilation (push-down, or *decline*). The planner pushes
down the longest contiguous compilable prefix a backend's capabilities allow, and runs the
remaining stages in the in-memory engine (`src/backends/util/scan.ts`) — the same query pushes further
down on a richer backend without changing its result.

Escape hatches that leverage native power **without** breaking portability:

1. **Declarative advanced indexes** (compound, partial, full-text, geo) live in the *schema*; the
   planner uses them opportunistically when a query's shape matches. The query never changes — the
   optimization lives in planner + schema, not in the query.
2. **Advisory hints** (use index X, a collation) — a backend *may* honor, others ignore. Permitted
   to affect performance only, never results.
3. **Capped raw/native queries** — for the genuine ~5% (Postgres FTS ranking, Mongo aggregation,
   PostGIS), a `raw` door that is *explicitly backend-scoped and opted out of the portability
   guarantee*. Kept out of the portable AST — a separate, typed-per-backend API.

Honest limits, designed for up front:

- A fallback aggregation/sort over an **unbounded** set means fetching everything to compute in
  memory — a real performance cliff. The planner **logs/warns** (the "no silent O(n) surprise"
  rule), and a backend may **refuse** unbounded scans rather than melt.
- Stages **stream** (async iterables) so in-memory fallbacks don't materialize the whole set.
- The reference implementation pins down **ordering / null-ordering / collation** precisely, so
  every backend's results match exactly — not just "close enough".
- **Typed pipeline**: each stage transforms the result type (`project` narrows fields, `aggregate`
  reshapes, `include` adds relations), so advanced queries stay fully type-checked end to end.

---

## 12. Current limitations

Implemented and tested: indexes (unique/compound/partial/TTL/text), Standard-Schema validation +
typed codecs, schema migrations, transactions (both the atomic `transaction(fn)` and interactive
`tx.repository(...)` forms), dirty/field-level change tracking, soft deletes, computed/virtual fields,
seeding factories, an opt-in pre-write unique check, and opt-in field-level sync (per-field LWW).

What remains open is tracked in [docs/PRODUCTION_ROADMAP.md](docs/PRODUCTION_ROADMAP.md) — chiefly the
columnar push-down remainder (`exists`/`size`/`any`/nested comparators/`json()` columns still
scan-fall-back on Postgres/MySQL, where a present-null value would diverge from the reference; they push
down on SQLite/Mongo), collapsing a to-one relation filter's stitch sub-query into a single correlated
`EXISTS`/`JOIN` (the local half now pushes down to `_extra`; the crash is fixed), and making
`QueryCache` invalidation incremental.

Both halves of **field-level change tracking** now exist as opt-ins. The `save()` write path diffs a
saved instance against a per-uuid write baseline and passes the changed field names through
`Backend.save()`, which the SQL/Mongo backends use to write only the changed columns/fields. One layer
up, `SyncBackend({ fieldLevel: true })` carries per-field HLC versions (`_fieldVersions`) so concurrent
edits to different fields merge instead of clobbering; default off preserves whole-record LWW.
