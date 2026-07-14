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
