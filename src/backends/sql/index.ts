/**
 * `object-repository/sql` — the database-agnostic columnar SQL toolkit: the shared `SqlBackend`, the Postgres/MySQL
 * dialects, the migration runner, and the resilience (timeout/retry) executor wrapper. The concrete
 * database presets live in their own subpaths — `object-repository/postgres` and `object-repository/mysql` — so importing one
 * database never pulls the other's preset into the bundle.
 */
export { SqlBackend } from "./SqlBackend.ts";
export type { SqlExecutor, SqlRawQuery, SqlBackendOptions } from "./SqlBackend.ts";
export { postgresDialect, mysqlDialect } from "./dialect.ts";
export type { SqlDialect } from "./dialect.ts";
export { resilientExecutor, TimeoutError } from "./resilience.ts";
export type { ResilienceOptions } from "./resilience.ts";
export { runMigrations, rollbackMigrations, isMigratable, MIGRATIONS_TABLE } from "./migrate.ts";
export type { Migration, SchemaBuilder, MigrationReport, MigratableBackend } from "./migrate.ts";
