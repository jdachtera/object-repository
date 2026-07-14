# Production Roadmap

Gaps between the current state and a production-ready ORM, roughly in priority order. This is a
living checklist — see the design discussion in the PR/commit history for rationale.

## Positioning

This is an **isomorphic query + offline-sync layer** (peers: RxDB, Replicache, ElectricSQL), not a
server-side relational mapper like TypeORM/Prisma/Mongoose. The roadmap leans into that lane: make
the SQL backends first-class *and* keep the sync/isomorphic story strong, rather than becoming a
second Prisma.

It is the **data plane** of a full-stack app — typed queries, entity writes, realtime, offline, and
row-level auth over one transport, replacing most of what teams reach for tRPC/GraphQL to do for data
access. The **command plane** (task-based RPC for non-CRUD verbs) now rides the same transport too
(see below), so it can be a one-stop client↔server surface rather than needing a parallel RPC stack.

## Recently done

- [x] **Durable sync server + transport bridge.** The offline-first stack now runs against a real store
      end to end, not just the in-memory reference. `BackendSyncTarget` persists the append-only
      changelog / LWW protocol in an injected `Backend` (SQLite/Postgres/MySQL/Mongo), re-seeding its
      server-assigned append cursor from the persisted max on restart (the cursor is the append `seq`,
      *not* the HLC version, so a lagging-clock push still reaches every client). `SyncTargetAdapter`
      exposes a `SyncTarget`'s pull/push over a transport (the sync analogue of `BackendAdapter`), and
      `RemoteSyncTarget` is the client that proxies pull/push over any `Transport` — so
      `SyncBackend({ local, remote: new RemoteSyncTarget(new HttpTransport(url)) })` reconciles with a
      backend-persisted hub. `InProcessTransport`/`createRequestListener` were widened to front any
      `TransportAdapter` (not just `BackendAdapter`). Verified end to end (two clients converge under
      whole-record LWW and field-level merge) over in-process, real SQLite, and a real HTTP server;
      durability + re-seed proven across a fresh target on the same store. Single-process `seq` (multi-
      process needs a shared sequence) and changelog compaction remain open. See `docs/sync.md`.
      (`BackendSyncTarget.ts`, `SyncTargetAdapter.ts`, `RemoteSyncTarget.ts`, `durableSync.test.ts`.)
