import type { JsonObject, JsonValue } from "../core/types.ts";
import type { PatchOp } from "../core/Backend.ts";
import { isValueExpr, parseValue, type ValueExpr, type ValueInput } from "../expressions/values.ts";

/** Field mutations for `Repository.patch` — a value (or value expression) is shorthand for `set`. */
export type PatchSpec = Record<string, PatchOp | ValueInput>;

/**
 * A **typed** patch spec over the model `T`: each key must be one of the model's fields, and a raw
 * value must match the field's type. A `PatchOp` (`inc(1)`/`set(…)`) or a computed `ValueExpr`
 * (`mul(field("price"), field("qty"))`) is also accepted — but a *bare* value must be `T[K]`, so a
 * field typo or a wrong-typed value is a build error. The type-safe form of `PatchSpec`.
 */
export type PatchSpecFor<T> = {
  [K in keyof T]?: T[K] | PatchOp | ValueExpr;
};

/**
 * Set a field to a value, or to a *computed* value expression evaluated server-side —
 * `set(mul(field("price"), field("qty")))` or `set(cond(...))`.
 */
export const set = (value: ValueInput): PatchOp =>
  isValueExpr(value) ? { kind: "setExpr", value: value.serialize() } : { kind: "set", value };
/** Remove a field (Mongo `$unset` / SQL `json_remove`). */
export const unset = (): PatchOp => ({ kind: "unset" });
/** Atomically add to a numeric field. */
export const inc = (by: number): PatchOp => ({ kind: "inc", by });
/** Atomically multiply a numeric field. */
export const mul = (by: number): PatchOp => ({ kind: "mul", by });
/** Append values to an array field (Mongo `$push`). */
export const push = (...values: JsonValue[]): PatchOp => ({ kind: "push", values });
/** Append values not already present (Mongo `$addToSet`). */
export const addToSet = (...values: JsonValue[]): PatchOp => ({ kind: "addToSet", values });
/** Remove every element equal to any of `values` (Mongo `$pullAll`). */
export const pull = (...values: JsonValue[]): PatchOp => ({ kind: "pull", values });

function isPatchOp(value: unknown): value is PatchOp {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PatchOp).kind === "string" &&
    ["set", "setExpr", "unset", "inc", "mul", "push", "addToSet", "pull"].includes((value as PatchOp).kind)
  );
}

/** Value equality for array ops — `===` for scalars, structural for objects/arrays. Also used for
 *  dirty-field diffing (`Repository.computeDirty`), where a field may be absent on either side. */
export function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Normalize a patch spec: bare value expressions become `setExpr`, other bare values become `set`.
 * Accepts the typed `PatchSpecFor<T>` too (whose optional fields admit `undefined`) — an `undefined`
 * value means "field omitted" and is skipped, so `{ name: maybe }` with `maybe === undefined` is a no-op.
 */
export function normalizePatch(spec: PatchSpec | PatchSpecFor<unknown>): Record<string, PatchOp> {
  const ops: Record<string, PatchOp> = {};
  for (const [field, value] of Object.entries(spec)) {
    if (value === undefined) continue;
    ops[field] = isPatchOp(value) ? value : set(value);
  }
  return ops;
}

/**
 * Apply patch ops to a record in memory (the read-modify-write fallback). Computed/relative ops
 * (`setExpr`, `inc`, `mul`) read the *pre-patch* record via a snapshot, so a patch where one field
 * is derived from another sees the original values — matching SQL `UPDATE ... SET` and a single
 * Mongo `$set` stage.
 */
export function applyPatch(record: JsonObject, ops: Record<string, PatchOp>): void {
  const before = { ...record };
  for (const [field, op] of Object.entries(ops)) {
    switch (op.kind) {
      case "set":
        record[field] = op.value;
        break;
      case "setExpr":
        record[field] = parseValue(op.value).evaluate(before);
        break;
      case "unset":
        delete record[field];
        break;
      case "inc":
        record[field] = toNumber(before[field]) + op.by;
        break;
      case "mul":
        record[field] = toNumber(before[field]) * op.by;
        break;
      case "push":
        record[field] = [...asArray(before[field]), ...op.values];
        break;
      case "addToSet": {
        const next = asArray(before[field]);
        for (const value of op.values) if (!next.some((e) => sameValue(e, value))) next.push(value);
        record[field] = next;
        break;
      }
      case "pull":
        record[field] = asArray(before[field]).filter((e) => !op.values.some((value) => sameValue(e, value)));
        break;
    }
  }
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? [...value] : [];
}

function toNumber(value: JsonValue | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
