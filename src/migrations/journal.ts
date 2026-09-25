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
 * `BackendJournal` writes reserved models through the plain `Backend` seam, so it works on every store
 * including the schemaless ones; on SQL the reserved models are ordinary columnar tables. The upgrade
 * path for an already-deployed SQL tracking table is `legacyMigrationNames` plus the runner's adoption.
 */
import type { Backend } from "../core/Backend.ts";
import { isLeasing, isModelProbing, isSchemaAware } from "../core/Backend.ts";
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
 * row means the ops in `ops` are owed but withheld by the gate, and a `pending` expand row means an
 * expand was interrupted part-way — `cursor` says where, so the next run resumes instead of restarting.
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
  /**
   * The same journal, writing through `backend` — a transaction's scope — so a phase's journal rows
   * commit or roll back together with the phase's own writes.
   */
  within?(backend: Backend): MigrationJournal;
  /**
   * Queue `row` without persisting, so the next persist of the journal's backend carries it along with
   * whatever else is queued. The runner stages a resume marker in the same flush as the page it
   * describes, so the two can never disagree.
   */
  stage?(row: JournalRow): Promise<void>;
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
    private readonly ctx: Context,
    /**
     * Only read, never create: a journal the store doesn't have yet reads as empty rather than being
     * provisioned. What `plan()` uses, so it can run with a read-only login and without upgrading an
     * IndexedDB database under other tabs.
     */
    private readonly options: { readOnly?: boolean } = {}
  ) {}

  /**
   * Make `model` readable: false when it isn't there and this journal only reads. Read-only, only
   * `model` itself is registered, so reading one table never provisions the other.
   */
  private async readable(model: string): Promise<boolean> {
    if (!this.options.readOnly) {
      await this.ensureModels();
      return true;
    }
    if (isModelProbing(this.backend) && !(await this.backend.hasModel(model))) return false;
    if (isSchemaAware(this.backend)) {
      await this.backend.registerModel(model, [], model === MIGRATION_LOG_MODEL ? LOG_FIELDS : STATE_FIELDS);
    }
    return true;
  }

  private async ensureModels(): Promise<void> {
    if (!isSchemaAware(this.backend)) return;
    await this.backend.registerModel(MIGRATION_LOG_MODEL, [], LOG_FIELDS);
    await this.backend.registerModel(SCHEMA_STATE_MODEL, [], STATE_FIELDS);
  }

  async load(): Promise<JournalRow[]> {
    if (!(await this.readable(MIGRATION_LOG_MODEL))) return [];
    const rows: JournalRow[] = [];
    for await (const page of pageByUuid(this.backend, MIGRATION_LOG_MODEL, everything(), 500, this.ctx)) {
      for (const row of page.rows) rows.push(decodeRow(row));
    }
    return rows;
  }

  async write(row: JournalRow): Promise<void> {
    await this.stage(row);
    await this.backend.persist(this.ctx);
  }

  async stage(row: JournalRow): Promise<void> {
    await this.ensureModels();
    this.backend.save(MIGRATION_LOG_MODEL, encodeRow(row), this.ctx);
  }

  within(backend: Backend): MigrationJournal {
    return new BackendJournal(backend, this.ctx);
  }

  async remove(name: string, phase: Phase): Promise<void> {
    await this.ensureModels();
    this.backend.remove(MIGRATION_LOG_MODEL, { uuid: rowId(name, phase) }, this.ctx);
    await this.backend.persist(this.ctx);
  }

  async readSchemaState(): Promise<SchemaState | null> {
    if (!(await this.readable(SCHEMA_STATE_MODEL))) return null;
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
    // A corrupt ops payload must not make the journal unreadable. The runner re-derives an owed
    // contract from an unchanged source, and otherwise refuses it as unrecoverable.
    return [];
  }
}

/** The lock row's id in `SCHEMA_STATE_MODEL`. */
export const LOCK_ID = "__lock__";

/** How long a held lock stays valid before another runner may assume its holder died. */
export const LOCK_LEASE_MS = 5 * 60_000;

/** A live runner renews at least this often, so its lease never lapses while it works. */
export const LOCK_RENEW_MS = 60_000;

