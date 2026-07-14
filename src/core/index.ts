/**
 * Core contracts for the composable backend architecture.
 *
 * These are the stable seams every layer implements (ARCHITECTURE.md). They are
 * runtime-free type declarations on purpose — the concrete stores, decorators, transports,
 * and sync engine are built against them in later roadmap steps.
 */
export type {
  JsonValue,
  JsonObject,
  Uuid,
  Context,
  Identity,
  Capabilities,
  SortKey,
  Paging
} from "./types.ts";
export { SYSTEM_CONTEXT } from "./types.ts";
export { generateUuid } from "./uuid.ts";

export type {
  ExpressionNode,
  Comparator,
  QueryPlan,
  ValueNode,
  TextMode,
  ArithOp,
  DatePart,
  AggregatePlan,
  AggregateStage,
  AggregateOp,
  AggregateResultRow,
  WindowPlan,
  WindowFn,
  WindowFnKind
} from "./QueryPlan.ts";

export type {
  Backend,
  CompilingBackend,
  PersistResult,
  PersistedChange,
  IndexSpec,
  IndexField,
  FieldSpec,
  SchemaAwareBackend,
  CountingBackend,
  AggregatingBackend,
  WindowingBackend,
  PatchOp,
  PatchingBackend,
  MultiPatchingBackend,
  UpsertingBackend,
  RawQueryable,
  TransactionalBackend,
  ChangeEvent,
  ChangeListener,
  Unsubscribe
} from "./Backend.ts";
export {
  isSchemaAware,
  isCounting,
  isAggregating,
  isWindowing,
  isPatching,
  isMultiPatching,
  isUpserting,
  isRawQueryable,
  isTransactional
} from "./Backend.ts";

export type {
  SyncTarget,
  SyncCursor,
  SyncChange,
  SyncPullResult,
  SyncPushResult,
  ConflictPolicy
} from "./SyncTarget.ts";

export type {
  Transport,
  TransportAdapter,
  WireMethod,
  WireRequest,
  WireResponse,
  WireError,
  WireUnsubscribe
} from "./Transport.ts";