- [x] **Reactive queries (`liveQuery`) + framework recipes.** A query can be made live —
      `liveQuery(collection)` runs it once, then re-runs after every committed change to the model (a
      local write or one over the change feed: cascades, remote/sync writes), exposing a
      referentially-stable `{ data, error, loading }` snapshot via a `getSnapshot`/`subscribe` pair
      shaped for `useSyncExternalStore` and Solid's `from`. Lazy + ref-counted (runs on first subscribe,
      stops on last), stale-while-revalidate, with a pluggable runner (`c => c.count()` / `page` /
      `groupBy`) and `refetch()`. `QueryCollection.subscribe(onResult)` is the imperative sugar. The
      framework hooks (React `useQuery`, Solid `createQuery`, Vue/Svelte) are ~5-line adapters kept
      **out of the package** (no `react`/`solid-js` dependency forced) — see `docs/reactive.md`. Built
      over the existing change feed, with **predicate-scoped invalidation**: a live query re-runs only
      when the changed record matches its filter before or after the write (tested via the in-memory
      reference `match` against the change's new record and the dirty-tracking baseline for its old
      state), so a write to a row outside the query's filter never wakes it. **Relation filters are
      tracked**: a query filtered across a reference relation (`customer.country`) also subscribes to the
      target model's feed, so a change to a `customer` re-runs the `orders` query. Remaining coarseness:
      an unfiltered query re-runs on any write to its model; a relation-filtered query re-runs on any
      change to either model (own-model relevance falls back to conservative, since a relation path
      can't be evaluated against a raw stored row); and only one relation hop is followed.
      (`liveQuery.ts`, `liveQuery.test.ts`.)
- [x] **Seeding / fixtures / factories.** `defineFactory(repo, { defaults })` gives
      `build`/`buildMany`/`create`/`createMany` plus a `sequence()` helper for dev/test data. It
      delegates entirely to the repository's `createInstance`/`save`/`persist`, so factory output is
      identical to hand-written code on every backend — it never mints ids, validates, encodes, or
      cascades itself. Producers see a 0-based `seq` and may return related instances (persisted via
      the repository's existing `remoteProperty` cascade). Additive, dependency-free (`factory.ts`).
- [x] **Computed / virtual fields.** `computed<R>((row) => …)` — a field derived from an instance's
      other fields on every read (`materialize` + `createInstance`), never stored, validated, or sent
      to a backend, so it can't diverge across backends. Auto-excluded from column/DDL/index derivation
      (its `kind` isn't `"scalar"`) and skipped by `serialize()`; typed into `InferModel` via a
      covariant phantom. Filtering/sorting by one is rejected early with a clear error (it's in no
      stored row). (`ComputedProperty.ts`, `computedField.test.ts`.)
- [x] **Soft deletes (opt-in, general).** `define({ softDelete: true })` makes `remove()` stamp a
      nullable `deletedAt` marker instead of deleting, and every read excludes soft-deleted rows by
      default. Implemented entirely above the Backend seam (backend-agnostic): a null-tolerant `date`
      marker, `remove()` routing through the save path (`remove(instance, { hard: true })` bypasses it),
      `restore(uuid)`, the live filter (`isNull(field)`) ANDed into every read chokepoint + the by-uuid
      loaders (so `get()`/relations exclude deleted targets), a `QueryCollection.includeDeleted()`
      escape hatch, and identity-map eviction on a soft-delete event. A soft-deleted row keeps its
      unique value (restore/hard-delete to reuse); since `remove()` becomes a save, sync never
      double-tombstones. The live filter pushes down to `deletedAt IS NULL` (verified on Postgres 16).
      (`softDelete.test.ts`.)
- [x] **`isNull` / `isNotNull` push-down.** A first-class null-or-absent predicate (`getPath(...) ==
      null`) — the one null test that agrees across engines. Pushes down to `col IS [NOT] NULL` on a
      real columnar column (an absent field and an explicit null both store as SQL NULL and decode back
      to absent, matching the reference exactly), `json_extract(...) IS [NOT] NULL` on SQLite,
      `{field:null}` / `{$ne:null}` on Mongo, scan-refine on IndexedDB (verified on live Postgres 16 /
      MySQL 8). Nested/undeclared (`_extra`) paths scan-fall-back. (Closes the "IS [NOT] NULL" part of
      "Deeper query push-down"; also unblocks the soft-delete filter push-down.)
- [x] **Uniform pre-write unique check on SQL/Mongo (opt-in).** `{ uniquePreCheck: true }` raises the
      same driver-agnostic `UniqueConstraintError` as the in-memory reference, before the write, instead
      of leaning on the DB index (or, on MySQL, silently absorbing a secondary-unique collision). Shared
      semantics extracted to `unique.ts` (NULLs distinct, compound keys, same-batch conflicts, self-uuid
      not a conflict). Covers column/index-backed unique keys; not a lock (the DB index stays the
      backstop for a racing insert). Closes the MySQL secondary-unique divergence when enabled (verified
      on live Postgres 16 / MySQL 8). (`uniquePreCheck.test.ts`.)
- [x] **MySQL column-type tuning.** `text` columns are now real MySQL `TEXT` (no silent `varchar(255)`
      truncation of long strings); an index over a TEXT-backed column gets a `(255)` key-length prefix
      (auto-provisioner supplies column types; the migration builder's `createIndex` gains an opt-in
      `columnTypes` arg). The uuid / `_orm_migrations` primary keys use a bounded identifier type so they
      stay directly indexable. Verified on live MySQL 8 (a 5000-char value round-trips; an indexed TEXT
      column builds with `Sub_part` 255).
- [x] **Field-level sync deltas (opt-in).** `new SyncBackend({ fieldLevel: true })` makes concurrent
      edits to *different* fields of the same record both survive (per-field last-write-wins), instead of
      the whole higher-versioned record clobbering the other. `SyncChange` carries an optional
      `fieldVersions` map; `save()` stamps only the changed fields (insert-vs-no-op disambiguated by a
      session-scoped version cache); `applyIncoming()` merges field-by-field when both sides are
      field-level (else whole-record fallback); the reference server never rejects a field-level change
      as a whole-record conflict. Strictly opt-in and deployment-wide; default off is byte-identical to
      today. MVP: full-record payloads, session-scoped version cache, top-level granularity, coarse
      cache invalidation. (`fieldLevelSync.test.ts`.)
- [x] **To-one relation filters on the columnar SQL backend.** A to-one relation filter
      (`eq("customer.country", "DE")`) decomposes to a local filter on the relation ref, which lives in
      the `_extra` overflow (not a real column) — so the columnar compiler *crashed* (`column
      "customer" does not exist`) on Postgres/MySQL. Now a top-level undeclared property (a relation
      ref) resolves to an `_extra` JSON extraction, matching the reference and pushing the local filter
      down. (The further optimization — collapsing the decompose-and-stitch target sub-query into a
      single correlated `EXISTS` — remains open; see "True single-query relation JOIN" below.)
- [x] **Dirty / field-level change tracking (save()-triggered).** `Repository` now diffs a saved
      instance against a per-uuid write baseline (the last-known-persisted encoded record, set on
      load and refreshed from the change feed) and passes the changed top-level field names through
      `Backend.save()` as an optional `dirty` hint — additive to the interface, so a backend that
      ignores it behaves exactly as before. `SqlBackend` (Postgres/MySQL) uses it to scope
      `INSERT … ON CONFLICT/DUPLICATE KEY DO UPDATE SET` to only the changed columns (mapping any
      field without its own declared column to the shared `_extra` overflow column), bucketing saved
      changes by which columns they touch so same-shaped writes still batch into one multi-row
      statement (verified against real Postgres 16 and MySQL 8, `sqlIntegration.test.ts`).
      `MongoBackend` scopes `$set` to the changed fields and adds `$unset` for a removed one (verified
      in `mongoBackend.test.ts`). `SQLiteBackend` is unchanged — it stores one record as a single JSON
      blob column, so there is no column to scope down to. The change feed and sync still ship full
      records (see "Field-level sync deltas" below — deliberately out of scope here).
- [x] **`embedded()` — queryable nested subdocuments.** A nested object stored *natively* (like
      `array()`, not stringified like `json()`), so its fields are reachable by a dotted path in
      filters and sorts — `eq("subscription.customerId", id)`, `eq("subscription.details.status",
      "active")`. Traverses in memory (`getPath`), pushes down to a JSON extraction on the columnar
      Postgres/MySQL backends (`("col"::jsonb #> '{a,b}') = ?::jsonb` / `JSON_EXTRACT`, verified on
      live Postgres 16 and MySQL 8, `sqlIntegration.test.ts`), `json_extract` into the SQLite blob,
      and a real subdocument on Mongo. Closes a pervasive filter shape (webhook/settings code that
      filters deep dotted paths into a subdocument); `json()`
      stays for opaque blobs you never query into. Only the columnar backend needed changes (a new
      `embedded` column type + `jsonSource` routing); the identity codec made the other backends work
      for free.
- [x] **Array-element equality.** A scalar `eq`/`!=` against a declared `array()` field now means "the
      array contains the value" (Mongo's `{ field: scalar }` semantics) instead of never matching —
      the common `{ tags: 'vip' }` array-membership idiom. Schema-aware rewrite to `contains`
      in `preprocessWhere`, so it's correct on every backend (native + Mongo facade); scalar-typed
      fields are untouched, so their equality still pushes down. (`$in`/`$nin` against an array remain
      a follow-up.)
- [x] **Ranking window functions (`windowed()`).** `rowNumber`/`rank`/`denseRank` over a partition —
      the portable `$setWindowFields` / SQL `OVER (PARTITION BY … ORDER BY …)` — closing the genuinely
      un-expressible "rank within a partition" gap (leaderboard rank, is-this-the-user's-first-payment,
      top-N-per-group). `events.all().sort("amount").windowed({ partitionBy: "user" }, w => ({ r:
      w.rank() }))` returns each row with the window columns merged. Real push-down to
      `ROW_NUMBER()/RANK()/DENSE_RANK() OVER (…)` on the columnar Postgres/MySQL backend (verified on
      live Postgres 16 and MySQL 8, `sqlIntegration.test.ts`) and SQLite; the shared `computeWindow`
      reference (partition → order → number, with SQL/Mongo tie semantics) runs as the fallback on
      any other backend. New optional `WindowingBackend` capability + `WindowPlan`, mirroring the
      aggregate push-down path.
- [x] **`countDistinct` aggregator + timezone-aware date parts.** Two analytics primitives surfaced by
      porting a realistic app query surface. `countDistinct(field)` — the portable `$size` of
      `$addToSet` / SQL `COUNT(DISTINCT x)` (skips NULL) — closes the single most-used analytics gap
      (unique-users-per-bucket); it pushes down to `COUNT(DISTINCT)` on Postgres/MySQL/SQLite (verified
      on live Postgres 16 and MySQL 8, `sqlIntegration.test.ts`) and to `$addToSet`+client-size on
      Mongo, with the in-memory reference as the fallback. Date parts (`year`/`month`/`hour`/
      `dateToString`) take an optional IANA `timezone` (`"Europe/Berlin"`) and bucket by local
      wall-clock time (DST-aware via `Intl`): correct on the
      in-memory reference, IndexedDB, and Postgres/MySQL (which already reduce date parts in memory),
      pushed down natively on Mongo (`{ date, timezone }`); SQLite rejects a zoned part loudly rather
      than silently mis-bucketing (`strftime` has no IANA support). Also fixed a `Date`-comparand
      regression (a `Date` filter value now normalises to epoch-ms at AST construction) and SQL
      index-name sanitization (a developer-supplied name like `songId-userId` no longer breaks
      provisioning). See `docs/QUERY_SURFACE.md` for the full surface analysis.
- [x] **Store-migration primitives: bulk copy + dual-write.** Two composable pieces for moving between
      stores without a bespoke script. `copyBackend(source, target, { models })` drains each model a
      page at a time (ordered by `uuid` for stable, resumable pagination) and writes each page as one
      persisted batch — any pair, since records cross the `Backend` seam as plain JSON (in-memory →
      Postgres, SQLite → Mongo, …), with an optional per-model `where` filter, a `transform` (return
      `null` to skip), and an `onBatch` progress hook. `multiWriteBackend({ primary, secondaries })` is
      a fan-out decorator: reads + the change feed come from the primary, every write lands in all
      stores. It mirrors the primary's read capabilities and exposes a fanned `patch`/`patchMany`/
      `upsert` only when *every* store supports it (else the Repository's save/remove fallback fans
      anyway). Consistency model is explicit: not 2PC — `persist` flushes the primary first, then
      secondaries; `"strict"` (default) rejects on a secondary failure, or a custom `onSecondaryError`
      tolerates a lagging one; no cross-store interactive transaction (the manager falls back to
      write-batching, which still fans). Together they model a zero-downtime cutover: backfill history,
      dual-write live traffic, verify, flip the primary. Verified across in-memory ⇄ SQLite.
- [x] **Real-engine verification pass (Postgres 16 / MySQL 8) + index-name collision fix.** With the
      live-DB harness in place, ran interactive-transaction isolation (uncommitted writes visible
      in-tx, invisible on a separate connection, reverted on rollback), unique-index enforcement,
      upsert-by-uuid, schema migrations, and scalar type-fidelity (int/float/date/bool round-trip)
      against real engines. This surfaced and fixed a genuine data-integrity bug: **SQL index names
      were unscoped**, but Postgres index names are schema-global — a second table declaring a
      same-named field (e.g. two tables each with a `unique` `email`) hit `CREATE UNIQUE INDEX IF NOT
      EXISTS "email"`, matched the first table's index, and *silently skipped*, so the second table
      lost its unique constraint entirely. Fixed by scoping the emitted name to `<model>_<index>`. The
      pass also documented a real **cross-engine divergence** (now pinned by tests + README): under
      `persist()`'s upsert, a secondary-`unique` collision **rejects on Postgres** (`ON CONFLICT
      (uuid)` doesn't cover it) but is **silently absorbed on MySQL** (`ON DUPLICATE KEY UPDATE` can't
      scope to one key).
- [x] **Nested-path push-down (SQL) + real-DB test harness.** A dotted filter into an embedded object
      in the `_extra` overflow (`eq`/`$in` of a scalar) now compiles to a **type-exact** JSON extraction
      — Postgres `("_extra"::jsonb #> '{a,b}') = ?::jsonb`, MySQL `JSON_EXTRACT(_extra, '$.a.b') =
      CAST(? AS JSON)` — instead of scanning. Scoped to the parity-safe cases (undeclared/embedded head,
      scalar `=`/`$in`); declared/opaque columns, comparators, `nin`, and null values still scan, so it
      never diverges from the in-memory reference. Verified against **real Postgres 16 and MySQL 8**
      (`sqlIntegration.test.ts`, gated on `PG_URL`/`MYSQL_URL`) matching the reference row-for-row — the
      type-exact `jsonb #>` operators pg-mem can't run. Closes the tooling blocker that had deferred it.
- [x] **Mongo query-language facade (migration on-ramp).** `object-repository/compat/mongo` — `parseMongoFilter`
      (the inverse of the Mongo compiler) maps MongoDB filter syntax onto the portable AST, and
      `mongoCollection(repo)` exposes a Mongo-driver-shaped `find/findOne/countDocuments/aggregate`. So
      a Mongo-flavoured app runs its queries unchanged on *any* backend (verified: the same query
      returns identical results on in-memory and Postgres). Maps the portable subset; throws loudly on
      anything it can't express exactly. An opt-in subpath, kept out of the core bundle. Now also
      covers **writes** — `insertOne/insertMany/updateOne/updateMany/findOneAndUpdate/replaceOne/
      deleteOne/deleteMany` with `$set/$unset/$inc/$mul/$push/$addToSet/$pull` mapped to the atomic
      patch ops (and `upsert`), rejecting conflicting operators like Mongo does.
- [x] **Tree-shaking / packaging.** `"sideEffects": false` + subpath `exports` + a multi-entry build,
      so consumers' bundlers drop unused backends (importing `InMemoryBackend` never pulls in
      Postgres/Mongo/SQL code) and the compat facade loads only via `object-repository/compat/mongo`. No driver is
      bundled — they're injected — so no store's dependency is forced on anyone.
- [x] **Command middleware + per-command authorization.** Commands take `use: [...]` middleware (the
      command-plane analogue of `PolicyBackend`): guards run before the handler, deny by throwing (plain
      throw → `FORBIDDEN`, or a `CommandError` to pick the code), can augment the context the handler
      sees, and short-circuit the chain. Ships `requireIdentity` / `requireRole` built-ins.
- [x] **Command plane (typed task-based RPC).** `command({ input, handler })` + a server command map,
      dispatched over the *same* transport as the data plane (a `command` `WireRequest`), reusing the
      connection, ambient `Context` (auth), and decorators. `orm.commands<typeof commands>(transport)`
      gives a fully-typed client with no codegen (client `import type`s the map). Input is validated
      via Standard Schema; errors carry codes. Crucially it **integrates with the data system**: the
      change events a command's writes emit are captured and returned with the reply, then fed through
      the manager's backend — so a command-triggered mutation invalidates the same query caches and
      drives the same reactive reloads as a local write, even over request/response HTTP. Closes the
      tRPC/GraphQL-mutation gap without a parallel stack.
- [x] **Batched relation loading (no N+1).** Loading a relation across a set of sibling rows now
      collects every ref into a single `WHERE uuid IN (…)` load per relation, instead of one query per
      row — so a `list()` over N rows with relations costs O(depth × relations) queries, not O(N).
      Reference relations batch through the target's `loadMany` (which batches its own relations in
      turn); the identity map still shares/dedupes instances and keeps cycles safe. (A true
      single-query JOIN is a further optional optimization; this removes the N+1 cliff safely and
      portably across every backend.)
- [x] **Connection resilience.** `new PostgresBackend(client, resilience)` / `new MySqlBackend(conn,
      resilience)` wrap the executor with a per-call timeout + retry-with-backoff (`resilientExecutor`,
      also exported standalone). Retries are applied *safely* by operation kind: reads (`SELECT`) and
      whole transactions (atomic → roll back cleanly) retry transient failures; writes issued via
      `run` only time out (a retry could double-apply). Exponential backoff is capped, the
      retryability predicate + backoff are configurable, and an injectable clock keeps it testable.
- [x] **Cursor / keyset pagination.** `collection.page({ limit, after })` seeks past the previous page
      with a `WHERE (sortKeys, uuid) > cursor` predicate (a uuid tiebreaker makes the order total)
      instead of `OFFSET`, so it pushes down like any filter and never skips rows. Returns
      `{ items, nextCursor, hasMore }`; the opaque cursor is bound to the query's ordering (reuse under
      a different `sort` throws) and boundary values are codec-encoded so date/custom keys work.
- [x] **Observability.** `observe(backend, options)` wraps any backend and reports each async
      operation's duration + outcome to `onOperation`, with an `onSlowQuery` hook past a threshold
      (query/count/aggregate/persist/patch/upsert/raw/transaction/migrate). It's a composable decorator
      like `PolicyBackend`/`HooksBackend`, but **capability-preserving** — it mirrors the inner
      backend's optional interfaces exactly, so adding tracing never downgrades push-down. (An
      OpenTelemetry span per operation is a thin adapter over `onOperation`.)
