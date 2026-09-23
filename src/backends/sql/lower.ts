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
import { physicalIndexName, type SqlDialect } from "./dialect.ts";
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
      for (const index of op.indexes ?? []) {
        if (index.text || index.ttlSeconds !== undefined) continue; // Mongo-only index kinds
        statements.push(
          ddl(dialect.createIndex(op.model, index.name, index.fields.map((f) => f.path), !!index.unique))
        );
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
        const column = dialect.column(op.field);
        statements.push({
          sql: dialect.finalize(`UPDATE ${dialect.ref(op.model)} SET ${column} = ? WHERE ${column} IS NULL`),
          params: [op.fill]
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
      return present.has(op.field)
        ? [ddl(dialect.alterColumnType(op.model, op.field, dialect.columnType(op.to)))]
        : null;

    case "copyField": {
      if (!present.has(op.from) || !present.has(op.to)) return null;
      const from = dialect.column(op.from);
      const to = dialect.column(op.to);
      // `from IS NOT NULL` mirrors the reference, which skips a record whose source field is absent —
      // and a NULL column decodes as absent, so the two agree exactly. Without `overwrite`, `to IS NULL`
      // is likewise the SQL spelling of "the target is still unset".
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
