# Upgrading: portable, version-gated migrations

What changes for an existing application when it takes this release. Most of it is new API you can
ignore until you use it. The items marked **behaviour change** affect code that already works today.

## Behaviour changes

### `PolicyBackend` checks the stored row, at `persist`

Before, a write was authorized only against the record the caller sent, and forwarded at once. A client
over the transport chooses the uuid, so it could overwrite or delete another tenant's row by sending a
record that claimed to be its own.

Now a write is still checked as sent when it is queued, and at `persist` the stored row behind each
uuid must also be visible to the context (under the read filter) and writable by it. A refusal drops
the whole batch. Two consequences:

- A `PolicyError` for a row the context may not touch now surfaces at `persist()`, not at `save()`.
- A write whose `uuid` isn't a string is refused (`PolicyError`), and a remove needs a non-empty string
  uuid. `BackendAdapter` refuses such records at the wire with `INVALID_RECORD`. Every store deletes by
  `String(uuid)`, so a `uuid: ["<another tenant's>"]` used to reach that tenant's row.

### A versioned server checks the schema on every request, and on the change feed

With `schema: { schemaVersion }` on the server's `BackendAdapter`, every request carries the client's
advertisement and is judged by it: `RemoteBackend`, `RemoteSyncTarget` and the command client send it.
A client that sends none counts as version 0. The change feed is judged the same way: `RemoteBackend`
sends its advertisement when it subscribes (a header on the SSE request, a `subscribe` message over a
WebSocket), and a versioned server streams events only to a client it would serve. A server that
declares no version behaves as before.

`RemoteBackend.handshake()` takes the versions as a third argument and, when both ends declare one,
judges compatibility by range rather than by fingerprint equality.

### Migrations treat a stored `null` as unset

`addField` fills a null field, `copyField` fills a null target and copies nothing from a null source,
and `renameField` drops a null source without carrying it. Document stores (Mongo, IndexedDB) used to
treat a stored null as a value; SQL never could (a `NULL` column reads back as absent), so the same
migration left different data depending on the store.

### `migrate()` withholds destructive steps of versioned migrations

A migration with a `schemaVersion` runs its destructive half (drops, overwriting copies, the release of
a rename) only once `minSupportedSchemaVersion` has reached it **and** `applyContracts: true` is passed.
A migration without `schemaVersion` runs whole, as before.

### SQL: MySQL migration phases are journalled page by page

MySQL commits implicitly on DDL, so a phase is no longer wrapped in one transaction there; it records
its progress as it goes and resumes after an interruption. Postgres still runs each phase as one
transaction.

## New, opt-in

- `RepositoryManager({ schema })`, `orm.migrate()`, `orm.plan()` / `formatPlan()`, `orm.rollback()`,
  `orm.refreshSchemaState()`; compatibility windows on properties (`deprecatedSince`, `mirrors`).
- The portable operation set: `createModel`, `dropModel`, `addField`, `dropField`, `renameField`,
  `copyField` (with `overwrite` and `fromType`), `retypeField`, `addIndex`, `dropIndex`, `transform`,
  `sql`.
- `interruptedPage: "reapply" | "skip"` and `MigrationInterruptedError`, for a store that can't commit a
  page with its progress marker.
- Wire: the `migrationState` method (applied migrations, stripped to their renames and drops) for
  clients behind `RemoteBackend`.
- Optional backend capabilities, for custom backends only: `MigrationLoweringBackend`
  (`lowerMigrationOp`, `lowerMigrationOpRecorded`, `previewMigrationOps`), `LeasingBackend`,
  `ModelProbingBackend` (`hasModel`), `JournalSourceBackend`, `SchemaAwareBackend.columnar` and
  `registeredIndexes`, `Capabilities.transactionalDdl`.

## Existing SQL databases

A database migrated under the previous SQL-only mechanism (`_object_repository_migrations`) needs
nothing: its history is adopted into the new journal on the first `migrate()` or `rollback()`, so those
migrations are recognised as applied. Rolling back adopted history requires `rollbackAdopted: true`.

## Before the first production run

Read [Running a migration safely](MIGRATIONS.md#running-a-migration-safely).
