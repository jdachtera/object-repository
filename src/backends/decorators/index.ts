/**
 * `object-repository/decorators` — backend-agnostic wrappers that add a cross-cutting concern while preserving the
 * inner backend's `Backend` contract (and its push-down): authorization (`PolicyBackend`), lifecycle
 * hooks (`HooksBackend`), observability (`observe`), and dual-write fan-out (`multiWriteBackend`). Also
 * `copyBackend`, the batched store-to-store migration helper used for zero-downtime cutovers.
 */
export { PolicyBackend, PolicyError } from "./PolicyBackend.ts";
export type { AccessPolicy } from "./PolicyBackend.ts";
export { HooksBackend } from "./HooksBackend.ts";
export type { Hooks } from "./HooksBackend.ts";
export { observe } from "./ObservabilityBackend.ts";
export type { ObservabilityOptions, OperationEvent, Operation } from "./ObservabilityBackend.ts";
export { multiWriteBackend } from "./MultiWriteBackend.ts";
export type { MultiWriteOptions, SecondaryErrorHandler } from "./MultiWriteBackend.ts";
export { copyBackend } from "../util/copy.ts";
export type { CopyOptions, CopyProgress, CopyReport } from "../util/copy.ts";
