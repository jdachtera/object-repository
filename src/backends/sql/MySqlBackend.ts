/**
 * MySQL backend (ARCHITECTURE.md §3). Wraps any `mysql2`-style connection or pool — anything with
 * `query(sql, params) => [rows, fields]` (the `mysql2/promise` connection/pool, or a PlanetScale
 * client shaped the same way) — and hands it to the dialect-driven `SqlBackend`. No driver is
 * bundled; the caller injects it.
 *
 *   import { createPool } from "mysql2/promise";
 *   new RepositoryManager({ backend: new MySqlBackend(createPool({ uri })) });
 *
 * Each model is a real columnar table (one typed column per scalar field + a `_extra` JSON overflow
 * column); filters/sort/paging/COUNT and grouped aggregates push down to SQL, with the in-memory
 * reference as the fallback for ops the compiler doesn't yet emit.
 */
import { SqlBackend, type SqlBackendOptions, type SqlExecutor } from "./SqlBackend.ts";
import { mysqlDialect } from "./dialect.ts";
import { resilientExecutor, type ResilienceOptions } from "./resilience.ts";

/** The slice of a `mysql2/promise` connection/pool this backend needs. */
export interface MySqlConnection {
  query(sql: string, params: unknown[]): Promise<[Record<string, unknown>[], unknown]>;
  /** `mysql2` pool `getConnection()` — checked out so a transaction runs on one connection. */
  getConnection?(): Promise<MySqlConnection & { beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release?(): void }>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

export class MySqlBackend extends SqlBackend {
  /** `resilience` adds a per-call timeout + safe retry-with-backoff (reads/transactions) — see `resilientExecutor`.
   *  `options` carries backend-level flags such as `uniquePreCheck`. */
  constructor(connection: MySqlConnection, resilience?: ResilienceOptions, options?: SqlBackendOptions) {
    // Only advertise transactions when the driver can start one (mysql2 pool or connection); a bare
    // `{ query }` shim just gets a non-atomic persist.
    const canTransact = typeof connection.getConnection === "function" || typeof connection.beginTransaction === "function";
    const executor: SqlExecutor = {
      run: async (sql, params) => (await connection.query(sql, params))[0],
      transaction: canTransact
        ? async (fn) => {
            const pooled = typeof connection.getConnection === "function";
            const conn = pooled ? await connection.getConnection!() : connection;
            try {
              await conn.beginTransaction!();
              const result = await fn({ run: async (sql, params) => (await conn.query(sql, params))[0] });
              await conn.commit!();
              return result;
            } catch (error) {
              await conn.rollback!().catch(() => {});
              throw error;
            } finally {
              if (pooled) (conn as { release?: () => void }).release?.();
            }
          }
        : undefined
    };
    super(mysqlDialect, resilience ? resilientExecutor(executor, resilience) : executor, options);
  }
}
