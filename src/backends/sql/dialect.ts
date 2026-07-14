/**
 * SQL dialect seam for the server SQL backends (ARCHITECTURE.md §3, §11).
 *
 * The Postgres / MySQL backends store each model in a **real columnar table** — one typed column per
 * scalar field — so filters, sorts, and aggregates reference native columns (no JSON extraction or
 * casts) and secondary indexes are ordinary column indexes. A `SqlDialect` supplies the parts that
 * differ between engines: column types, identifier quoting, placeholder style, and the
 * table / index / upsert / paging DDL.
 */
import type { FieldSpec } from "../../core/Backend.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  return name;
}

/**
 * Guard a LIMIT/OFFSET bound before it is interpolated into SQL. Paging is the one value path that is
 * inlined rather than bound as a `?`/`$n` parameter, so a non-integer (e.g. a stringly-typed offset
 * from an untrusted request) must be rejected here — this is the last line against OFFSET injection,
 * independent of any guard at the query-builder entry point.
 */
function pageBound(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid paging bound: ${JSON.stringify(value)} (expected a non-negative integer)`);
  }
  return value;
}

export interface SqlDialect {
  readonly name: "postgres" | "mysql";
  /** A quoted column reference for a top-level property. */
  column(name: string): string;
  /**
   * Type-preserving JSON extraction from `column` at a dotted `path` — for pushing down `=`/`IN` on a
   * nested field (an embedded subdocument in the `_extra` overflow, or inside a `json()` column). Pair
   * with `jsonValue()`; both sides are compared as JSON so it stays type-exact (`5` ≠ `"5"`).
   */
  jsonExtract(column: string, path: string[]): string;
  /** Placeholder that parses a bound JSON-text param into a comparable JSON value (`?::jsonb` / `CAST(? AS JSON)`). */
  jsonValue(): string;
  /** The SQL column type for a stored-field-type tag (`text`/`integer`/`boolean`/…). */
  columnType(fieldType: string): string;
  /** Concatenate SQL string expressions. */
  concat(parts: string[]): string;
  /**
   * A **case-sensitive** `LIKE` predicate over `column` with a single bound pattern placeholder. The
   * caller guarantees the pattern's metacharacters are intentional (literal `%`/`_`/`\` searches
   * scan-fallback instead), so no `ESCAPE` clause is needed. MySQL forces case sensitivity with
   * `LIKE BINARY` (its default collation is case-insensitive); Postgres `LIKE` is already sensitive.
   */
  likeMatch(column: string): string;
  /** Turn the compiler's `?` placeholders into the engine's form (`$1…` for pg, `?` for mysql). */
  finalize(sql: string): string;
  /** Quoted table reference for use in a statement. */
  ref(model: string): string;
  /** `CREATE TABLE … (uuid, <col type>, …)` if absent. */
  createTable(model: string, fields: FieldSpec[]): string;
  /** `CREATE [UNIQUE] INDEX … ON <table> (<cols>)`. `columnTypes` (name → stored-type tag) lets a
   *  dialect add a key-length prefix to TEXT-backed columns (MySQL); Postgres ignores it. */
  createIndex(model: string, name: string, columns: string[], unique: boolean, columnTypes?: ReadonlyMap<string, string>): string;
  /** `DROP INDEX` — engine-specific (Postgres by name, MySQL scoped to the table). */
  dropIndex(model: string, name: string): string;
  /** Query the existing column names of a table (for additive migration). Rows expose `column_name`. */
  columnsQuery(model: string): { sql: string; params: unknown[] };
  /** `ALTER TABLE <table> ADD COLUMN <col> <type>` — add a newly-declared field to an existing table. */
  addColumn(model: string, name: string, type: string): string;
  /** `DROP TABLE IF EXISTS <table>`. */
  dropTable(model: string): string;
  /** `ALTER TABLE <table> DROP COLUMN <col>`. */
  dropColumn(model: string, name: string): string;
  /** `ALTER TABLE <table> RENAME COLUMN <from> TO <to>`. */
  renameColumn(model: string, from: string, to: string): string;
  /** Change a column's type (`ALTER COLUMN … TYPE` on Postgres, `MODIFY COLUMN` on MySQL). */
  alterColumnType(model: string, name: string, type: string): string;
  /** `INSERT … VALUES (…) ON CONFLICT/DUPLICATE` writing every column, updating on uuid conflict. */
  upsert(model: string, columns: string[]): string;
  /**
   * Multi-row upsert: `rows` value tuples in one statement (params flattened row-by-row). The
   * `VALUES`/insert side always writes every column — that's what makes this correct for a genuine
   * insert too, since `ON CONFLICT`/`ON DUPLICATE KEY` only engages when the uuid already exists.
   * `updateColumns`, when given, restricts *only* the `DO UPDATE SET` list to those columns (dirty-
   * field tracking, ARCHITECTURE.md §12) — omit it for the default "update every column" behavior.
   */
  upsertMany(model: string, columns: string[], rows: number, updateColumns?: string[]): string;
  /** `DELETE … WHERE uuid = <ph>`. */
  deleteByUuid(model: string): string;
  /** `DELETE … WHERE uuid IN (…)` for `count` uuids in one statement. */
  deleteMany(model: string, count: number): string;
  /** `LIMIT/OFFSET` clause (numbers inlined, validated by the caller). */
  paging(limit: number | null, offset: number): string;
  /** Truncate-toward-zero a numeric SQL expression (for the `%` mod formula) — `trunc()` on Postgres,
   *  `truncate(x, 0)` on MySQL (a plain `CAST … AS INTEGER` rounds on both, so it can't be shared). */
  truncate(sql: string): string;
  /** The `NULLS FIRST/LAST` suffix for an `ORDER BY` key so null ordering matches the in-memory
   *  reference (ASC → nulls first, DESC → nulls last). Postgres defaults the other way and needs it
   *  explicit; MySQL already matches and has no such syntax, so it returns "". */
  nullsOrder(descending: boolean): string;
}

const PG_TYPES: Record<string, string> = {
  uuid: "text", // the uuid primary key column type
  text: "text",
  integer: "bigint",
  float: "double precision",
  boolean: "boolean",
  date: "bigint", // epoch milliseconds
  json: "text", // the json() codec already stores a JSON *string*; keep it opaque
  array: "text", // stored as a JSON string (stringify on write, parse on read)
  embedded: "text", // a JSON string too; a nested filter casts it to jsonb for extraction
  scalar: "text"
};

const MYSQL_TYPES: Record<string, string> = {
  uuid: "varchar(64)", // a 32-char uuid PK — indexable directly, no prefix needed
  // `text` is a real MySQL TEXT column (no length cap → never truncates long strings). Because a TEXT
  // column can't be indexed without a key length, an index over it gets a `(255)` prefix in
  // `createIndex` (255×4B < InnoDB's 3072B key limit). Same story for the longtext-backed JSON types.
  text: "text",
  integer: "bigint",
  float: "double",
  boolean: "tinyint(1)",
  date: "bigint",
  json: "longtext",
  array: "longtext",
  embedded: "longtext",
  scalar: "longtext"
};

/** MySQL stored-type tags backed by a TEXT/BLOB column — an index over one needs a key-length prefix. */
const MYSQL_PREFIXED_TYPES = new Set(["text", "json", "array", "embedded", "scalar"]);
/** Chars of an indexed TEXT column MySQL indexes (255×4B utf8mb4 < InnoDB's 3072B key limit). */
const MYSQL_INDEX_PREFIX = 255;

/** Reserved overflow column: fields with no declared scalar column (e.g. embedded relations) live here as JSON. */
export const OVERFLOW_COLUMN = "_extra";

function columnDefs(fields: FieldSpec[], types: Record<string, string>, quote: (n: string) => string): string {
  const cols = [`${quote("uuid")} ${types.uuid} PRIMARY KEY`];
  for (const f of fields) cols.push(`${quote(ident(f.name))} ${types[f.type] ?? types.scalar}`);
  cols.push(`${quote(OVERFLOW_COLUMN)} ${types.json}`);
  return cols.join(", ");
}

/**
 * MySQL index column list, adding a `(255)` key-length prefix to any TEXT/longtext-backed column
 * (indexing a TEXT column without a prefix is an error). `columnTypes` maps a column to its stored
 * type tag; `uuid` and numeric columns index whole. When the map is absent (no schema info) the
 * columns index whole — the caller supplies it in real provisioning.
 */
function mysqlIndexColumns(columns: string[], columnTypes?: ReadonlyMap<string, string>): string {
  return columns
    .map((c) => {
      const prefix = columnTypes && MYSQL_PREFIXED_TYPES.has(columnTypes.get(c) ?? "") ? `(${MYSQL_INDEX_PREFIX})` : "";
      return `\`${ident(c)}\`${prefix}`;
    })
    .join(", ");
}

