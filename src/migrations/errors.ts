/**
 * Migration failures, as named error subclasses carrying structured fields — matching
 * `ValidationError` / `PolicyError` / `UniqueConstraintError`, so a caller can branch on the cause
 * instead of matching on a message.
 */
import type { MigrationBlocker, MigrationOp } from "./types.ts";

/**
 * No backend in the stack can perform this operation, and the portable reference can't either (a raw
 * SQL statement against a document store, say).
 *
 * This *throws* rather than being reported and skipped. A silently-skipped destructive op is exactly
 * the failure mode the portable IR exists to eliminate, and a report field most callers never read
 * would reintroduce it.
 */
export class MigrationNotSupportedError extends Error {
  constructor(
    readonly op: MigrationOp,
    readonly backend: string
  ) {
    const target = "model" in op ? ` on "${op.model}"` : "";
    super(`Migration operation "${op.kind}"${target} is not supported by ${backend}.`);
    this.name = "MigrationNotSupportedError";
  }
}

/** The run was refused before touching the store. `blockers` says what must be resolved first. */
export class MigrationBlockedError extends Error {
  constructor(readonly blockers: MigrationBlocker[]) {
    super(`Migration blocked:\n${blockers.map((b) => `  [${b.code}] ${b.message}`).join("\n")}`);
    this.name = "MigrationBlockedError";
  }
}

/**
 * A generic pass would have to write a model whose field layout the runner wasn't given.
 *
 * Writing anyway is worse than failing: against a schema-aware backend that hasn't been told the
 * model's columns, the record lands entirely in the JSON overflow while the typed columns keep their
 * pre-migration values — so a get-by-uuid reads correctly and a filtered query does not.
 */
export class SchemaUnknownError extends Error {
  constructor(readonly model: string) {
    super(
      `No field schema for model "${model}". Pass it via \`options.models\`, or run the migration through a RepositoryManager that defines it.`
    );
    this.name = "SchemaUnknownError";
  }
}

/** The declared schema versions are inconsistent, or older than what the store already records. */
export class SchemaVersionError extends Error {
  constructor(
    readonly schemaVersion: number,
    readonly minSupported: number,
    message: string
  ) {
    super(message);
    this.name = "SchemaVersionError";
  }
}

/**
 * An earlier run was interrupted while writing a page of an op that is not safe to apply twice (a
 * `transform`, or a retype to `json`), on a store that can't commit a page together with its resume
 * marker. The records after `after`, up to and including `through`, may already have the op applied —
 * all, some or none of them. Inspect them, then re-run with `interruptedPage: "reapply"` (none were
 * written) or `"skip"` (all were).
 */
export class MigrationInterruptedError extends Error {
  constructor(
    readonly migration: string,
    readonly op: MigrationOp,
    readonly after: string | null,
    readonly through: string
  ) {
    const model = "model" in op ? ` on "${op.model}"` : "";
    const from = after === null ? "the first record" : `the record after ${JSON.stringify(after)}`;
    super(
      `Migration "${migration}" was interrupted while writing ${op.kind}${model}, which is not safe to apply twice. ` +
        `Records from ${from} through ${JSON.stringify(through)} may or may not have been rewritten. ` +
        `Check them, then re-run with interruptedPage: "reapply" or "skip".`
    );
    this.name = "MigrationInterruptedError";
  }
}
