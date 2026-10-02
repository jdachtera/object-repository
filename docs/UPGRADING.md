# Upgrading: portable, version-gated migrations

What changes for an existing application when it takes this release. Most of it is new API you can
ignore until you use it. Everything under **Behaviour changes** affects code that already works today.

## Behaviour changes

### Repositories

- **A save keeps fields the model doesn't declare.** A record loaded with a field the model doesn't
  declare is saved with that field. That field may have been written by a newer build, or by an older
  one during a rolling deploy. Before, the next save dropped it. So deleting a property from a model no
  longer purges its values on the next save. Remove stored data with a migration
  (`m.dropField("User", "ssn")`), which also tells every repository to stop carrying the field.
- **Writes are refused while the manager migrates.** While `orm.migrate()` or `orm.rollback()` runs,
  `save`, `remove`, `persist`, `patch`, `patchWhere`, `upsert` and `transaction` on the same manager's
  repositories throw. The runner shares their backend's write queue. Persist pending writes before
  migrating.

### `PolicyBackend`

- **It checks the stored row at `persist`.** Before, a write was authorized only against the record the
  caller sent. A client over the transport chooses the uuid, so it could overwrite or delete another
  tenant's row by sending a record that claimed to be its own. Now, at `persist`, the stored row behind
  each uuid must also be visible to the context (under the read filter) and writable by it. A refusal
  drops the whole batch. A `PolicyError` for a row the context may not touch now surfaces at
  `persist()`, not at `save()`.
- **The uuid must be a string.** A write whose `uuid` isn't a string is refused (`PolicyError`), and a
  remove needs a non-empty string uuid. Every store deletes by `String(uuid)`, so a
  `uuid: ["<another tenant's>"]` used to reach that tenant's row.
- **`migrate` and `rollback` are optional properties now, not methods.** They exist only when the
  wrapped backend is migratable, so `isMigratable(policyBackend)` reports what the stack can actually
  do. Code that called `policy.migrate(...)` directly needs an `isMigratable(policy)` check first.
  Better still, run migrations through `orm.migrate()`.

### The transport (`BackendAdapter`, `RemoteBackend`)

- **Every server refuses a bad uuid.** It refuses a `persist` whose record has a non-string or empty
  `uuid` (except a fresh save, which gets one) with `INVALID_RECORD`, with or without `PolicyBackend`.
- **Change feeds carry only exposed models.** A server's feed carries only models a client may query:
  none whose name starts with `_`, and only those in `allowedModels` when that is set.
- **A versioned server checks the schema on every request and on the change feed.** With
  `schema: { schemaVersion }` on the server's `BackendAdapter`, every request carries the client's
  advertisement and is judged by it. `RemoteBackend`, `RemoteSyncTarget` and the command client all
  send it, and a client that sends none counts as version 0. `RemoteBackend` also sends its
  advertisement when it subscribes: a header on the SSE request, a `subscribe` message over a
  WebSocket. A versioned server streams events only to a client it would serve. A server that declares
  no version behaves as before. `RemoteBackend.handshake()` takes the versions as a third argument and,
  when both ends declare one, judges compatibility by range rather than by fingerprint equality.
- **Cross-origin SSE needs a CORS change.** After a handshake, the SSE request carries an
  `x-object-repository-schema` header, which makes a browser send a preflight. A cross-origin server
  must list that header in `Access-Control-Allow-Headers`, or the feed won't connect.
- **`WireMethod` has a new member, `"migrationState"`.** A custom adapter that switches exhaustively
  over it needs a case for it.

### Migrations

- **`orm.migrate()` runs on the portable runner.** It keeps a journal and adopts the old table's
  history (see below).
  - It evaluates every declared migration's `up()` on every run, applied ones included, to detect an
    edit after the fact. Keep `up()` free of side effects: it should only describe steps on the builder.
  - The legacy builder aliases (`createTable`, `addColumn`, `createIndex`, …) still work. `m.sql()`
    parameters must be JSON values (`JsonValue[]`), because they are journalled. Pass a `Date` as a
    number or an ISO string.
  - A column type other than the stored types (`text`, `integer`, `float`, `boolean`, `date`, `json`,
    `array`, `scalar`) gets the generic column, as before, except `uuid`, which becomes `text`.
