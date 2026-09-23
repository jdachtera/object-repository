/**
 * The migration journal: what has run, and what is waiting on the version gate.
 *
 * Keyed by `(name, phase)` rather than by migration name, because the two halves of one migration run
 * at different times — often months apart. When a migration's expand phase runs, its contract ops are
 * serialized into a **pending** contract row. That is what lets a deferred contract survive the
 * developer editing, reordering or outright deleting the migration afterwards: the store remembers
 * the destructive work it still owes, independent of the source.
 *
 * What is *not* stored is whether a contract is releasable. That is recomputed on every run from the
 * journal plus the declared `minSupportedSchemaVersion`, so there are never two sources of truth to
 * disagree, and nothing to garbage-collect when the gate moves.
 *
 * Two implementations share this interface. `BackendJournal` writes reserved models through the plain
 * `Backend` seam, so it works on every store including the schemaless ones. The SQL backends use a
 * real table instead (`src/backends/sql/journal.ts`), which is also where the upgrade path for
 * already-deployed tracking tables lives.
 */
import type { Backend } from "../core/Backend.ts";
import { isSchemaAware } from "../core/Backend.ts";
import type { Context, JsonObject } from "../core/types.ts";
import { everything, pageByUuid } from "./paging.ts";
import type { MigrationOp, Phase } from "./types.ts";

/** Reserved model holding one row per `(migration, phase)`. */
export const MIGRATION_LOG_MODEL = "_object_repository_migration_log";
/** Reserved model holding the single schema-version row. */
export const SCHEMA_STATE_MODEL = "_object_repository_schema_state";
/** The one row in `SCHEMA_STATE_MODEL`. */
export const SCHEMA_STATE_ID = "__schema__";

/**
 * A phase's journal entry.
 *
 * `status` is the whole state machine: an `applied` row means the work is done, a `pending` contract
 * row means the ops in `ops` are owed but withheld by the gate.
 */
export interface JournalRow {
  name: string;
  phase: Phase;
  status: "applied" | "pending";
  /** The migration's declared `schemaVersion`; `0` marks a row that predates gating. */
  version: number;
  /** The ops still owed — populated only on a pending contract row. */
  ops: MigrationOp[];
  /** Content hash of the phase's ops when it was recorded, for detecting an edit after the fact. */
  opsHash: string;
  /** Keyset resume position for an interrupted pass, or `null`. */
  cursor: string | null;
  appliedAt: number;
}

export interface SchemaState {
  schemaVersion: number;
  minSupportedSchemaVersion: number;
}

export interface MigrationJournal {
  load(): Promise<JournalRow[]>;
  write(row: JournalRow): Promise<void>;
  /** Forget a phase entirely — a rollback un-applies it, rather than leaving a misleading row. */
  remove(name: string, phase: Phase): Promise<void>;
  readSchemaState(): Promise<SchemaState | null>;
  writeSchemaState(state: SchemaState): Promise<void>;
}

/**
 * The composite `(name, phase)` key, flattened into the single `uuid` every backend indexes.
 *
 * Deliberately a fixed-width hash rather than the name itself. The id lands in a backend's key column,
 * which has two hard limits the name can violate: PostgreSQL rejects a NUL byte anywhere in text (so no
 * control-character separator), and MySQL's key column is `varchar(64)` (so no unbounded name). Three
 * independently-seeded FNV-1a passes give 96 bits — collisions among a project's migration names are
 * not merely unlikely but *checked*: `validateMigrationNames` refuses a declared set in which two names
 * share an id, before anything runs. The readable name is stored alongside, in its own column.
 */
export const rowId = (name: string, phase: Phase): string => `${nameHash(name)}-${phase === "expand" ? "e" : "c"}`;

