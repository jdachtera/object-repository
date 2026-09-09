/**
 * `object-repository/migrations` — portable, version-gated schema migrations.
 *
 * See `types.ts` for the design: a serializable operation IR, one reference executor that defines the
 * semantics on every backend, and an expand/contract split that withholds destructive operations until
 * the deployment raises `minSupportedSchemaVersion`.
 */
export type {
  DeferredContract,
  MigrateOptions,
  Migration,
  MigrationBlocker,
  MigrationBlockerCode,
  MigrationBuilder,
  MigrationOp,
  MigrationPlan,
  MigrationProgress,
  MigrationReport,
  MigrationWarning,
  MigrationWarningCode,
  Phase,
  PhasedOps,
  PlanStep,
  RecordTransform,
  StoredType
} from "./types.ts";

export {
  MigrationBlockedError,
  MigrationNotSupportedError,
  SchemaUnknownError,
  SchemaVersionError
} from "./errors.ts";

export { OpRecorder, classify, isWidening, splitPhases, phaseOps, downOps, opsHash, assertNoNarrowingRetype } from "./ops.ts";
export { coerce } from "./coerce.ts";
export { applyOp, type ExecuteOptions, type OpResult } from "./execute.ts";
export { pageByUuid, everything, BY_UUID, type Page } from "./paging.ts";

export { runMigrations, rollbackMigrations, gateOpen, type RunnerOptions } from "./run.ts";
export {
  BackendJournal,
  MIGRATION_LOG_MODEL,
  SCHEMA_STATE_MODEL,
  SCHEMA_STATE_ID,
  indexRows,
  rowId,
  type JournalRow,
  type MigrationJournal,
  type SchemaState
} from "./journal.ts";
export { planMigrations, formatPlan } from "./plan.ts";
