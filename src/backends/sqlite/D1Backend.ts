import { SQLiteBackend, type SqliteDatabase, type SqliteStatement, type SqliteWrite } from "./SQLiteBackend.ts";

/**
 * The slice of Cloudflare D1's `D1Database` this backend needs — enough to bind and run statements and
 * to run an atomic `batch`. The real Workers `D1Database` matches this shape; the library imports
 * nothing from `@cloudflare/workers-types`.
 */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}
export interface D1PreparedStatement {
  bind(...params: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

/**
 * A `SQLiteBackend` preset for **Cloudflare D1** — `new D1Backend(env.DB)`. D1 is SQLite, but its
 * driver is *asynchronous* (network-backed) and has no interactive `BEGIN`/`COMMIT`; atomicity comes
 * from `db.batch([...])`. This preset adapts D1's `prepare().bind().all()/run()` binding style and its
 * `batch` onto the backend's async-tolerant `SqliteDatabase` seam, so the whole compiling SQLite
 * backend (JSON storage, `json_extract` push-down, patches, aggregates, windows) runs unchanged on the
 * edge — the same class you use over `node:sqlite` on the server.
 *
 * Because D1 has no interactive transaction, `persist()` still commits atomically (one `batch`), but
 * `upsert()`'s read-then-write is not atomic against a concurrent writer — make the upsert key
 * `unique` so the store rejects a racing duplicate insert.
 */
export class D1Backend extends SQLiteBackend {
  constructor(d1: D1Database) {
    super(D1Backend.adapt(d1));
  }

  /** Map a `D1Database` onto the `SqliteDatabase` seam: bind params per statement, batch = one tx. */
  private static adapt(d1: D1Database): SqliteDatabase {
    const statement = (sql: string): SqliteStatement => ({
      all: async (...params) => (await d1.prepare(sql).bind(...params).all()).results,
      run: (...params) => d1.prepare(sql).bind(...params).run()
    });
    return {
      // DDL runs as a single prepared statement (D1's `exec` is meant for multi-statement imports).
      exec: async (sql) => void (await d1.prepare(sql).run()),
      prepare: statement,
      // D1's only atomicity primitive: run the bound writes as one transaction.
      batchWrite: async (writes: SqliteWrite[]) => void (await d1.batch(writes.map((w) => d1.prepare(w.sql).bind(...w.params)))),
    };
  }
}
