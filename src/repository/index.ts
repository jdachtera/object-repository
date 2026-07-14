/**
 * The repository layer: typed model definitions over the property, expression, and backend
 * layers (ARCHITECTURE.md §5). This is the usable surface — `new RepositoryManager().define(...)`.
 */
export { Repository } from "./Repository.ts";
export type { Model } from "./Repository.ts";
export { RepositoryManager } from "./RepositoryManager.ts";
export type { RepositoryManagerOptions, DefineConfig, TransactionScope } from "./RepositoryManager.ts";
export { QueryCollection } from "./QueryCollection.ts";
export type { Queryable, Page, ReadOptions } from "./QueryCollection.ts";
export { liveQuery } from "./liveQuery.ts";
export type { LiveQuery, LiveState } from "./liveQuery.ts";
export { SOFT_DELETE_FIELD } from "./RepositoryManager.ts";
export type { TimestampProperties, SoftDeleteProperties } from "./RepositoryManager.ts";
export type { SoftDeleteConfig } from "./Repository.ts";
export type { Selection, InferSelection } from "./projection.ts";
export { QueryCache } from "./QueryCache.ts";
export type { AggregateExpr, Aggregators, NumericKey, NumericInput } from "./aggregate.ts";
// Patch field-operation builders are namespaced as `op` (op.set/op.inc/op.mul) so `op.mul`
// doesn't collide with the value-expression `mul`.
export * as op from "./patch.ts";
export { normalizePatch, applyPatch } from "./patch.ts";
export type { PatchSpec } from "./patch.ts";
export { defineFactory, sequence } from "./factory.ts";
export type { Factory, FactoryOptions, FactoryInput, FactoryField, BuildContext } from "./factory.ts";
