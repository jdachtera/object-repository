# Migrations

Schema and data migrations that run on **every** backend, and that never destroy anything without
being told to twice.

Two properties are worth stating up front, because everything else follows from them:

- **A migration is a list of portable operations, not DDL.** One reference implementation defines what
  each operation means using only `query`/`save`/`persist`, so it works on a columnar SQL table, a
  Mongo collection, a browser IndexedDB store and the in-memory reference alike. A backend that can do
  better does — SQL turns a rename into an O(1) `ALTER TABLE … RENAME COLUMN` rather than rewriting
  every row. A backend changes a migration's *cost*, never its effect on your records.
- **`migrate()` only ever adds.** Destructive operations are withheld until you raise a version floor
  *and* explicitly ask for them. They are always reported, never silently skipped.

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

Omit `schema` entirely and everything is ungated — every operation applies immediately, which is the
behaviour that predates this mechanism.

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

The legacy values are re-copied and the column is dropped. Delete the deprecated property from the
model; it has already stopped being provisioned, so the auto-provisioner will not recreate it.

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
| `createModel`, `addField`, `copyField`, `transform` | expand | nothing pre-existing is disturbed |
| `retypeField` (widening) | expand | value-preserving by the type lattice |
| `addIndex` | expand | …unless `unique` |
| `addIndex` with `unique: true` | **contract** | rejects writes an older supported build may legitimately make; on IndexedDB a unique index over already-duplicate data aborts the upgrade transaction and bricks the local database |
| `dropField`, `dropModel`, `dropIndex`, `renameField` | **contract** | destroys the old shape |
| `retypeField` (narrowing) | **refused** | author it as a rename to a new field, which earns a window |
| `sql()` | author-declared, defaults to expand | SQL backends only |

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

The same check runs on the sync path. `SyncBackend` handshakes once per session before its first
exchange and throws `SyncSchemaError` if refused, so a long-offline client discovers it must upgrade
instead of silently trading records neither side understands. A server too old to know the method
answers `UNSUPPORTED_METHOD`, which reads as unchecked — so this can be deployed to either end first.

**Deployment order matters: the server leads.** It must be running the new version, with the floor
still low enough to serve the old clients, before any client updates.

## Concurrency

`migrate()` takes a cooperative lease so two replicas booting together cannot both migrate — the
second gets `MigrationLockedError`. It is a *lease*, not a lock: it expires, so a process that dies
mid-migration does not wedge every future deploy. That also means it is not airtight — a runner that
stalls past the lease can still overlap with its successor. It converts the common accident into a
clear refusal and does not pretend to be a distributed lock.

Run migrations from **one place** — a deploy step, not application startup. Pass `skipLock: true` only
if you already guarantee that.

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
4. **`patch` on a mirrored field.** Patches bypass the property codec layer, so a patch names storage
   directly — patch the legacy field while the window is open.
5. **Field-level sync during a window.** `mergeByField` compares per-field versions independently, so a
   two-writer merge can briefly pick the legacy half from one replica and the canonical half from
   another. It self-heals on the next full write through the Repository, but it is not atomic.
6. **A runner that stalls past its lease.** The lease expires so a dead process cannot wedge deploys,
   which means a *very* slow one can still overlap with its successor. Run migrations from one place.
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
await orm.rollback(migrations);          // the most recent migration with a `down`
```

Walks the order migrations were actually applied in, not declaration order — the array may have been
reshuffled since. Refuses a migration whose applied operations destroyed data `down` cannot restore: a
bare drop, but pointedly *not* a rename, whose values live on under the new name.

Prefer rolling forward in production. `down` is most useful in development.
