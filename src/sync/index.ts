/**
 * Offline-first sync (ARCHITECTURE.md §9): a composite backend that delegates to a local store and
 * reconciles with a remote `SyncTarget`, ordering concurrent edits with a hybrid logical clock.
 */
export { SyncBackend, lastWriteWins } from "./SyncBackend.ts";
export type { SyncBackendOptions } from "./SyncBackend.ts";
export { InMemorySyncTarget } from "./InMemorySyncTarget.ts";
export { BackendSyncTarget } from "./BackendSyncTarget.ts";
export type { BackendSyncTargetOptions } from "./BackendSyncTarget.ts";
export { RemoteSyncTarget } from "./RemoteSyncTarget.ts";
export { HybridLogicalClock } from "./hlc.ts";
