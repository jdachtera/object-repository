/**
 * PostgreSQL backend (ARCHITECTURE.md §3). A thin adapter: it wraps any `pg`-style client or pool —
 * anything with `query(text, params) => { rows }` (the `pg` `Pool`/`Client`, a serverless Neon
 * client, or `pg-mem`'s adapter) — and hands it to the dialect-driven `SqlBackend`. The library
 * imports no Postgres driver; the caller injects it.
 *
 *   import { Pool } from "pg";
 *   new RepositoryManager({ backend: new PostgresBackend(new Pool({ connectionString })) });
 *
 * Each model is a real columnar table (one typed column per scalar field + a `_extra` JSON overflow
 * column); filters/sort/paging/COUNT and grouped aggregates push down to SQL, with the in-memory
 * reference as the fallback for ops the compiler doesn't yet emit.
 */
import { SqlBackend, type SqlBackendOptions, type SqlExecutor } from "./SqlBackend.ts";
import { postgresDialect } from "./dialect.ts";
import { resilientExecutor, type ResilienceOptions } from "./resilience.ts";

/** The slice of a `pg` client/pool this backend needs (a `Pool` also exposes `connect`). */
export interface PgClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** `pg` `Pool.connect()` — checked out so a transaction runs on one dedicated connection. */
  connect?(): Promise<{ query: PgClient["query"]; release?: () => void }>;
}

export class PostgresBackend extends SqlBackend {
  /** `resilience` adds a per-call timeout + safe retry-with-backoff (reads/transactions) — see `resilientExecutor`.
   *  `options` carries backend-level flags such as `uniquePreCheck`. */
  constructor(client: PgClient, resilience?: ResilienceOptions, options?: SqlBackendOptions) {
    const executor: SqlExecutor = {
      run: async (sql, params) => (await client.query(sql, params)).rows,
      // A pool checks out one connection for the whole transaction; a bare client runs BEGIN/COMMIT
      // on itself. Either way, an error rolls back and re-throws.
      transaction: async (fn) => {
        const pooled = typeof client.connect === "function";
        const conn = pooled ? await client.connect!() : client;
        try {
          await conn.query("BEGIN", []);
          const result = await fn({ run: async (sql, params) => (await conn.query(sql, params)).rows });
          await conn.query("COMMIT", []);
          return result;
        } catch (error) {
          await conn.query("ROLLBACK", []).catch(() => {});
          throw error;
        } finally {
          if (pooled) (conn as { release?: () => void }).release?.();
        }
      }
    };
    super(postgresDialect, resilience ? resilientExecutor(executor, resilience) : executor, options);
  }
}
