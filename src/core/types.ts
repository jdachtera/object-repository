/**
 * Shared primitive types for the core contracts.
 *
 * These are intentionally dependency-free: every layer (stores, transports, policy,
 * sync) speaks in terms of these so the contracts stay serializable across a process
 * boundary. See ARCHITECTURE.md §2.
 */

/** A value that can survive JSON serialization (the wire format for RPC backends). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Stable, client-mintable record identifier (see ARCHITECTURE.md §9: idempotency). */
export type Uuid = string;

/**
 * Ambient request context threaded through every backend operation.
 *
 * Established by a transport adapter from auth material and consumed by the PolicyBackend
 * for authorization (ARCHITECTURE.md §8). Deliberately part of the signatures from day one —
 * retrofitting context threading later is painful.
 */
export interface Context {
  /** Authenticated principal, if any (null for anonymous / system calls). */
  identity: Identity | null;
  /** Opaque correlation id for tracing a request across layers/transports. */
  requestId?: string;
  /** Free-form scope bag (claims, roles, tenant, ...) for policy decisions. */
  scope?: Readonly<Record<string, JsonValue>>;
}

export interface Identity {
  id: string;
  roles?: readonly string[];
}

/** A system context with no principal — used for migrations, sync internals, tests. */
export const SYSTEM_CONTEXT: Context = { identity: null };

/** Stamped onto stored records to carry their HLC version (ARCHITECTURE.md §9). */
export const VERSION_FIELD = "_version";
/** Marks a soft-deleted (tombstoned) record so a remove can carry a comparable version. */
export const TOMBSTONE_FIELD = "_deleted";
/** Carries the per-field HLC versions in field-level sync (field name → version). */
export const FIELD_VERSIONS_FIELD = "_fieldVersions";

/**
 * Fields a *lower* layer stamps onto a stored record for its own bookkeeping — never model data.
 *
 * They live here, in core, rather than in the sync layer that writes them because the layer above
 * also has to know about them: `Repository.serialize` carries undeclared stored fields forward so a
 * build that doesn't declare a field can't delete it, and these are precisely the fields it must
 * *not* carry forward — their owner rewrites them on every write, so re-emitting a stale one would
 * resurrect a superseded version or a cleared tombstone.
 */
export const RESERVED_RECORD_FIELDS: ReadonlySet<string> = new Set([
  VERSION_FIELD,
  TOMBSTONE_FIELD,
  FIELD_VERSIONS_FIELD
]);

/**
 * The two numbers that gate destructive schema change (ARCHITECTURE.md §13).
 *
 * They move independently and on purpose. A developer bumps `schemaVersion` when they add a migration;
 * an *operator* bumps `minSupportedSchemaVersion` separately, once they know no still-running build
 * and no returning offline client depends on the old shape. Only that second bump lets a contract op
 * run, so shipping a migration and destroying the old data are always two deliberate acts.
 *
 * Deployment-wide rather than per-model: one IndexedDB database has one integer version counter, the
 * migration journal is global, and version skew between a client and a server is a fact about the
 * whole app. Per-*field* granularity — which is what people usually want from per-model versions — is
 * served by marking a property deprecated instead.
 */
export interface SchemaVersioning {
  /** The schema version this build declares. */
  readonly schemaVersion: number;
  /**
   * The oldest version still expected to read and write this store. Defaults to `schemaVersion - 1`,
   * so merely bumping `schemaVersion` never destroys anything on the same deploy.
   */
  readonly minSupportedSchemaVersion?: number;
}

/**
 * What a backend can do natively. The query planner targets the *intersection* of these
 * for the public API and uses the descriptor to *optimize* — pushing predicates down where
 * supported and falling back to in-memory `match()` otherwise (ARCHITECTURE.md §3).
 */
export interface Capabilities {
  /** Can filter on secondary indexes rather than scanning. */
  indexes: boolean;
  /** Supports range predicates (>, <, between) natively. */
  ranges: boolean;
  /** Can apply ordering at the store rather than in memory. */
  sortPushdown: boolean;
  /** Can resolve relations via a native join. */
  joins: boolean;
  /** Supports atomic multi-write transactions. */
  transactions: boolean;
  /**
   * `false` when a schema change commits the open transaction (MySQL): such a transaction can't make
   * a migration phase atomic, so the runner journals its progress page by page instead. Unset: true.
   */
  transactionalDdl?: boolean;
  /** Can emit a server→client change feed (see `Backend.changes`). */
  changeFeed: boolean;
}

export interface SortKey {
  property: string;
  descending: boolean;
}

export interface Paging {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset; `undefined` means "to the end". */
  end?: number;
}
