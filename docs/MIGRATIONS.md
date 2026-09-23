# Migrations

Schema and data migrations that run on **every** backend, and that never destroy anything without
being told to twice.

Two properties are worth stating up front, because everything else follows from them:

- **A migration is a list of portable operations, not DDL.** One reference implementation defines what
  each operation means using only `query`/`save`/`persist`, so it works on a columnar SQL table, a
  Mongo collection, a browser IndexedDB store and the in-memory reference alike. A backend that can do
  better does — SQL turns a rename into an O(1) `ALTER TABLE … RENAME COLUMN` rather than rewriting
  every row. A backend changes a migration's *cost*, never its effect on your records.
- **`migrate()` only ever adds.** A versioned migration's destructive operations are withheld until
  you raise a version floor *and* explicitly ask for them, even when the floor is already high enough
  the first time the migration is seen. They are always reported, never silently skipped. (A migration
  with no `schemaVersion` is the exception: it runs whole, as before this mechanism existed.)

## The two numbers

```ts
const orm = new RepositoryManager({
  backend,
  schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 }
});
```

| | who moves it | what it means |
|---|---|---|
| `schemaVersion` | the developer, with each migration | the shape this build writes |
| `minSupportedSchemaVersion` | the operator, separately | the oldest build still expected to read and write this store |

They move independently on purpose. `minSupportedSchemaVersion` defaults to `schemaVersion - 1`, so
shipping a migration and destroying what it replaced are never the same deploy.

Omit `schema` entirely, or leave `schemaVersion` off a migration, and it is ungated. Every operation
applies immediately, in the order written. That is the behaviour that predates this mechanism.

## A rename, end to end

```ts
const migrations = [
  { name: "0012_fullname", schemaVersion: 7,
    up: (m) => m.renameField("User", "name", "fullName", "text") }
];
```

That single call decomposes across two phases:

```
expand    addField(User.fullName)
          copyField(name → fullName, overwrite: false)   ← don't clobber a new-build write
contract  copyField(name → fullName, overwrite: true)    ← adopt what old builds wrote
          dropField(User.name)
```

The contract-side re-copy is the step that matters. Old builds keep writing `name` for the entire
window, so dropping without re-copying first destroys everything they wrote. It is emitted
structurally — there is no way to forget it.

### Deploy timeline

**1. Ship the migration.** `minSupportedSchemaVersion` is still 5, so only the expand runs.

```ts
const report = await orm.migrate(migrations);
report.expanded;   // ["0012_fullname"]
report.deferred;   // [{ migration: "0012_fullname", gate: 7, minSupported: 5, reason: "… drops User.name …" }]
```

Both fields are now in the store. Declare the window on the model so old and new stay in step:

```ts
orm.define({
  name: "User",
  properties: {
    fullName: text(),
    name: text({ deprecatedSince: 7, mirrors: "fullName" })
  }
});
```

Your code uses `fullName`. Queries naming `fullName` find rows an old build wrote. Writes through
`fullName` remain readable by builds that only know `name`.

**2. Wait.** Until every old instance is gone and every offline client has synced. This is the part the
mechanism exists to let you take your time over.

**3. Raise the floor.** Now the contract is *permitted*, but still doesn't run:

```ts
// schema: { schemaVersion: 7, minSupportedSchemaVersion: 7 }
const report = await orm.migrate(migrations);
report.releasable;   // [{ migration: "0012_fullname", … }] — what applyContracts would destroy
report.contracted;   // [] — still nothing destroyed
```

**4. Release it, deliberately.**

```ts
await orm.migrate(migrations, { applyContracts: true });
```

The legacy values are re-copied and the column is dropped. That, not raising the floor, is what
closes the window. Until the release the legacy field is still the authoritative copy, so every write
keeps going to it, and the release's re-copy picks up everything written in between.

Once the contract has run, the process that ran it stops mirroring immediately: reads use the
canonical field, writes stop writing the legacy one, and the legacy column is no longer provisioned. A
process started later learns this from the journal when it first defines the model. A process that was
already running when another one released the contract picks it up with `orm.refreshSchemaState()`,
or on restart. Then delete the deprecated property from the model.

