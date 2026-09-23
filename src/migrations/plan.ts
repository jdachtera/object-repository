/**
 * The dry run: what `migrate` would do, and — the question that actually matters before a deploy —
 * what `applyContracts` would destroy right now.
 *
 * Reads the journal and the declared migrations, executes nothing, and writes nothing. Safe to run
 * against production, and cheap enough to belong in CI as the "what does this deploy touch?" gate.
 */
import type { Backend } from "../core/Backend.ts";
import { isMigrationLowering } from "../core/Backend.ts";
import { SYSTEM_CONTEXT } from "../core/types.ts";
import { BackendJournal, indexRows, rowId } from "./journal.ts";
import { OpRecorder, opsHash, splitPhases } from "./ops.ts";
import { assertUniqueNames, gateOpen, type RunnerOptions } from "./run.ts";
import type {
  DeferredContract,
  Migration,
  MigrationBlocker,
  MigrationPlan,
  MigrationWarning,
  PlanStep
} from "./types.ts";

export async function planMigrations(
  backend: Backend,
  migrations: Migration[],
  options: RunnerOptions = {}
): Promise<MigrationPlan> {
  assertUniqueNames(migrations);
  const ctx = options.ctx ?? SYSTEM_CONTEXT;
  const journal = options.journal ?? new BackendJournal(backend, ctx);
  const stored = await journal.readSchemaState();
  const schemaVersion = options.schemaVersion ?? 0;
  const minSupported = options.minSupportedSchemaVersion ?? Math.max(0, schemaVersion - 1);
  const rows = indexRows(await journal.load());

  const steps: PlanStep[] = [];
  const deferred: DeferredContract[] = [];
  const releasable: DeferredContract[] = [];
  const warnings: MigrationWarning[] = [];
  const blockers: MigrationBlocker[] = [];

  for (const migration of migrations) {
    const open = gateOpen(migration, minSupported);
    const recorder = new OpRecorder();
    await migration.up(recorder);
    const phases = splitPhases(recorder.ops, open);
    const bodyHash = opsHash(recorder.ops);

    const expandRow = rows.get(rowId(migration.name, "expand"));
    const contractRow = rows.get(rowId(migration.name, "contract"));
    const expandApplied = expandRow?.status === "applied";

    if (expandApplied && expandRow.opsHash && expandRow.opsHash !== bodyHash) {
      blockers.push({
        code: "CHECKSUM_DRIFT",
        migration: migration.name,
        message: `"${migration.name}" has already been applied, but its operations have changed since.`
      });
    }

    for (const op of phases.expand) {
      steps.push({
        migration: migration.name,
        phase: "expand",
        op,
        status: expandApplied ? "applied" : "pending",
        ...describeLowering(backend, op)
      });
    }

    // Prefer what the journal recorded: the source may have been edited since the expand ran.
    const owed = contractRow?.status === "pending" && contractRow.ops.length ? contractRow.ops : phases.contract;
    const contractApplied = contractRow?.status === "applied";

    for (const op of owed) {
      steps.push({
        migration: migration.name,
        phase: "contract",
        op,
        status: contractApplied ? "applied" : open ? "pending" : "deferred",
        ...describeLowering(backend, op)
      });
    }

    if (!owed.length || contractApplied) continue;

    const outstanding: DeferredContract = {
      migration: migration.name,
      gate: migration.schemaVersion ?? 0,
      minSupported,
      ops: owed,
      reason: `"${migration.name}" has ${owed.length} destructive operation(s) at schema version ${migration.schemaVersion ?? 0}; minSupportedSchemaVersion is ${minSupported}.`
    };
    (open ? releasable : deferred).push(outstanding);

    if (!open && expandApplied) {
      warnings.push({
        code: "COMPAT_WINDOW_OPEN",
        migration: migration.name,
        message: `"${migration.name}" is mid-window: both the old and new shapes are live. Raise minSupportedSchemaVersion to ${migration.schemaVersion ?? 0} once no older reader remains.`
      });
    }
    if (owed.some((op) => op.kind === "rawSql")) {
      warnings.push({
        code: "RAW_SQL_NOT_PORTABLE",
        migration: migration.name,
        message: `"${migration.name}" contains raw SQL, which only runs on a SQL backend.`
      });
    }
  }

  return {
    schema: { schemaVersion, minSupportedSchemaVersion: minSupported },
    stored,
    steps,
    deferred,
    releasable,
    warnings,
    blockers
  };
}

/** Would this op be realized natively, and what would that look like? */
function describeLowering(backend: Backend, op: PlanStep["op"]): Pick<PlanStep, "lowering" | "preview"> {
  if (isMigrationLowering(backend) && backend.previewMigrationOp) {
    const preview = backend.previewMigrationOp(op);
    if (preview.length) return { lowering: "native", preview };
  }
  return { lowering: "generic", preview: [] };
}

/** Render a plan for a human — what runs, what is withheld, and what a release would destroy. */
export function formatPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push(
    `schema version ${plan.schema.schemaVersion}, minSupported ${plan.schema.minSupportedSchemaVersion}` +
      (plan.stored ? ` (store: ${plan.stored.schemaVersion} / ${plan.stored.minSupportedSchemaVersion})` : " (store: empty)")
  );

  const pending = plan.steps.filter((step) => step.status === "pending");
  lines.push("", pending.length ? `Will run ${pending.length} operation(s):` : "Nothing to run.");
  for (const step of pending) {
    lines.push(`  ${step.migration} [${step.phase}] ${describeOp(step.op)}  (${step.lowering})`);
    for (const sql of step.preview) lines.push(`      ${sql}`);
  }

  if (plan.deferred.length) {
    lines.push("", `Withheld by the version gate (${plan.deferred.length}):`);
    for (const item of plan.deferred) lines.push(`  ${item.reason}`);
  }

  if (plan.releasable.length) {
    lines.push("", `DESTRUCTIVE — would run with applyContracts (${plan.releasable.length}):`);
    for (const item of plan.releasable) {
      lines.push(`  ${item.migration}:`);
      for (const op of item.ops) lines.push(`      ${describeOp(op)}`);
    }
  }

  for (const warning of plan.warnings) lines.push("", `warning [${warning.code}] ${warning.message}`);
  for (const blocker of plan.blockers) lines.push("", `BLOCKED [${blocker.code}] ${blocker.message}`);

  return lines.join("\n");
}

function describeOp(op: PlanStep["op"]): string {
  switch (op.kind) {
    case "createModel":
      return `create ${op.model}`;
    case "dropModel":
      return `drop ${op.model}`;
    case "addField":
      return `add ${op.model}.${op.field}: ${op.type}${op.fill === undefined ? "" : ` fill=${JSON.stringify(op.fill)}`}`;
    case "dropField":
      return `drop ${op.model}.${op.field}`;
    case "copyField":
      return `copy ${op.model}.${op.from} → ${op.to}${op.overwrite ? " (overwrite)" : ""}`;
    case "renameField":
      return `rename ${op.model}.${op.from} → ${op.to}`;
    case "retypeField":
      return `retype ${op.model}.${op.field}: ${op.from} → ${op.to}`;
    case "transform":
      return `transform ${op.model} via "${op.transform}"`;
    case "addIndex":
      return `add index ${op.index.name} on ${op.model}${op.index.unique ? " (unique)" : ""}`;
    case "dropIndex":
      return `drop index ${op.index} on ${op.model}`;
    case "rawSql":
      return `raw sql (${op.dialect}): ${op.statement.slice(0, 60)}`;
  }
}
