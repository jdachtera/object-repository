/**
 * `object-repository/sqlite` — the compiling SQLite backend (JSON storage + `json_extract` push-down) and its
 * Cloudflare **D1** preset. Both run over the same async-tolerant `SqliteDatabase` seam, so `node:sqlite`
 * on the server and D1 on the edge share one implementation.
 */
export { SQLiteBackend } from "./SQLiteBackend.ts";
export type { SqliteDatabase, SqliteStatement, SqliteWrite, Awaitable } from "./SQLiteBackend.ts";
export { D1Backend } from "./D1Backend.ts";
export type { D1Database, D1PreparedStatement } from "./D1Backend.ts";