A migration whose gate is open *and* whose contracts are being applied in the same run skips the
split. It runs whole, in the order written, so SQL keeps its O(1) `RENAME COLUMN`. It is reported
under both `expanded` and `contracted`.

### Deleting a migration doesn't cancel what it owes

When the expand runs, the journal records exactly what the contract half still owes. That record, not
the source file, is what gets settled. If the migration is later removed from the array, its debt is
still reported (with `orphaned: true`) and released by `applyContracts` like any other. The one
exception is a debt that runs a record `transform`: its code went with the migration, so releasing it
is refused (`UNRECOVERABLE_CONTRACT`) until the migration is restored.

### Every refusal comes first

Everything a run could refuse is checked before any operation touches the store:

- an edited migration (`CHECKSUM_DRIFT`);
- a narrowing retype;
- an invalid or regressed version;
- an inconsistent journal;
- an unrecoverable debt.

A refused run changes nothing. `plan()` performs the same checks and lists them under `blockers`, so a
clean plan is a run that won't be refused.

## Seeing what a deploy will do

`plan()` reads the store and writes nothing. Safe in production, and worth putting in CI.

```ts
console.log(formatPlan(await orm.plan(migrations)));
```

```
schema version 7, minSupported 5 (store: 7 / 0)

Will run 2 operation(s):
  0012_fullname [expand] add User.fullName: text  (native)
      ALTER TABLE "User" ADD COLUMN "fullName" text
  0012_fullname [expand] copy User.name → fullName  (native)
      UPDATE "User" SET "fullName" = "name" WHERE "fullName" IS NULL AND "name" IS NOT NULL

Withheld by the version gate (1):
  "0012_fullname" drops User.name at schema version 7; minSupportedSchemaVersion is 5.
```

## The operations

| operation | phase | notes |
|---|---|---|
| `createModel`, `addField`, `copyField` | expand | nothing pre-existing is disturbed |
| `copyField` with `overwrite: true` | **contract** | clobbers whatever the target already holds |
| `transform` | **contract** by default | it can delete records or overwrite values. Declare `{ phase: "expand" }` for a pure backfill; an expand transform that tries to delete fails the run instead |
| `retypeField` (widening) | expand | value-preserving by the type lattice |
| `addIndex` | expand | …unless `unique` |
| `addIndex` with `unique: true` | **contract** | rejects writes an older supported build may legitimately make; on IndexedDB a unique index over already-duplicate data aborts the upgrade transaction and bricks the local database |
| `dropField`, `dropModel`, `dropIndex`, `renameField` | **contract** | destroys the old shape |
| `retypeField` (narrowing) | **refused** | add a new field of the new type and convert values with a `transform`. A rename's window can't change a type: both halves must match |
| `sql()` | author-declared, defaults to expand | SQL backends only |

A `transform` rewrites records in place. It may not change a record's `uuid` (the run fails
rather than insert a duplicate); a `uuid` it leaves out is kept. What it changed is found by comparing
each record before and after, so a field it forgot to list in `fields` is still written on every store.
It sees every physical column, including one the model has stopped declaring.

A value converted by a retype, a fill or a typed copy lands as the same stored value on every
store. One that can't be converted exactly (`"abc"` to a number, `3.7` to an integer) fails the run
rather than being stored as a guess.

An operation kind the runtime doesn't recognise classifies as **contract**. Withholding something
harmless is recoverable; running something destructive is not.

## Per-backend support

Every operation works everywhere. This is only about how:

| backend | realized natively | falls back to record rewriting |
|---|---|---|
| Postgres / MySQL | tables, columns, renames, retypes, indexes, `copyField` (one set-based `UPDATE`), `sql()` | `transform`; any field held in the `_extra` JSON overflow (relations, undeclared fields) |
| Mongo | `dropField` (`$unset` via one `updateMany`), `addIndex` | everything else |
| SQLite / D1 | — | everything (it stores JSON blobs, so there is no column layout to alter) |
| IndexedDB | — | everything |
| in-memory | — | everything, deliberately: it is the reference the others are compared against |

## Client and server