export const postgresDialect: SqlDialect = {
  name: "postgres",
  column: (n) => `"${ident(n)}"`,
  jsonExtract: (column, path) => `("${ident(column)}"::jsonb #> '{${path.map((s) => ident(s)).join(",")}}')`,
  jsonValue: () => "?::jsonb",
  columnType: (t) => PG_TYPES[t] ?? PG_TYPES.scalar!,
  concat: (parts) => `(${parts.join(" || ")})`,
  likeMatch: (column) => `${column} LIKE ?`,
  finalize: (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  },
  ref: (m) => `"${ident(m)}"`,
  createTable: (m, fields) => `CREATE TABLE IF NOT EXISTS "${ident(m)}" (${columnDefs(fields, PG_TYPES, (n) => `"${n}"`)})`,
  createIndex: (m, name, cols, unique) =>
    `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${ident(name)}" ON "${ident(m)}" (${cols.map((c) => `"${ident(c)}"`).join(", ")})`,
  dropIndex: (_m, name) => `DROP INDEX IF EXISTS "${ident(name)}"`,
  columnsQuery: (m) => ({ sql: `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, params: [ident(m)] }),
  addColumn: (m, name, type) => `ALTER TABLE "${ident(m)}" ADD COLUMN "${ident(name)}" ${type}`,
  dropTable: (m) => `DROP TABLE IF EXISTS "${ident(m)}"`,
  dropColumn: (m, name) => `ALTER TABLE "${ident(m)}" DROP COLUMN "${ident(name)}"`,
  renameColumn: (m, from, to) => `ALTER TABLE "${ident(m)}" RENAME COLUMN "${ident(from)}" TO "${ident(to)}"`,
  alterColumnType: (m, name, type) => `ALTER TABLE "${ident(m)}" ALTER COLUMN "${ident(name)}" TYPE ${type}`,
  upsert: (m, columns) => postgresDialect.upsertMany(m, columns, 1),
  upsertMany: (m, columns, rows, updateColumns) => {
    const cols = columns.map((c) => `"${ident(c)}"`);
    let n = 0;
    const tuples = Array.from({ length: rows }, () => `(${columns.map(() => `$${++n}`).join(", ")})`);
    const setCols = updateColumns ?? columns.filter((c) => c !== "uuid");
    const sets = setCols.map((c) => `"${ident(c)}" = excluded."${ident(c)}"`);
    return `INSERT INTO "${ident(m)}" (${cols.join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT (uuid) DO UPDATE SET ${sets.join(", ")}`;
  },
  deleteByUuid: (m) => `DELETE FROM "${ident(m)}" WHERE uuid = $1`,
  deleteMany: (m, count) => `DELETE FROM "${ident(m)}" WHERE uuid IN (${Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ")})`,
  paging: (limit, offset) => {
    if (limit === null && offset === 0) return "";
    if (limit === null) return ` OFFSET ${pageBound(offset)}`;
    return ` LIMIT ${pageBound(limit)} OFFSET ${pageBound(offset)}`;
  },
  truncate: (sql) => `trunc(${sql})`,
  nullsOrder: (descending) => (descending ? " NULLS LAST" : " NULLS FIRST")
};

export const mysqlDialect: SqlDialect = {
  name: "mysql",
  column: (n) => `\`${ident(n)}\``,
  jsonExtract: (column, path) => `JSON_EXTRACT(\`${ident(column)}\`, '$.${path.map((s) => ident(s)).join(".")}')`,
  jsonValue: () => "CAST(? AS JSON)",
  columnType: (t) => MYSQL_TYPES[t] ?? MYSQL_TYPES.scalar!,
  concat: (parts) => `CONCAT(${parts.join(", ")})`,
  likeMatch: (column) => `${column} LIKE BINARY ?`, // BINARY → case-sensitive (default collation isn't)
  finalize: (sql) => sql, // mysql2 uses positional `?`
  ref: (m) => `\`${ident(m)}\``,
  // COLLATE=utf8mb4_bin makes every string column case- and accent-sensitive for `=`/`IN`/unique/ORDER
  // BY, matching the in-memory reference (JS `===`); MySQL's default `utf8mb4_0900_ai_ci` folds case.
  createTable: (m, fields) =>
    `CREATE TABLE IF NOT EXISTS \`${ident(m)}\` (${columnDefs(fields, MYSQL_TYPES, (n) => `\`${n}\``)}) COLLATE=utf8mb4_bin`,
  createIndex: (m, name, cols, unique, columnTypes) =>
    `CREATE ${unique ? "UNIQUE " : ""}INDEX \`${ident(name)}\` ON \`${ident(m)}\` (${mysqlIndexColumns(cols, columnTypes)})`,
  dropIndex: (m, name) => `DROP INDEX \`${ident(name)}\` ON \`${ident(m)}\``,
  columnsQuery: (m) => ({
    sql: `SELECT column_name AS column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE()`,
    params: [ident(m)]
  }),
  addColumn: (m, name, type) => `ALTER TABLE \`${ident(m)}\` ADD COLUMN \`${ident(name)}\` ${type}`,
  dropTable: (m) => `DROP TABLE IF EXISTS \`${ident(m)}\``,
  dropColumn: (m, name) => `ALTER TABLE \`${ident(m)}\` DROP COLUMN \`${ident(name)}\``,
  renameColumn: (m, from, to) => `ALTER TABLE \`${ident(m)}\` RENAME COLUMN \`${ident(from)}\` TO \`${ident(to)}\``,
  alterColumnType: (m, name, type) => `ALTER TABLE \`${ident(m)}\` MODIFY COLUMN \`${ident(name)}\` ${type}`,
  upsert: (m, columns) => mysqlDialect.upsertMany(m, columns, 1),
  upsertMany: (m, columns, rows, updateColumns) => {
    const cols = columns.map((c) => `\`${ident(c)}\``);
    const tuple = `(${columns.map(() => "?").join(", ")})`;
    const tuples = Array.from({ length: rows }, () => tuple);
    const setCols = updateColumns ?? columns.filter((c) => c !== "uuid");
    const sets = setCols.map((c) => `\`${ident(c)}\` = VALUES(\`${ident(c)}\`)`);
    return `INSERT INTO \`${ident(m)}\` (${cols.join(", ")}) VALUES ${tuples.join(", ")} ON DUPLICATE KEY UPDATE ${sets.join(", ")}`;
  },
  deleteByUuid: (m) => `DELETE FROM \`${ident(m)}\` WHERE uuid = ?`,
  deleteMany: (m, count) => `DELETE FROM \`${ident(m)}\` WHERE uuid IN (${Array.from({ length: count }, () => "?").join(", ")})`,
  paging: (limit, offset) => {
    if (limit === null && offset === 0) return "";
    return ` LIMIT ${limit === null ? "18446744073709551615" : pageBound(limit)} OFFSET ${pageBound(offset)}`;
  },
  truncate: (sql) => `truncate(${sql}, 0)`,
  nullsOrder: () => "" // MySQL already sorts nulls first-ASC / last-DESC (matches the reference) and lacks the syntax
};
