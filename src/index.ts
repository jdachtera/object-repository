/**
 * Public entry point (`object-repository`) — the **core**, isomorphic surface that carries no server driver code:
 * the core contracts (ARCHITECTURE.md §2), the property layer (§5), the expression language, the
 * Repository/query layer, and the in-memory reference backend plus the dependency-light toolkit for
 * authoring your own backend (`scan`, unique-key helpers).
 *
 * Every server/browser store ships from its own subpath so a bundle only ever pulls the backend it
 * imports — `object-repository/indexeddb`, `object-repository/sqlite`, `object-repository/sql`, `object-repository/postgres`, `object-repository/mysql`, `object-repository/mongo`,
 * `object-repository/decorators`, `object-repository/sync`, `object-repository/transport`, and the Mongo-compat facade `object-repository/compat/mongo`.
 */
export * from "./core/index.ts";
export * from "./properties/index.ts";
export * from "./expressions/index.ts";
export * from "./repository/index.ts";
// The scan-only reference backend + backend-authoring toolkit. All dependency-light and isomorphic —
// no `pg`/`mysql2`/`mongodb`/IndexedDB code reachable from here.
export { InMemoryBackend, UniqueConstraintError } from "./backends/memory/InMemoryBackend.ts";
export { scan, applyOrder, applyPaging } from "./backends/util/scan.ts";
export { uniqueKeySets, uniqueKey, sameBatchConflict } from "./backends/util/unique.ts";
