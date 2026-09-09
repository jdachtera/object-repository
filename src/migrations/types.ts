/**
 * The migration contract: a portable, serializable operation IR with a version-gated expand/contract
 * split (ARCHITECTURE.md §2, §11).
 *
 * Two ideas carry the whole design.
 *
 * **Portability.** A migration is a list of classified, *serializable* operations — not per-dialect
 * DDL. One reference executor written against `Backend.query`/`save`/`persist` defines what each op
 * means, on every store; a backend may lower an op natively (SQL turns a rename into an O(1)
 * `ALTER TABLE ... RENAME COLUMN` instead of rewriting every row). A backend therefore changes a
 * migration's *cost*, never its effect on the record set. This is the same law the query planner
 * lives by, and it is what stops a rename silently no-op'ing on a schemaless store the way SQL-only
 * migrations do.
 *
 * **Destructive changes are withheld.** Every op is classified `expand` (adds capability; nothing
 * pre-existing is disturbed) or `contract` (destroys the old shape). Expand ops apply immediately.
 * A contract op declared at schema version N applies only once the deployment raises
 * `minSupportedSchemaVersion` to N — i.e. once no still-supported reader depends on the old shape.
 * That buys zero-downtime deploys, a safe one-version rollback, and offline clients that keep working
 * until the developer explicitly declares them unsupported.
 *
 * Ops carry no closures: a record transform is named by id and looked up in `Migration.transforms`.
 * That is what lets an op be printed in a plan, hashed for drift detection, and journalled so a
 * deferred contract survives the migration being edited or deleted months later.
 */
import type { FieldSpec, IndexSpec } from "../core/Backend.ts";
import type { ExpressionNode } from "../core/QueryPlan.ts";
import type { Context, JsonObject, JsonValue } from "../core/types.ts";
import type { Expression } from "../expressions/Expression.ts";

/** When an operation may run: `expand` immediately, `contract` only once the version gate opens. */
export type Phase = "expand" | "contract";

/**
 * The ORM's stored-type tags — the same vocabulary `define` uses, mapped to native column types per
 * dialect, so a migration never hard-codes engine types.
 */
export type StoredType = "text" | "integer" | "float" | "boolean" | "date" | "json" | "array" | "scalar";

/**
 * A portable per-record rewrite. Returning `null` removes the record. Receives the *stored* JSON form
 * (below the Repository's encode/decode), so it sees exactly what the backend holds.
 */
export type RecordTransform = (record: Readonly<JsonObject>, model: string) => JsonObject | null;

/**
 * One migration operation. Plain JSON by construction — see the module header for why that matters.
 *
 * `copyField` and `renameField` are separate because a rename decomposes across the two phases: the
 * expand half adds the new field and back-fills it without clobbering, and the contract half re-copies
 * (old writers kept writing the old field for the entire window) before dropping. `renameField` exists
 * only as the fused form emitted when no window was requested, where SQL can do it as pure metadata.
 */
export type MigrationOp =
  | { kind: "createModel"; model: string; fields: FieldSpec[]; indexes?: IndexSpec[] }
  | { kind: "dropModel"; model: string }
  | { kind: "addField"; model: string; field: string; type: StoredType; fill?: JsonValue }
  | { kind: "dropField"; model: string; field: string; closes?: { renamedTo: string } }
  | { kind: "copyField"; model: string; from: string; to: string; type: StoredType; overwrite: boolean }
  | { kind: "renameField"; model: string; from: string; to: string; type: StoredType }
  // `from` is optional because the legacy `alterColumnType` alias cannot state it — it only ever knew
  // the target type. Without it the widening check can't run, so such a retype keeps the legacy
  // behaviour of simply applying; the modern `retypeField` requires `from` and is checked.
  | { kind: "retypeField"; model: string; field: string; from?: StoredType; to: StoredType }
  | { kind: "transform"; model: string; transform: string; fields: string[]; where?: ExpressionNode }
  // `columnTypes` rides alongside rather than inside `IndexSpec`: it exists only so MySQL can add a
  // key-length prefix to a TEXT-backed column, which no other store has an opinion about.
  | { kind: "addIndex"; model: string; index: IndexSpec; columnTypes?: Record<string, string> }
  | { kind: "dropIndex"; model: string; index: string }
  | { kind: "rawSql"; dialect: "postgres" | "mysql" | "*"; statement: string; params: JsonValue[]; phase: Phase };

/** A migration's ops split by phase. The contract half is what the version gate withholds. */
export interface PhasedOps {
  expand: MigrationOp[];
  contract: MigrationOp[];
}

/**
 * Records a migration's operations. `up`/`down` receive one and call methods on it; nothing executes
 * until the runner has the full op list, classified and phased.
 */
export interface MigrationBuilder {
  createModel(model: string, fields: FieldSpec[], indexes?: IndexSpec[]): void;
  dropModel(model: string): void;
  addField(model: string, field: string, type: StoredType, options?: { fill?: JsonValue }): void;
  dropField(model: string, field: string): void;
  /**
   * Sugar for the four-op expand/contract decomposition — see `MigrationOp`. Both halves are emitted
   * structurally; the contract-side re-copy is never optional, because skipping it destroys every
   * value an old writer wrote during the window.
   */
  renameField(model: string, from: string, to: string, type: StoredType): void;
  /** Widening only (e.g. integer → float, anything → json/scalar). Narrowing is refused at plan time. */
  retypeField(model: string, field: string, from: StoredType, to: StoredType): void;
  copyField(model: string, from: string, to: string, type: StoredType, options?: { overwrite?: boolean }): void;
  addIndex(model: string, index: IndexSpec): void;
  dropIndex(model: string, name: string): void;
  /** Portable record rewrite. `transformId` keys into `Migration.transforms`; `fields` is the dirty hint. */
  transform(model: string, transformId: string, fields: string[], where?: Expression): void;
  /** Engine-specific escape hatch. Runs where it can, throws elsewhere. Defaults to the expand phase. */
  sql(statement: string, params?: JsonValue[], options?: { phase?: Phase }): void;

