/**
 * A versioned, runnable migration flow for the columnar SQL backends (ARCHITECTURE.md §3;
 * PRODUCTION_ROADMAP.md "Full migrations").
 *
 * A `Migration` names an ordered schema change; its `up` (and optional `down`) receive a
 * `SchemaBuilder` that records dialect-specific DDL — create/drop table, add/drop/rename/retype
 * column, create/drop index — plus a raw `sql()` escape hatch for data backfills. `runMigrations`
 * applies every not-yet-applied migration in array order, each inside one transaction (where the
 * engine supports transactional DDL), and records it in a `_object_repository_migrations` tracking table so a
 * re-run is a no-op. `rollbackMigrations` reverts the most recently applied ones via their `down`.
 *
 * Note: MySQL implicitly commits on DDL, so a migration that fails midway there can leave partial
 * schema changes — prefer one structural change per migration and keep `sql()` backfills idempotent.
 */
import type { FieldSpec } from "../../core/Backend.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./SqlBackend.ts";

/** The tracking table that records which migrations have been applied. */
export const MIGRATIONS_TABLE = "_object_repository_migrations";

/**
 * Records schema operations as dialect SQL. Field-type arguments are the ORM's stored-type tags
 * (`text` / `integer` / `boolean` / `date` / …), mapped to native column types by the dialect — the
 * same vocabulary `define` uses, so a migration never hard-codes engine types.
 */
export interface SchemaBuilder {
  /** Create a model's columnar table (uuid PK, one column per field, `_extra` overflow), if absent. */
  createTable(model: string, fields: FieldSpec[]): void;
  /** Drop a model's table. */
  dropTable(model: string): void;
  /** Add a column for a newly-declared field. */
  addColumn(model: string, name: string, type: string): void;
  /** Drop a column. */
  dropColumn(model: string, name: string): void;
  /** Rename a column. */
  renameColumn(model: string, from: string, to: string): void;
  /** Change a column's stored type. */
  alterColumnType(model: string, name: string, type: string): void;
  /** Create a secondary index. `columnTypes` (column → stored-type tag, e.g. `{ email: "text" }`) lets
   *  MySQL add a key-length prefix to a TEXT-backed column, which it can't index whole; omit it for
   *  numeric/short-varchar columns (Postgres ignores it). */
  createIndex(model: string, name: string, columns: string[], unique?: boolean, columnTypes?: Record<string, string>): void;
  /** Drop a secondary index. */
  dropIndex(model: string, name: string): void;
  /** Raw statement escape hatch for data backfills — written in the dialect's own placeholder style. */
  sql(statement: string, params?: unknown[]): void;
}

/** One ordered schema change. `name` is unique; array position is the order. */
export interface Migration {
  name: string;
  up(builder: SchemaBuilder): void | Promise<void>;
  /** Inverse of `up`, for `rollbackMigrations`. A migration without one can't be rolled back. */
  down?(builder: SchemaBuilder): void | Promise<void>;
}

/** What a migrate/rollback run did. `skipped` were already applied (migrate) or had no `down` (rollback). */
export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

/** Optional capability: apply/rollback a versioned migration set. Implemented by the SQL backends. */
export interface MigratableBackend {
  migrate(migrations: Migration[]): Promise<MigrationReport>;
  rollback(migrations: Migration[], count: number): Promise<MigrationReport>;
}

/** Narrow a backend to the migratable interface. */
export function isMigratable(backend: object): backend is MigratableBackend {
  return (
    typeof (backend as Partial<MigratableBackend>).migrate === "function" &&
    typeof (backend as Partial<MigratableBackend>).rollback === "function"
  );
}

interface Statement {
  sql: string;
  params: unknown[];
}

/** Accumulates a migration's operations as finalized SQL statements to run in order. */
class Recorder implements SchemaBuilder {
  readonly statements: Statement[] = [];

  constructor(private readonly dialect: SqlDialect) {}

  private ddl(sql: string): void {
    this.statements.push({ sql: this.dialect.finalize(sql), params: [] });
  }

  createTable(model: string, fields: FieldSpec[]): void {
    this.ddl(this.dialect.createTable(model, fields));
  }
  dropTable(model: string): void {
    this.ddl(this.dialect.dropTable(model));
  }
  addColumn(model: string, name: string, type: string): void {
    this.ddl(this.dialect.addColumn(model, name, this.dialect.columnType(type)));
  }
  dropColumn(model: string, name: string): void {
    this.ddl(this.dialect.dropColumn(model, name));
  }
  renameColumn(model: string, from: string, to: string): void {
    this.ddl(this.dialect.renameColumn(model, from, to));
  }
  alterColumnType(model: string, name: string, type: string): void {
    this.ddl(this.dialect.alterColumnType(model, name, this.dialect.columnType(type)));
  }
  createIndex(model: string, name: string, columns: string[], unique = false, columnTypes?: Record<string, string>): void {
    this.ddl(this.dialect.createIndex(model, name, columns, unique, columnTypes ? new Map(Object.entries(columnTypes)) : undefined));
  }
  dropIndex(model: string, name: string): void {
    this.ddl(this.dialect.dropIndex(model, name));
  }
  sql(statement: string, params: unknown[] = []): void {
    // Raw backfill: run verbatim (the caller writes placeholders in the target dialect's style).
    this.statements.push({ sql: statement, params });
  }
}