- [x] **Unique-constraint enforcement (reference backend).** The in-memory backend is now schema-aware
      and rejects a write that would duplicate a `unique` field's value — single-field hints and
      compound `unique` indexes, checked against the store *and* within the same batch, before any
      mutation (so a violation leaves the store intact), with a `UniqueConstraintError`. NULL/absent
      components are not enforced (NULLs distinct, like a plain SQL unique index). SQL/Mongo already
      enforce the same shape through their real unique indexes, so this closes the gap on the reference.
- [x] **Field defaults + required-on-write.** A scalar property can declare `default` (a value or a
      per-instance factory) and `required`. Defaults fill an absent field in `createInstance` and again
      at write time (so a plain object saved directly still gets them, and only `undefined` triggers a
      default — an explicit `null` is kept); `required` rejects a still-absent-or-null field at `save`
      with a `ValidationError`. (Part of "Validation richness"; the pre-write unique check is still
      open — see below.)
- [x] **Text-search push-down (SQL).** Case-sensitive `startsWith`/`endsWith`/`includesText` over a
      real text column now compile to `LIKE` (`LIKE BINARY` on MySQL, whose default collation is
      case-insensitive), instead of scanning. Case-insensitive (ASCII-only in the reference),
      non-text-column, and literal-metacharacter (`%`/`_`/`\`) searches stay on the scan path so the
      result always matches the in-memory reference exactly. (Part of "Deeper query push-down".)
- [x] **Full migrations.** `orm.migrate(migrations)` applies a versioned set once each (tracked in an
      `_orm_migrations` table, so re-runs are no-ops), running each migration's recorded DDL inside a
      transaction where the engine allows transactional DDL. The `SchemaBuilder` covers create/drop
      table, add/drop/rename/retype column, create/drop index, and a raw `sql()` backfill hatch;
      `orm.rollback` reverts the most recent migrations via their `down`. Field-type args use the ORM's
      stored-type tags, mapped to native column types per dialect. (Additive column-add still happens
      automatically at `define` time; migrations are the explicit path for the non-additive changes.)
- [x] **Interactive transactions.** `orm.transaction(async (tx) => …)` hands the callback a `tx`
      scope whose repositories read and write on the transaction's own connection — a write persisted
      mid-callback is visible to a later read *before* commit (Postgres/MySQL/SQLite). Writes made
      through the outer repositories are folded into the same transaction, so a mixed unit still
      commits atomically; a throw rolls back and re-throws. Non-transactional backends (in-memory,
      IndexedDB) degrade to write-batching with a functional but non-isolated scope.
- [x] **Integrated raw-query escape hatch.** `orm.raw(query)` runs a backend-native query the compiler
      can't express — `{ sql, params }` on Postgres/MySQL, `{ collection, pipeline }` on Mongo — through
      the backend's own connection/pool and decorator stack (not the bare driver), returning driver rows
      untouched. Opaque to row-level policy (scope it yourself); the `PolicyBackend` forwards it.
- [x] **Batched writes (SQL).** `persist` groups queued saves/removes by model into multi-row
      `INSERT … VALUES (…),(…)` and `DELETE … WHERE uuid IN (…)` statements (chunked at 500 rows),
      instead of one round-trip per row.
- [x] **Additive column migration (SQL).** When a model gains a field, provisioning introspects the
      existing table and `ALTER TABLE ADD COLUMN`s the missing ones (Postgres/MySQL) — old rows read
      back with the new column as null/omitted. Additive only; rename/drop/backfill are still manual.
- [x] **User-facing transactions.** `orm.transaction(async () => { … })` flushes everything the
      callback queued as one atomic unit — Postgres/MySQL wrap the flush in a real DB transaction
      (checked-out connection, `BEGIN … COMMIT`, `ROLLBACK` + re-throw on error), SQLite already did.
      A throwing callback persists nothing and discards the queued writes. (Write-batching, not
      interactive: reads see committed state and in-memory instances aren't reverted on rollback.)
- [x] **Columnar SQL storage.** Postgres/MySQL build **real typed tables** — one native column per
      scalar field, plus a `_extra` JSON overflow column for embedded relations / undeclared fields —
      instead of a single `(uuid, data JSON)` blob. Filters/sort/aggregates compile to plain column
      SQL (no JSON extraction or casts). (SQLite still uses its JSON-blob backend, which has native
      JSON patch push-down; converge later.)
- [x] **Build declared indexes on PG/MySQL.** Real column indexes are created from the `index` /
      `unique` hints and model-level `indexes` (unblocked by columnar storage).

## Open

- [ ] **Deeper query push-down (remainder).** `exists` (`json_type … IS [NOT] NULL`), array-of-object
      filters (`any` → `jsonb_path_exists` / `JSON_TABLE`, `size` → `jsonb_array_length`), nested-path
      *comparators* (`>`/`<` on JSON, which need careful ordering semantics), and JSON push-down for
      declared `json()` columns (blocked on the reference storing them as opaque strings) still
      scan-fall-back **on the columnar Postgres/MySQL backends** — they'd diverge from the in-memory
      reference on a present-null value (a columnar storage quirk), so pushing them down needs care.
      They already push down on SQLite and Mongo. `isNull`/`isNotNull`, top-level fields, case-sensitive
      text search, and nested `=`/`$in` now push down everywhere they're parity-safe.
- [ ] **True single-query relation JOIN (optional).** A to-one relation *filter* now pushes its local
      half down to `_extra` (no more crash), but the target predicate is still resolved by a separate
      decompose-and-stitch sub-query. Collapsing that into one correlated `EXISTS` (or a real `JOIN`
      where the backend supports it) needs cross-model schema resolution inside the SQL compiler and a
      parity-proven correlation (the FK-column-vs-JSON question) — a focused pass of its own.
- [ ] **Incremental `QueryCache` invalidation.** The reactive **live-query** path is now predicate-
      scoped *and* relation-aware (a change wakes a query only if its record matches the filter
      before/after, and a referenced relation target's change wakes it too — see the `liveQuery` item
      above). The remaining coarseness is the `QueryCache` *result* cache used by plain repeated
      `.list()`s: it still clears every cached result for a model on any write. Making that incremental
      (evicting only the plans a change can affect — the same predicate test, plus order/paging
      awareness) is the open piece; it composes with `ChangeEvent` carrying changed fields. Also open on
      the live path: multi-hop relation tracking and precise (non-coarse) related-model relevance.
- [ ] **Docs + guides.** Long-form usage guides beyond the README/JSDoc; broader edge-case and
      driver-quirk coverage.

## Already strong (keep the edge)

- Isomorphic: same model/query code in memory, IndexedDB, server SQL/Mongo, over HTTP/WS, and offline.
- Client/server is a backend swap; the transport *is* the `Backend` contract.
- Offline-first sync built in (HLC, tombstones, durable outbox).
- Row-level security as a query-rewriting decorator, uniform across transports.
- No codegen — pure TS inference.
- Push-down with an in-memory reference fallback ("no silent O(n) cliff"), including across the wire.