function nameHash(name: string): string {
  const pass = (seed: number): string => {
    let hash = seed;
    for (let i = 0; i < name.length; i++) {
      hash ^= name.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return pass(0x811c9dc5) + pass(0x01000193) + pass(0x050c5d1f);
}

/** The longest migration name accepted — comfortably inside every backend's text column. */
export const MAX_MIGRATION_NAME_LENGTH = 255;

/**
 * Refuse a migration set whose names could not be journalled faithfully — checked before *anything*
 * runs, because discovering it at the journal write means the migration's operations already ran and
 * the store now holds work it has no record of.
 */
export function validateMigrationNames(names: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`Migration names must be non-empty strings; got ${JSON.stringify(name)}.`);
    }
    if (name.length > MAX_MIGRATION_NAME_LENGTH) {
      throw new Error(`Migration name ${JSON.stringify(name.slice(0, 40))}… exceeds ${MAX_MIGRATION_NAME_LENGTH} characters.`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error(`Migration name ${JSON.stringify(name)} contains a control character.`);
    }
    const id = nameHash(name);
    const clash = seen.get(id);
    if (clash !== undefined && clash !== name) {
      throw new Error(`Migration names ${JSON.stringify(clash)} and ${JSON.stringify(name)} share a journal id; rename one.`);
    }
    seen.set(id, name);
  }
}

/**
 * A journal stored as ordinary records through the `Backend` interface.
 *
 * Deliberately *not* routed through a private `RepositoryManager`: that would make the migration layer
 * import the repository layer, which already imports it, and the rows are flat JSON that needs no
 * property codec anyway.
 */
export class BackendJournal implements MigrationJournal {
  constructor(
    private readonly backend: Backend,
    private readonly ctx: Context
  ) {}

  private async ensureModels(): Promise<void> {
    if (!isSchemaAware(this.backend)) return;
    await this.backend.registerModel(MIGRATION_LOG_MODEL, [], LOG_FIELDS);
    await this.backend.registerModel(SCHEMA_STATE_MODEL, [], STATE_FIELDS);
  }

  async load(): Promise<JournalRow[]> {
    await this.ensureModels();
    const rows: JournalRow[] = [];
    for await (const page of pageByUuid(this.backend, MIGRATION_LOG_MODEL, everything(), 500, this.ctx)) {
      for (const row of page.rows) rows.push(decodeRow(row));
    }
    return rows;
  }

  async write(row: JournalRow): Promise<void> {
    await this.ensureModels();
    this.backend.save(MIGRATION_LOG_MODEL, encodeRow(row), this.ctx);
    await this.backend.persist(this.ctx);
  }

  async remove(name: string, phase: Phase): Promise<void> {
    await this.ensureModels();
    this.backend.remove(MIGRATION_LOG_MODEL, { uuid: rowId(name, phase) }, this.ctx);
    await this.backend.persist(this.ctx);
  }

  async readSchemaState(): Promise<SchemaState | null> {
    await this.ensureModels();
    const rows = await this.backend.query(
      { model: SCHEMA_STATE_MODEL, where: everything(), order: [], paging: { start: 0 } },
      this.ctx
    );
    const row = rows.find((candidate) => String(candidate.uuid) === SCHEMA_STATE_ID);
    if (!row) return null;
    return {
      schemaVersion: Number(row.schemaVersion ?? 0),
      minSupportedSchemaVersion: Number(row.minSupportedSchemaVersion ?? 0)
    };
  }

  async writeSchemaState(state: SchemaState): Promise<void> {
    await this.ensureModels();
    this.backend.save(
      SCHEMA_STATE_MODEL,
      { uuid: SCHEMA_STATE_ID, schemaVersion: state.schemaVersion, minSupportedSchemaVersion: state.minSupportedSchemaVersion },
      this.ctx
    );
    await this.backend.persist(this.ctx);
  }
}

/** Column layout for the reserved models, so a columnar backend builds real columns for them too. */
const LOG_FIELDS = [
  { name: "name", type: "text" },
  { name: "phase", type: "text" },
  { name: "status", type: "text" },
  { name: "version", type: "integer" },
  { name: "ops", type: "text" },
  { name: "opsHash", type: "text" },
  { name: "cursor", type: "text" },
  { name: "appliedAt", type: "integer" }
];

const STATE_FIELDS = [
  { name: "schemaVersion", type: "integer" },
  { name: "minSupportedSchemaVersion", type: "integer" },
  // The migration lease shares this reserved model — see `acquireLock`.
  { name: "owner", type: "text" },
  { name: "expiresAt", type: "integer" }
];