/** `CREATE TABLE _object_repository_migrations (name <id> PRIMARY KEY, applied_at <bigint>)` for this dialect.
 *  The name PK uses the bounded identifier type (`text` on Postgres, `varchar(64)` on MySQL) — MySQL
 *  can't index an unbounded TEXT column without a key length, so a short-identifier column is correct. */
function trackingDdl(dialect: SqlDialect): string {
  return `CREATE TABLE IF NOT EXISTS ${dialect.ref(MIGRATIONS_TABLE)} (${dialect.column("name")} ${dialect.columnType(
    "uuid"
  )} PRIMARY KEY, ${dialect.column("applied_at")} ${dialect.columnType("integer")})`;
}

/** Ensure the tracking table exists and return the set of already-applied migration names. */
async function appliedNames(exec: SqlExecutor, dialect: SqlDialect): Promise<Set<string>> {
  // Introspect first, then create only when absent — re-running `CREATE TABLE IF NOT EXISTS` upsets
  // some engines/emulators (pg-mem), and this is on the hot path of every migrate/rollback call.
  const probe = dialect.columnsQuery(MIGRATIONS_TABLE);
  const existing = await exec.run(probe.sql, probe.params);
  if (existing.length === 0) await exec.run(trackingDdl(dialect), []);
  const rows = await exec.run(`SELECT ${dialect.column("name")} AS name FROM ${dialect.ref(MIGRATIONS_TABLE)}`, []);
  return new Set(rows.map((r) => String(r.name)));
}

/** Reject duplicate migration names — they'd make the tracking table ambiguous. */
function assertUniqueNames(migrations: Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.name)) throw new Error(`Duplicate migration name: ${JSON.stringify(migration.name)}`);
    seen.add(migration.name);
  }
}

/** Run `statements`, then the tracking write, atomically where the engine supports transactional DDL. */
async function runAtomically(exec: SqlExecutor, statements: Statement[], track: Statement): Promise<void> {
  const work = async (e: SqlExecutor) => {
    for (const statement of statements) await e.run(statement.sql, statement.params);
    await e.run(track.sql, track.params);
  };
  if (exec.transaction) await exec.transaction(work);
  else await work(exec);
}

/** Apply every not-yet-applied migration in order. Idempotent: a second call is a no-op. */
export async function runMigrations(
  exec: SqlExecutor,
  dialect: SqlDialect,
  migrations: Migration[],
  now: () => number
): Promise<MigrationReport> {
  assertUniqueNames(migrations);
  const done = await appliedNames(exec, dialect);
  const insert = dialect.finalize(
    `INSERT INTO ${dialect.ref(MIGRATIONS_TABLE)} (${dialect.column("name")}, ${dialect.column("applied_at")}) VALUES (?, ?)`
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }
    const recorder = new Recorder(dialect);
    await migration.up(recorder);
    await runAtomically(exec, recorder.statements, { sql: insert, params: [migration.name, now()] });
    applied.push(migration.name);
  }
  return { applied, skipped };
}

/** Revert the `count` most-recently-applied migrations (in reverse order) that declare a `down`. */
export async function rollbackMigrations(
  exec: SqlExecutor,
  dialect: SqlDialect,
  migrations: Migration[],
  count: number
): Promise<MigrationReport> {
  assertUniqueNames(migrations);
  const done = await appliedNames(exec, dialect);
  const del = dialect.finalize(`DELETE FROM ${dialect.ref(MIGRATIONS_TABLE)} WHERE ${dialect.column("name")} = ?`);
  const applied: string[] = [];
  const skipped: string[] = [];
  // Walk applied migrations newest-first, in the order they were declared.
  const reversed = [...migrations].reverse().filter((m) => done.has(m.name));
  for (const migration of reversed) {
    if (applied.length >= count) break;
    if (!migration.down) {
      skipped.push(migration.name);
      continue;
    }
    const recorder = new Recorder(dialect);
    await migration.down(recorder);
    await runAtomically(exec, recorder.statements, { sql: del, params: [migration.name] });
    applied.push(migration.name);
  }
  return { applied, skipped };
}
