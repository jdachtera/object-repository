/**
 * Lowering the portable migration IR to SQL (ARCHITECTURE.md §11).
 *
 * A pure function over the op IR: given a dialect and the columns a table actually has, return the
 * statements that realize an operation, or `null` to decline so the portable reference executor runs
 * it instead. Declining is not failure — it is how a rename of a field that lives in the `_extra` JSON
 * overflow still happens, correctly, just row by row.
 *
 * The payoff for lowering is asymptotic, not cosmetic: a rename is one `ALTER TABLE ... RENAME COLUMN`
 * (metadata, O(1)) instead of rewriting every row, and a field copy is a single set-based `UPDATE`
 * instead of N round-trips.
 */
import { encodeValue, physicalIndexName, type SqlDialect } from "./dialect.ts";
import { coerce } from "../../migrations/coerce.ts";
import type { MigrationOp } from "../../migrations/types.ts";

export interface Statement {
  sql: string;
  params: unknown[];
}

/**
 * Statements realizing `op`, or `null` to decline.
 *
 * `present` is the live column set for `op`'s model; empty means the table doesn't exist. A field
 * operation naming a column that isn't
 * there refers to something held in the JSON overflow (a relation, or a field the model never declared
 * as a scalar), and emitting DDL against a missing column would simply throw — so those decline.
 */
export function lowerToSql(
  op: MigrationOp,
  dialect: SqlDialect,
  present: ReadonlySet<string>,
  columnTypes?: ReadonlyMap<string, string>
): Statement[] | null {
  const ddl = (sql: string): Statement => ({ sql: dialect.finalize(sql), params: [] });

  switch (op.kind) {
    case "createModel": {
      const statements = [ddl(dialect.createTable(op.model, op.fields))];
      // Named and typed as provisioning makes them: scoped to the table (Postgres index names are
      // schema-global, so two models' `email` indexes would collide and the second silently not exist),
      // and with the field types, so MySQL can prefix-length a TEXT column instead of refusing it.
      const types = new Map(op.fields.map((field) => [field.name, field.type as string]));
      for (const index of op.indexes ?? []) {
        if (index.text || index.ttlSeconds !== undefined) continue; // Mongo-only index kinds
        const paths = index.fields.map((f) => f.path);
        if (!paths.every((path) => path === "uuid" || types.has(path))) continue; // no column to index
        statements.push(ddl(dialect.createIndex(op.model, physicalIndexName(op.model, index.name), paths, !!index.unique, types)));
      }
      return statements;
    }

    case "dropModel":
      return [ddl(dialect.dropTable(op.model))];

    case "addField": {
      // No table yet: the reference executor provisions it from the model's declared layout. An
      // existing column (auto-provisioned by `define()`, or added by an interrupted earlier attempt)
      // is already in the target state, so only the fill remains.
      if (present.size === 0) return null;
      const statements = present.has(op.field) ? [] : [ddl(dialect.addColumn(op.model, op.field, dialect.columnType(op.type)))];
      if (op.fill !== undefined) {
        // Bound exactly as a write would bind it: the stored form under `op.type`, encoded for the
        // column. Bound raw, an array fill became a Postgres array literal and broke every later read.
        const column = dialect.column(op.field);
        statements.push({
          sql: dialect.finalize(`UPDATE ${dialect.ref(op.model)} SET ${column} = ? WHERE ${column} IS NULL`),
          params: [encodeValue(op.type, coerce(op.fill, op.type), dialect)]
        });
      }
      return statements;
    }

    case "dropField":
      return present.has(op.field) ? [ddl(dialect.dropColumn(op.model, op.field))] : null;

    case "renameField":
      // A target column that already exists would make the rename fail (or, on a retry, mean it
      // already ran): decline, and let the reference move the values without losing either field.
      return present.has(op.from) && !present.has(op.to) ? [ddl(dialect.renameColumn(op.model, op.from, op.to))] : null;

    case "retypeField":
      return present.has(op.field) ? lowerRetype(op, dialect) : null;

    case "copyField": {
      if (!present.has(op.from) || !present.has(op.to)) return null;
      // Between columns of different types a plain assignment is the engine's cast, not `coerce()`:
      // it refuses text → bigint, rounds 1.5 into an integer, or reads 'abc' as 0. Let the reference
      // convert each value instead.
      if (columnTypes && columnTypes.get(op.from) !== columnTypes.get(op.to)) return null;
      const from = dialect.column(op.from);
      const to = dialect.column(op.to);
      // `from IS NOT NULL` mirrors the reference, which skips a record whose source field is absent —
      // and a NULL column decodes as absent, so the two agree exactly. Without `overwrite`, `to IS NULL`
      // is likewise the SQL spelling of "the target is still unset".
      // `exact` copies NULL too: a cleared source clears the target.
      if (op.exact) return [ddl(`UPDATE ${dialect.ref(op.model)} SET ${to} = ${from}`)];
      const guard = op.overwrite ? `${from} IS NOT NULL` : `${to} IS NULL AND ${from} IS NOT NULL`;
      return [ddl(`UPDATE ${dialect.ref(op.model)} SET ${to} = ${from} WHERE ${guard}`)];
    }

    case "addIndex": {
      if (op.index.text || op.index.ttlSeconds !== undefined) return null; // not expressible here
      const paths = op.index.fields.map((field) => field.path);
      // A nested path or a field held in the JSON overflow has no column to index: decline, the way
      // provisioning skips such an index, rather than emit DDL that throws.
      if (!paths.every((path) => path === "uuid" || present.has(path))) return null;
      const types = op.columnTypes ? new Map(Object.entries(op.columnTypes)) : columnTypes;
      return [ddl(dialect.createIndex(op.model, physicalIndexName(op.model, op.index.name), paths, !!op.index.unique, types))];
    }

    case "dropIndex":
      return [ddl(dialect.dropIndex(op.model, physicalIndexName(op.model, op.index)))];

    case "rawSql":
      // A statement written for another engine is not ours to run.
      if (op.dialect !== "*" && op.dialect !== dialect.name) return null;
      return [{ sql: op.statement, params: op.params }];

    case "transform":
      // A user-supplied JavaScript function has no SQL form.
      return null;
  }
}