/** The runner's lease was taken by another runner: it must stop before it does anything else. */
export class MigrationLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationLockedError";
  }
}

/** A held migration lease. */
export interface Lease {
  readonly owner: string;
  /**
   * Prove the lease is still ours and extend it. Writes only when `LOCK_RENEW_MS` has passed since the
   * last renewal, unless `force`. Throws `MigrationLockedError` if another runner has taken it, which
   * is what stops a runner that stalled past its lease from carrying on alongside its successor.
   * `via` renews through a transaction's scope, so the renewal needs no second connection.
   */
  renew(force?: boolean, via?: Backend): Promise<void>;
  /** Give the lease up, only if it is still ours. */
  release(): Promise<void>;
}

/**
 * Claim the lease preventing two runners from migrating the same store at once.
 *
 * A store with the `LeasingBackend` capability claims with one atomic compare-and-set, so two replicas
 * booting together can never both proceed. A store without it falls back to read, write, read back:
 * that catches the common accident but not a true race, so every built-in store implements the
 * capability.
 *
 * It is a *lease*, not a lock: a process that dies mid-migration must not wedge every future deploy,
 * so the claim expires. A live runner renews it as it works (`Lease.renew`), and a runner that finds
 * it has lost the lease stops instead of overlapping with its successor.
 */
export async function acquireLock(
  backend: Backend,
  ctx: Context,
  now: () => number,
  owner: string
): Promise<Lease | null> {
  // Register first: the lease lives in a reserved model, and querying it before a schema-aware
  // backend knows its shape would provision it column-less.
  if (isSchemaAware(backend)) await backend.registerModel(SCHEMA_STATE_MODEL, [], STATE_FIELDS);

  const claim = async (target: Backend = backend): Promise<boolean> =>
    isLeasing(target)
      ? target.acquireLease(SCHEMA_STATE_MODEL, LOCK_ID, owner, now(), LOCK_LEASE_MS, ctx)
      : claimByReadBack(target, ctx, now, owner);

  if (!(await claim())) return null;
  let renewedAt = now();

  return {
    owner,
    renew: async (force = false, via?: Backend) => {
      if (!force && now() - renewedAt < LOCK_RENEW_MS) return;
      if (!(await claim(via))) {
        throw new MigrationLockedError(
          "This runner's migration lease was taken by another runner. Stopping rather than migrating alongside it."
        );
      }
      renewedAt = now();
    },
    release: async () => {
      if (isLeasing(backend)) {
        await backend.releaseLease(SCHEMA_STATE_MODEL, LOCK_ID, owner, ctx);
        return;
      }
      const held = await readLease(backend, ctx);
      if (!held || String(held.owner) !== owner) return; // not ours any more: never free a successor's
      backend.remove(SCHEMA_STATE_MODEL, { uuid: LOCK_ID }, ctx);
      await backend.persist(ctx);
    }
  };
}

/** The fallback for a store with no compare-and-set: read, write, read back. */
async function claimByReadBack(backend: Backend, ctx: Context, now: () => number, owner: string): Promise<boolean> {
  const held = await readLease(backend, ctx);
  if (held && String(held.owner) !== owner && Number(held.expiresAt ?? 0) > now()) return false;
  backend.save(SCHEMA_STATE_MODEL, { uuid: LOCK_ID, owner, expiresAt: now() + LOCK_LEASE_MS }, ctx);
  await backend.persist(ctx);
  const mine = await readLease(backend, ctx);
  return Boolean(mine) && String(mine!.owner) === owner;
}

async function readLease(backend: Backend, ctx: Context): Promise<JsonObject | undefined> {
  const rows = await backend.query(
    { model: SCHEMA_STATE_MODEL, where: everything(), order: [], paging: { start: 0 } },
    ctx
  );
  return rows.find((row) => String(row.uuid) === LOCK_ID);
}

/** Index the journal by `(name, phase)` for the runner's state machine. */
export function indexRows(rows: JournalRow[]): Map<string, JournalRow> {
  return new Map(rows.map((row) => [rowId(row.name, row.phase), row]));
}
