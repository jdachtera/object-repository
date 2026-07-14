import { defineConfig } from "tsup";

/**
 * One build entry per public `exports` subpath (see package.json). Each backend family ships from its
 * own entry so a consumer's bundler only pulls the store it imports — `object-repository/mongo` never drags in the
 * SQL compiler, `object-repository/postgres` never drags in the MySQL preset, and plain `object-repository` (core) reaches no
 * server-driver code at all. Shared modules (e.g. `SqlBackend`, the expression compiler) are emitted
 * as ESM chunks so they're deduped across entries and still tree-shakeable downstream.
 */
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/backends/indexeddb/index.ts",
    "src/backends/sqlite/index.ts",
    "src/backends/sql/index.ts",
    "src/backends/sql/PostgresBackend.ts",
    "src/backends/sql/MySqlBackend.ts",
    "src/backends/mongo/index.ts",
    "src/backends/decorators/index.ts",
    "src/sync/index.ts",
    "src/transport/index.ts",
    "src/compat/mongo.ts",
    "src/embedded.ts"
  ],
  format: "esm",
  dts: true,
  clean: true
});