  // --- retained aliases ----------------------------------------------------------------------
  // Every migration written against the original SQL-only builder keeps compiling, and an ungated
  // one still emits byte-identical DDL.
  createTable(model: string, fields: FieldSpec[]): void;
  dropTable(model: string): void;
  addColumn(model: string, name: string, type: string): void;
  dropColumn(model: string, name: string): void;
  renameColumn(model: string, from: string, to: string): void;
  alterColumnType(model: string, name: string, type: string): void;
  createIndex(model: string, name: string, columns: string[], unique?: boolean, columnTypes?: Record<string, string>): void;
  dropIndex(model: string, name: string): void;
}

/** One ordered schema change. `name` is unique; array position is the order. */
export interface Migration {
  name: string;
  /**
   * The schema version this migration belongs to. **Optional**: absent means ungated — every op
   * applies immediately, exactly as before this mechanism existed. Present means its contract ops are
   * withheld until `minSupportedSchemaVersion >= schemaVersion`.
   */
  schemaVersion?: number;
  /** Record transforms referenced by id from `transform` ops, keeping the ops themselves JSON. */
  transforms?: Record<string, RecordTransform>;
  up(builder: MigrationBuilder): void | Promise<void>;
  /** Inverse of `up`, for `rollback`. A migration without one can't be rolled back. */
  down?(builder: MigrationBuilder): void | Promise<void>;
}

export interface MigrateOptions {
  /**
   * Release contracts whose gate has cleared. **Defaults to false** — a bare `migrate()` only ever
   * expands, so a deploy can never destroy data without the operator saying so in as many words.
   */
  applyContracts?: boolean;
  /** Page size for the generic executor's keyset scan. */
  batchSize?: number;
  ctx?: Context;
  onProgress?: (progress: MigrationProgress) => void;
  /**
   * Model schemas the generic executor needs to write correctly through a schema-aware backend.
   * `RepositoryManager.migrate` fills this from its own definitions.
   */
  models?: Record<string, { fields: FieldSpec[]; indexes: IndexSpec[] }>;
  /** Overrides the manager's declared value, for a migration run with no model definitions loaded. */
  minSupportedSchemaVersion?: number;
}

export interface MigrationProgress {
  migration: string;
  phase: Phase;
  op: MigrationOp;
  /** Records rewritten so far by this op (generic passes only; a native lowering reports its total). */
  rows: number;
}

/**
 * What a run did. A superset of the original shape: `applied` and `skipped` keep their exact meanings
 * (migration names), with the phase detail alongside.
 */
export interface MigrationReport {
  applied: string[];
  skipped: string[];
  /** Migrations whose expand phase ran in this call. */
  expanded: string[];
  /** Migrations whose contract phase ran in this call. */
  contracted: string[];
  /** Contracts still withheld by the gate. Never silently empty — this is the whole point. */
  deferred: DeferredContract[];
  /** Contracts the gate now permits, which `applyContracts` would run. Empty once they have run. */
  releasable: DeferredContract[];
}

/** A destructive change the gate is holding back, and exactly why. */
export interface DeferredContract {
  migration: string;
  /** The `schemaVersion` that must be reached — i.e. `migration.schemaVersion`. */
  gate: number;
  minSupported: number;
  ops: MigrationOp[];
  /** Human-readable, e.g. `"0012_fullname" drops User.name at schema version 7; minSupported is 5.` */
  reason: string;
}

export type MigrationWarningCode =
  | "COMPAT_WINDOW_OPEN"
  | "LEGACY_COLUMN_AUTHORITATIVE"
  | "RAW_SQL_NOT_PORTABLE"
  | "DEFERRED_CONTRACT_AGING"
  | "SCHEMA_STILL_DECLARED";

export type MigrationBlockerCode =
  | "STILL_DECLARED"
  | "CHECKSUM_DRIFT"
  | "VERSION_REGRESSION"
  | "SCHEMA_UNKNOWN"
  | "NARROWING_RETYPE";

export interface MigrationWarning {
  code: MigrationWarningCode;
  migration?: string;
  message: string;
}

export interface MigrationBlocker {
  code: MigrationBlockerCode;
  migration?: string;
  message: string;
}

/** One step a run would take, as reported by `plan()`. Reading only — nothing is executed. */
export interface PlanStep {
  migration: string;
  phase: Phase;
  op: MigrationOp;
  status: "pending" | "applied" | "deferred";
  lowering: "native" | "generic";
  /** The rendered native form (e.g. the SQL), for an operator to read. Never executed. */
  preview: string[];
}

/** The dry-run answer to "what will this deploy do, and what would it destroy?". */
export interface MigrationPlan {
  schema: { schemaVersion: number; minSupportedSchemaVersion: number };
  /** What the store currently records, or `null` on a greenfield database. */
  stored: { schemaVersion: number; minSupportedSchemaVersion: number } | null;
  steps: PlanStep[];
  deferred: DeferredContract[];
  /** What `applyContracts: true` would destroy right now. */
  releasable: DeferredContract[];
  warnings: MigrationWarning[];
  blockers: MigrationBlocker[];
}
