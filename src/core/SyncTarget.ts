import type { Context, JsonObject, Uuid } from "./types.ts";

/**
 * The remote end of a sync relationship (ARCHITECTURE.md §9).
 *
 * Deliberately thinner than `Backend`: most remotes are sync *endpoints*, not ad-hoc query
 * stores. They answer "give me changes since a cursor" and "here are mine" — they do not run
 * arbitrary Expression ASTs. A genuinely queryable server can additionally implement
 * `Backend`, but `SyncTarget` is the minimum a `SyncBackend` needs from its remote.
 */
export interface SyncTarget<_T = JsonObject> {
  /** Pull changes the client has not seen yet, identified by an opaque cursor/checkpoint. */
  pull(cursor: SyncCursor | null, ctx: Context): Promise<SyncPullResult>;

  /** Push the client's queued local changes. Idempotent: replays upsert by uuid (§9). */
  push(changes: SyncChange[], ctx: Context): Promise<SyncPushResult>;
}

/** Opaque, target-defined checkpoint (a server seq, an HLC timestamp, a token, ...). */
export type SyncCursor = string;

export interface SyncChange {
  model: string;
  uuid: Uuid;
  kind: "saved" | "removed";
  record?: JsonObject;
  /** Hybrid logical clock / version stamp for ordering and conflict resolution. */
  version: string;
  /**
   * Per-field HLC versions (field name → version), present only in field-level sync (`fieldLevel`).
   * Lets concurrent edits to *different* fields of the same record both survive: the merge keeps, per
   * field, the value from whichever side has the higher field-version. `version` stays the max, for
   * ordering, tombstone arbitration, and the whole-record fallback when a peer isn't field-level.
   */
  fieldVersions?: Record<string, string>;
}

export interface SyncPullResult {
  changes: SyncChange[];
  /** Cursor to pass to the next `pull`. */
  cursor: SyncCursor;
}

export interface SyncPushResult {
  /** Server-acknowledged uuids; the client may drop these from its outbox. */
  acknowledged: Uuid[];
  /** Changes the server rejected as conflicts, for the client's merge policy to resolve. */
  conflicts: SyncChange[];
}

/**
 * Decides the winner when local and remote disagree. A product decision (LWW / CRDT /
 * server-authoritative), chosen before writing sync code (ARCHITECTURE.md §9).
 */
export type ConflictPolicy = (local: SyncChange, remote: SyncChange) => SyncChange;
