/**
 * The dry run: what `migrate` would do, and — the question that actually matters before a deploy —
 * what `applyContracts` would destroy right now.
 *
 * Reads the journal and the declared migrations, executes nothing, and writes nothing. Safe to run
 * against production, and cheap enough to belong in CI as the "what does this deploy touch?" gate.
 */
import type { Backend } from "../core/Backend.ts";
import { isMigrationLowering, migrationTarget } from "../core/Backend.ts";
import { SYSTEM_CONTEXT } from "../core/types.ts";
import { BackendJournal, indexRows, rowId } from "./journal.ts";
import { evaluateMigrations } from "./evaluate.ts";
import { assertUniqueNames, checkVersions, readHistory, type RunnerOptions } from "./run.ts";
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
  backend = migrationTarget(backend);
  const ctx = options.ctx ?? SYSTEM_CONTEXT;
  const journal = options.journal ?? new BackendJournal(backend, ctx, { readOnly: true });
  const stored = await journal.readSchemaState();
  const versions = checkVersions(stored, options);
  const minSupported = versions.minSupportedSchemaVersion;
  const { rows } = await readHistory(backend, journal, options.now ?? Date.now);

  // The very evaluation a run performs, so a clean plan is a run that won't be refused.
  const evaluation = await evaluateMigrations(migrations, indexRows(rows), minSupported, options.applyContracts ?? false);
  const blockers: MigrationBlocker[] = [...evaluation.blockers];
  if (versions.error) blockers.unshift({ code: versions.code!, message: versions.error.message });

  const steps: PlanStep[] = [];
  const deferred: DeferredContract[] = [];
  const releasable: DeferredContract[] = [];
  const warnings: MigrationWarning[] = [];

  for (const decision of evaluation.decisions) {
    const name = decision.migration.name;
    const expandRow = indexRows(rows).get(rowId(name, "expand"));
    const expandOps = decision.expand ?? (decision.orphaned ? [] : (expandRow?.ops ?? []));
    for (const op of expandOps) {
      steps.push({
        migration: name,
        phase: "expand",
        op,
        status: decision.expand ? "pending" : "applied",
        lowering: "generic",
        preview: []
      });
    }

    for (const op of decision.owed) {
      steps.push({
        migration: name,
        phase: "contract",
        op,
        status: decision.contract === "run" ? "pending" : "deferred",
        lowering: "generic",
        preview: []
      });
    }

    if (decision.contract === "deferred") deferred.push(decision.outstanding!);
    if (decision.contract === "releasable" || decision.contract === "run") releasable.push(decision.outstanding!);

    if (decision.contract === "deferred" && !decision.expand) {
      warnings.push({
        code: "COMPAT_WINDOW_OPEN",
        migration: name,
        message: `"${name}" is mid-window: both the old and new shapes are live. Raise minSupportedSchemaVersion to ${decision.migration.schemaVersion ?? 0} once no older reader remains.`
      });
    }
    if (decision.owed.some((op) => op.kind === "rawSql")) {
      warnings.push({
        code: "RAW_SQL_NOT_PORTABLE",
        migration: name,
        message: `"${name}" contains raw SQL, which only runs on a SQL backend.`
      });
    }
  }

  await describeLowering(backend, steps);

  return {
    schema: { schemaVersion: versions.schemaVersion, minSupportedSchemaVersion: minSupported },
    stored,
    steps,
    deferred,
    releasable,
    warnings,
    blockers
  };
}

/**
 * Which steps would be realized natively, and what that would look like. Only the steps this run
 * will execute are previewed, in order, against the store's current shape: a withheld contract
 * changes nothing, so its effect must not reach the steps after it.
 */
async function describeLowering(backend: Backend, steps: PlanStep[]): Promise<void> {
  if (!isMigrationLowering(backend) || !backend.previewMigrationOps) return;
  const toRun = steps.filter((step) => step.status === "pending");
  const previews = await backend.previewMigrationOps(toRun.map((step) => step.op));
  toRun.forEach((step, index) => {
    const preview = previews[index] ?? [];
    if (preview.length) {
      step.lowering = "native";
      step.preview = preview;
    }
  });
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