/** Ops are stored as a JSON string, so the row stays flat and every backend can hold it as text. */
export function encodeRow(row: JournalRow): JsonObject {
  return {
    uuid: rowId(row.name, row.phase),
    name: row.name,
    phase: row.phase,
    status: row.status,
    version: row.version,
    ops: JSON.stringify(row.ops),
    opsHash: row.opsHash,
    cursor: row.cursor,
    appliedAt: row.appliedAt
  };
}

export function decodeRow(row: JsonObject): JournalRow {
  return {
    name: String(row.name),
    phase: String(row.phase) as Phase,
    status: row.status === "pending" ? "pending" : "applied",
    version: Number(row.version ?? 0),
    ops: parseOps(row.ops),
    opsHash: String(row.opsHash ?? ""),
    cursor: row.cursor === null || row.cursor === undefined ? null : String(row.cursor),
    appliedAt: Number(row.appliedAt ?? 0)
  };
}

function parseOps(value: unknown): MigrationOp[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as MigrationOp[]) : [];
  } catch {
    // A corrupt ops payload must not make the journal unreadable: an owed contract with no
    // recoverable ops is reported as drift by the runner rather than crashing the whole run.
    return [];
  }
}

/** The lock row's id in `SCHEMA_STATE_MODEL`. */
export const LOCK_ID = "__lock__";

/** How long a held lock stays valid before another runner may assume its holder died. */
export const LOCK_LEASE_MS = 5 * 60_000;

/**
 * A cooperative lease preventing two runners from migrating the same store at once.
 *
 * Two replicas booting together both read the same pending set and both act on it. For an expand
 * that is mostly survivable — the operations are idempotent — but a contract release is a genuine
 * race, and concurrent DDL against one table is not something to leave to luck.
 *
 * Deliberately a *lease*, not a lock: a process that dies mid-migration must not wedge every future
 * deploy, so the claim expires. That makes this cooperative rather than airtight — a runner that
 * stalls past the lease can still overlap with its successor. It converts the common accident (two
 * replicas booting together) into a clear refusal, and does not pretend to be a distributed lock.
 */
export async function acquireLock(
  backend: Backend,
  ctx: Context,
  now: () => number,
  owner: string
): Promise<{ release(): Promise<void> } | null> {
  // Register first: the lease lives in a reserved model, and querying it before a schema-aware
  // backend knows its shape would provision it column-less.
  if (isSchemaAware(backend)) await backend.registerModel(SCHEMA_STATE_MODEL, [], STATE_FIELDS);
  const rows = await backend.query(
    { model: SCHEMA_STATE_MODEL, where: everything(), order: [], paging: { start: 0 } },
    ctx
  );
  const held = rows.find((row) => String(row.uuid) === LOCK_ID);
  const expires = held ? Number(held.expiresAt ?? 0) : 0;
  if (held && expires > now()) return null; // someone else holds a live lease

  backend.save(SCHEMA_STATE_MODEL, { uuid: LOCK_ID, owner, expiresAt: now() + LOCK_LEASE_MS }, ctx);
  await backend.persist(ctx);

  // Read back: if another runner claimed it in the same instant, the last write wins and only that
  // owner proceeds. Cheap, and it closes the obvious both-saw-it-free window.
  const confirm = await backend.query(
    { model: SCHEMA_STATE_MODEL, where: everything(), order: [], paging: { start: 0 } },
    ctx
  );
  const mine = confirm.find((row) => String(row.uuid) === LOCK_ID);
  if (!mine || String(mine.owner) !== owner) return null;

  return {
    release: async () => {
      backend.remove(SCHEMA_STATE_MODEL, { uuid: LOCK_ID }, ctx);
      await backend.persist(ctx);
    }
  };
}

/** Index the journal by `(name, phase)` for the runner's state machine. */
export function indexRows(rows: JournalRow[]): Map<string, JournalRow> {
  return new Map(rows.map((row) => [rowId(row.name, row.phase), row]));
}