A client and server running different builds is the normal state during a rolling deploy — and the
whole reason the gate exists. Both ends declare their versions, and the connection is checked before
any data moves.

```ts
// server
new BackendAdapter(backend, manager.fingerprint(), commands, allowed, maxPage,
  { schemaVersion: 7, minSupportedSchemaVersion: 5 });

// client
await remote.handshake(manager.fingerprint(), ctx, { schemaVersion: 6 });
```

When **both** ends advertise a version, compatibility is judged by range and the schema fingerprint
becomes advisory — during a window the two ends' model definitions differ on purpose, so equality
would refuse precisely the deploy this mechanism makes safe. When either end declares no version, the
fingerprint is all there is and equality still rules, exactly as before.

| situation | result |
|---|---|
| client within `[minSupported, schemaVersion]` | connects |
| client below the floor | `SchemaTooOldError` — the client must upgrade |
| client ahead of the server | `SchemaTooNewError` — deploy the server first; it must lead |
| no versions, shapes differ | `SchemaMismatchError`, as before |
| the same version, shapes differ | `SchemaMismatchError`: a model change without a version bump |
| a version that isn't a non-negative integer (an unset env var read as `NaN`) | refused, `SCHEMA_INVALID` |

`SchemaTooOldError` and `SchemaTooNewError` extend `SchemaMismatchError`, so one `instanceof` catches
every refusal.

**The server enforces it on every request.** The handshake lets a client fail early, but a server that
declares a `schemaVersion` checks the client's advertisement on every request too: `RemoteBackend`
and `RemoteSyncTarget` send it with each one. A client that never shook hands, or one still connected
when a redeploy raised the floor, is refused on its next request. A client that advertises no version
predates versioning and counts as version 0, so a server at version 1 still serves it, and raising the
floor refuses it rather than waving it through. A server that declares no version keeps the advisory
fingerprint check.

The same check runs on the sync path. `SyncBackend` handshakes before its first exchange, and every
pull and push is judged by the server again. A refusal throws `SyncSchemaError` with its `code`, so a
long-offline client finds out it must upgrade instead of silently exchanging records neither side
understands. Only a server too old to know the method (`UNSUPPORTED_METHOD`) reads as unchecked, so
this can be deployed to either end first. Any other failure, such as an authorization error, is an
error, never a pass.

**Deployment order matters: the server leads.** It must be running the new version, with the floor
still low enough to serve the old clients, before any client updates.

## Concurrency

`migrate()` and `rollback()` take a lease so two runners cannot both migrate. The second gets
`MigrationLockedError`. Every built-in store claims the lease with one atomic compare-and-set (the
`LeasingBackend` capability), so two replicas booting in the same instant cannot both read "free" and
both proceed. A store without the capability falls back to read, write and read back. That catches
the common accident but not a true race.

It is a *lease*, not a lock: it expires, so a process that dies mid-migration does not wedge every
future deploy. A live runner renews it as it works, after every page of a record pass and before every
contract. A runner that finds its lease taken stops with `MigrationLockedError` rather than carry on
alongside its successor. Releasing checks the owner, so a late runner can't free its successor's lease.

### Interrupted runs

On a store with real transactions (Postgres, MySQL), each phase's operations and its journal rows
commit together. A failure leaves either the whole phase recorded or none of it. On Postgres the DDL
rolls back with it. MySQL commits DDL implicitly, so there the lowered DDL is written to be safe to
re-run instead: `addField` onto an existing column only fills it, and a repeated index create or drop
is recognised as already done. Migration statements run on the transaction's own connection, outside
the executor's per-statement timeout, so a long backfill can't time out on the client while it
commits on the server.

On other stores, each page of a record pass is persisted together with a resume marker in the journal.
An interrupted pass continues from its last persisted page instead of starting over, so a
non-idempotent `transform` (`price * 100`) is never applied to a record twice. A page that failed part
way is discarded, not committed by whatever persists next.

Run migrations from **one place** — a deploy step, not application startup. Pass `skipLock: true` only
if you already guarantee that.

## Decorated and synced stacks

A migration is maintenance on the store, not an application write, so it runs on the store beneath
every decorator. `migrate()`, `rollback()` and `plan()` unwrap each layer through `migrationTarget()`:

- **`PolicyBackend`, `HooksBackend`, `observe()`** unwrap to what they wrap. Row policy would otherwise
  migrate only the rows the context can see and journal the migration as applied. Hooks would fire
  for every rewritten record.
- **`SyncBackend`** unwraps to its local store. Records are rewritten in place, keeping their
  `_version`, and nothing is queued for push, so a migration never overwrites another replica's offline
  edits. Each replica migrates its own store, and the server migrates its own. The journal, schema
  state and lease (`_object_repository_*`) are local-only: never stamped, pushed or adopted from a pull.
- **`multiWriteBackend`** refuses. Migrating through it would reach the primary alone. Migrate each
  store through its own manager.

A record pass also registers the model without its unique indexes. A unique index is a contract,
created by an explicit `addIndex` behind the gate. Building it as a side effect, over data a later
step is about to de-duplicate, would block that step. The full registration is restored when the run
ends.

## What this does not protect you from

Stated plainly, because a safety mechanism you misunderstand is worse than none.

1. **Writes that bypass the Repository.** Transport-level writes, `copyBackend`, and any direct
   `Backend` use see raw storage. They neither maintain the mirror nor read through it.
2. **A build that declares neither half of a window.** It is protected only by undeclared-field
   preservation, which needs a write baseline — so a blind `createInstance()` + `save()` on a uuid the
   repository has never seen still replaces the record wholesale. Read before you write.
3. **Non-library readers during a window.** The *legacy* column is the source of truth while the window
   is open. BI tools, reporting replicas and hand-written SQL must read that one. `plan()` prints the
   exact field pair. This is the real cost of the design, and it is deliberate.
4. **A process that outlives a migration it didn't run.** Until it calls `orm.refreshSchemaState()`
   or restarts, it keeps mirroring into a legacy field a release dropped. Records it loaded before the
   migration also still carry fields the migration dropped, and a save would write them back. Call
   `refreshSchemaState()` at startup (so it knows where the journal stood) and after every deploy that
   migrates, or restart app servers after one. A process's own `migrate()` and `rollback()` do this for
   it.
5. **Field-level sync during a window.** `mergeByField` compares per-field versions independently, so a
   two-writer merge can briefly pick the legacy half from one replica and the canonical half from
   another. It self-heals on the next full write through the Repository, but it is not atomic.
6. **A runner that stalls past its lease between two renewals.** A runner checks its lease before
   every contract and after every page, and stops once it has lost it. A single page or statement that
   runs longer than the lease (5 minutes) can still overlap with a successor. Run migrations from one
   place.
7. **`unique` on the canonical half of a window.** Refused at `define()`: two constraints over one
   logical value double-report, and the legacy half carries the constraint until the contract runs.
8. **Chained windows** (`a → b` and `b → c` open at once). Refused. Close one before opening the next.

## Upgrading an existing database

Nothing to do. A database migrated under the previous SQL-only mechanism has a populated
`_object_repository_migrations` table; its history is adopted into the journal on the first run, so
those migrations are recognised as applied rather than re-run against live data. The original table is
left untouched as your record.

## Rollback

```ts
await orm.rollback(migrations);          // the most recently applied migration
await orm.rollback(migrations, 2);       // the two most recent, newest first
```

The targets are exactly the `count` most recently applied migrations, by the store's own history
rather than declaration order (the array may have been reshuffled since). Migrations applied in the
same millisecond are ordered by declaration.

If any target can't be reverted safely, the whole rollback is refused before anything runs. It never
skips a target and reverts an older migration instead, underneath the newer one. A target is refused
when:

- it declares no `down`, or is no longer declared at all;
- its window is still open: the contract hasn't run, and the legacy field holds the authoritative
  values that the `down` would overwrite;
- what it ran destroyed data `down` can't restore: a bare drop, but pointedly *not* a rename, whose
  values live on under the new name;
- it was adopted from the legacy tracking table, so what it did isn't recorded. Pass
  `{ rollbackAdopted: true }` to run its `down` anyway.

Prefer rolling forward in production. `down` is most useful in development.
