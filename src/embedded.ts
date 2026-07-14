/**
 * Convenience entry (`object-repository/embedded`) for a single-process, SQLite-only consumer: the core
 * repository/property/expression layers plus `SQLiteBackend` in one import — not Postgres/MySQL/
 * Mongo/IndexedDB, the policy/hooks/observability decorators, or the transport/sync layers. It's the
 * same code you'd get from `object-repository` + `object-repository/sqlite`, pre-bundled into one graph so an embedded build stays
 * minimal (those other backends are never pulled in, not just tree-shaken away).
 *
 * Grow this file's exports as embedded consumers need more of the library (e.g. `patch`/`upsert` are
 * already exported via the repository layer; add another backend here the same way if one is needed).
 */
export * from "./core/index.ts";
export * from "./properties/index.ts";
export * from "./expressions/index.ts";
export * from "./repository/index.ts";
export { SQLiteBackend } from "./backends/sqlite/SQLiteBackend.ts";
export type { SqliteDatabase, SqliteStatement } from "./backends/sqlite/SQLiteBackend.ts";