- **A stored `null` counts as unset.** `addField` fills a null field, `copyField` fills a null target
  and copies nothing from a null source, and `renameField` drops a null source without carrying it.
  Document stores (Mongo, IndexedDB) used to treat a stored null as a value. SQL never could, because a
  `NULL` column reads back as absent, so the same migration left different data depending on the store.
- **`migrate()` withholds the destructive steps of versioned migrations.** A migration with a
  `schemaVersion` runs its destructive half (drops, overwriting copies, the release of a rename) only
  once `minSupportedSchemaVersion` has reached it **and** `applyContracts: true` is passed. A migration
  without `schemaVersion` runs whole, as before.
- **MySQL migration phases are journalled page by page.** MySQL commits implicitly on DDL, so a phase
  is no longer wrapped in one transaction there. It records its progress as it goes and resumes after
  an interruption. Postgres still runs each phase as one transaction.
- **`observe()` doesn't time `migrate()`.** The runner works on the innermost store, so a migration
  through `observe(backend)` emits no `migrate`/`rollback` metrics. Time the `orm.migrate()` call itself.

### Stores

- **MySQL refuses a secondary unique-key collision at `persist`.** A save that collides with another
  row on a secondary unique index now throws the driver's duplicate-key error at `persist()`, as
  Postgres does. Before, `ON DUPLICATE KEY UPDATE` silently overwrote the other row. Use
  `uniquePreCheck: true` for a `UniqueConstraintError` instead.
- **SQL emits one change event for repeated saves.** On every SQL store, two saves of the same record
  before one `persist` now produce one change event and one `saved` entry, not two.
- **IndexedDB upgrades for a missing index.** It compares declared indexes, not just object stores,
  with what the database has. A database where an index was declared after the store was created gets
  a version upgrade on the next open to build it. If that index is `unique` and the data already has
  duplicates, the upgrade fails. A tab still running an older build, which doesn't close on
  `versionchange`, blocks the upgrade (`SchemaUpgradeBlockedError`) until it is closed.

## New, opt-in

- `RepositoryManager({ schema })`, `orm.migrate()`, `orm.plan()` / `formatPlan()`, `orm.rollback()`,
  `orm.refreshSchemaState()`, and compatibility windows on properties (`deprecatedSince`, `mirrors`).
- The portable operation set: `createModel`, `dropModel`, `addField`, `dropField`, `renameField`,
  `copyField` (with `overwrite` and `fromType`), `retypeField`, `addIndex`, `dropIndex`, `transform`,
  `sql`.
- `interruptedPage: "reapply" | "skip"` and `MigrationInterruptedError`, for a store that can't commit a
  page with its progress marker.
- On the wire, the `migrationState` method (applied migrations, stripped down to their renames and
  drops) for clients behind `RemoteBackend`.
- Optional backend capabilities, for custom backends only:
  - `MigrationLoweringBackend` (`lowerMigrationOp`, `lowerMigrationOpRecorded`, `previewMigrationOps`)
  - `LeasingBackend`
  - `ModelProbingBackend` (`hasModel`)
  - `JournalSourceBackend`
  - `SchemaAwareBackend.columnar` and `registeredIndexes`
  - `Capabilities.transactionalDdl`

## Existing SQL databases

A database migrated under the previous SQL-only mechanism (`_object_repository_migrations`) has its
history adopted into the new journal on the first `migrate()` or `rollback()`, so those migrations count
as applied. Rolling back adopted history requires `rollbackAdopted: true`.

Adoption happens once, while the new journal is empty, and the new runner never writes the old table.
**Upgrade every process that migrates the store at once.** A migration that an older build (or a direct
`sqlBackend.migrate()`) records in the old table after the first new-style run is not seen, and would
be applied again.

## Before the first production run

Read [Running a migration safely](MIGRATIONS.md#running-a-migration-safely).