/**
 * A retype whose DDL converts the column but whose stored values then need the reference pass: a
 * float's text as the engine renders it (`1e+15`, `1e-07`) isn't `coerce()`'s `String(value)`. The
 * backend runs the returned DDL and declines the op, so the reference rewrites each value.
 */
export function retypeThenRewrite(op: MigrationOp): boolean {
  return op.kind === "retypeField" && op.from === "float" && op.to === "text";
}

/** Which ops change a table's column set, so the backend must refresh what it thinks the layout is. */
export function changesColumns(op: MigrationOp): boolean {
  return (
    op.kind === "addField" ||
    op.kind === "dropField" ||
    op.kind === "renameField" ||
    op.kind === "retypeField" ||
    op.kind === "createModel" ||
    op.kind === "dropModel"
  );
}

const NUMERIC_OR_BOOLEAN = new Set(["integer", "float", "date", "boolean"]);
const TEXT_FORMS = new Set(["text", "json", "scalar"]);

/**
 * A retype, as statements that leave every stored value exactly as `coerce()` would.
 *
 * `ALTER COLUMN … TYPE` alone keeps the stored bytes and switches how they are decoded, which is right
 * only when the two types store a value the same way. So each pair of the widening lattice is spelled
 * out: a number or boolean becomes its own text (the same text is also its JSON); a text value is
 * JSON-quoted for `json`/`scalar`, which store JSON; an array is already stored as JSON. A pair not
 * listed is refused rather than guessed at.
 */
function lowerRetype(op: Extract<MigrationOp, { kind: "retypeField" }>, dialect: SqlDialect): Statement[] | null {
  const ddl = (sql: string): Statement => ({ sql: dialect.finalize(sql), params: [] });
  const alter = (to: string): Statement => ddl(dialect.alterColumnType(op.model, op.field, dialect.columnType(to)));
  const table = dialect.ref(op.model);
  const column = dialect.column(op.field);

  if (op.from === undefined) return [alter(op.to)]; // the legacy alias: its historical behaviour
  if (op.from === op.to) return [];
  if (op.from === "integer" && op.to === "float") return [alter("float")];

  if (NUMERIC_OR_BOOLEAN.has(op.from) && TEXT_FORMS.has(op.to)) {
    const statements = [alter(op.to)];
    // MySQL stores a boolean as tinyint, so its text form is "1"/"0", where coerce() says "true"/"false".
    if (op.from === "boolean" && dialect.name === "mysql") {
      statements.push(ddl(`UPDATE ${table} SET ${column} = CASE ${column} WHEN '1' THEN 'true' WHEN '0' THEN 'false' ELSE ${column} END`));
    }
    return statements;
  }

  if (op.from === "text" && (op.to === "json" || op.to === "scalar")) {
    const quote = dialect.name === "mysql" ? `JSON_QUOTE(${column})` : `to_json(${column})::text`;
    const statements = dialect.columnType("text") === dialect.columnType(op.to) ? [] : [alter(op.to)];
    statements.push(ddl(`UPDATE ${table} SET ${column} = ${quote} WHERE ${column} IS NOT NULL`));
    return statements;
  }

  if (op.from === "array" && (op.to === "json" || op.to === "scalar")) {
    return dialect.columnType("array") === dialect.columnType(op.to) ? [] : [alter(op.to)];
  }

  return null;
}
