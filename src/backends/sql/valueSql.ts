/**
 * Shared SQL construction for the value-expression operators whose semantics MUST agree across every
 * SQL backend (the columnar Postgres/MySQL compiler in `compile.ts` and the JSON-blob SQLite compiler
 * in `SQLiteBackend.ts`). Those two backends store data differently — real columns vs `json_extract`
 * of a blob — and traverse the AST differently (a nullable node-recursion that can decline push-down,
 * vs a total visitor), so their field access, literals, and date functions rightly differ. But the
 * *operator* rules — how arithmetic coerces null operands, the divide-by-zero guard, concat's null
 * substitution — are exactly the parity contract the cross-backend tests pin, and a divergence here is
 * the class of bug the review found. These assemblers take operands that each backend already compiled
 * to `{ sql, params }` fragments and combine them, so that rule lives in one place.
 */
import type { JsonValue } from "../../core/types.ts";
import type { ArithOp } from "../../core/QueryPlan.ts";

export interface SqlFragment {
  sql: string;
  params: JsonValue[];
}

const zero = (part: SqlFragment): string => `COALESCE(${part.sql}, 0)`;

/** Truncate-toward-zero for the mod formula. SQLite's default (`CAST … AS INTEGER`) truncates; the SQL
 *  engines pass their own (`trunc()` / `truncate(x,0)`) because CAST *rounds* there. */
const defaultTruncate = (sql: string): string => `CAST(${sql} AS INTEGER)`;

/**
 * Arithmetic over already-compiled operands. Each operand is `COALESCE`d to 0 because the in-memory
 * reference coerces a null/missing operand to 0 (`num()`) — a bare `a + b` would NULL-propagate. The
 * reference is JS arithmetic, so:
 *  - `/` is **float** division (`b === 0 ? 0 : a / b`); a bare `a / b` truncates on Postgres and SQLite
 *    for integer operands, so force float with `* 1.0`.
 *  - `%` is the JS remainder (`b === 0 ? 0 : a % b`), truncated toward zero — `a - b * trunc(a / b)`.
 *    A bare `%` errors on Postgres for floats and truncates to integer on SQLite; this formula matches
 *    the reference on every engine. `truncate` is dialect-supplied (see `defaultTruncate`).
 * Both are wrapped in a `CASE` that returns 0 for a zero divisor. Division/modulo are binary here.
 */
export function arithFragment(op: ArithOp, parts: SqlFragment[], truncate: (sql: string) => string = defaultTruncate): SqlFragment {
  if ((op === "/" || op === "%") && parts.length === 2) {
    const [a, b] = parts as [SqlFragment, SqlFragment];
    const A = zero(a);
    const B = zero(b);
    if (op === "/") {
      return {
        sql: `(CASE WHEN ${B} = 0 THEN 0 ELSE (${A} * 1.0 / ${B}) END)`,
        params: [...b.params, ...a.params, ...b.params] // WHEN(b), then a, b in the ELSE
      };
    }
    return {
      sql: `(CASE WHEN ${B} = 0 THEN 0 ELSE (${A} - ${B} * ${truncate(`${A} * 1.0 / ${B}`)}) END)`,
      params: [...b.params, ...a.params, ...b.params, ...a.params, ...b.params] // WHEN(b), a, b, a, b
    };
  }
  return { sql: `(${parts.map(zero).join(` ${op} `)})`, params: parts.flatMap((part) => part.params) };
}

/** Negation, with the operand coerced to 0 (so `-null` is 0, not NULL) — matches `-num(x)`. */
export function negFragment(inner: SqlFragment): SqlFragment {
  return { sql: `(-COALESCE(${inner.sql}, 0))`, params: inner.params };
}

/**
 * String concatenation with each operand coerced to `''` (the reference substitutes `""` for null).
 * `join` builds the engine's concatenation from the coerced operand SQLs — `||` for SQLite/Postgres,
 * `CONCAT(...)` for MySQL (passed in by the caller so the dialect stays the owner of that choice).
 */
export function concatFragment(parts: SqlFragment[], join: (sqls: string[]) => string): SqlFragment {
  return { sql: join(parts.map((part) => `COALESCE(${part.sql}, '')`)), params: parts.flatMap((part) => part.params) };
}

/** `COALESCE(a, b, …)` — first non-null operand; no per-operand coercion (that IS the operator). */
export function coalesceFragment(parts: SqlFragment[]): SqlFragment {
  return { sql: `COALESCE(${parts.map((part) => part.sql).join(", ")})`, params: parts.flatMap((part) => part.params) };
}
