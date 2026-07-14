import type { JsonObject, JsonValue } from "../core/types.ts";
import type { ValueNode } from "../core/QueryPlan.ts";
import type { AnyProperty, PropertyMap } from "../properties/infer.ts";
import { isValueExpr, type ValueExpr } from "../expressions/values.ts";

/**
 * A selection object (ARCHITECTURE.md §11) — the nestable projection spec:
 *  - `field: true`        include the field as-is
 *  - `field: { … }`       recurse into a nested object / array / to-one relation
 *  - `alias: <valueExpr>` a computed field (`total: mul(field("price"), field("qty"))`)
 */
export type Selection = { [key: string]: true | ValueExpr | Selection };

type Prettify<T> = { [K in keyof T]: T[K] } & {};

// Depth budget so the recursive projection type terminates (nested selections are shallow in
// practice) — mirrors `Paths` in where.ts. Bounding it also keeps the type finite for tooling
// (an unbounded recursive conditional makes the TypeDoc/tsdoc type serializer blow the heap).
type Decr = [never, 0, 1, 2, 3, 4, 5];

/**
 * Infers the shape a `Selection` produces from an instance type `T` — recursively (to depth `D`), so
 * nested selections, arrays, and to-one (`M | null`) relations all project correctly, and computed
 * fields contribute their value type.
 */
export type InferSelection<T, S, D extends number = 5> = [D] extends [never]
  ? unknown
  : Prettify<{
      [K in keyof S]: S[K] extends ValueExpr
        ? JsonValue // computed field
        : S[K] extends true
          ? K extends keyof T
            ? T[K]
            : unknown
          : K extends keyof T // nested selection
            ? NonNullable<T[K]> extends ReadonlyArray<infer U>
              ? Array<InferSelection<U, S[K], Decr[D]>>
              : null extends T[K]
                ? InferSelection<NonNullable<T[K]>, S[K], Decr[D]> | null
                : InferSelection<NonNullable<T[K]>, S[K], Decr[D]>
            : unknown;
    }>;

/** The top-level stored fields a selection needs fetched: each selected key, plus the fields any
 *  computed value expression reads. Drives the backend `project` list so only referenced columns load. */
export function neededFields(selection: Selection): string[] {
  const fields = new Set<string>();
  for (const [name, sel] of Object.entries(selection)) {
    if (isValueExpr(sel)) {
      for (const path of valueFieldPaths(sel)) fields.add(path.split(".")[0]!);
    } else {
      // scalar field, or a relation/json key whose top-level field we need (FK uuid, embed blob).
      fields.add(name);
    }
  }
  return [...fields];
}

/** A selection of all of a model's scalar fields (what `relation: true` expands to). */
export function allScalarsSelection(properties: PropertyMap): Selection {
  const selection: Selection = {};
  for (const name of Object.keys(properties)) {
    if ((properties[name] as AnyProperty).kind === "scalar") selection[name] = true;
  }
  return selection;
}

/** The top-level field paths a value expression reads (for projection push-down). */
export function valueFieldPaths(expr: ValueExpr): string[] {
  const paths: string[] = [];
  const walk = (node: ValueNode): void => {
    switch (node.type) {
      case "field":
        paths.push(node.path);
        break;
      case "lit":
        break;
      case "arith":
      case "concat":
      case "coalesce":
        node.operands.forEach(walk);
        break;
      case "neg":
        walk(node.operand);
        break;
    }
  };
  walk(expr.serialize());
  return paths;
}

/** Project a value (a model instance or a nested object) through a selection — reference semantics. */
export function projectValue(value: unknown, spec: Selection): unknown {
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, selection] of Object.entries(spec)) {
    if (selection === true) {
      result[key] = source[key];
    } else if (isValueExpr(selection)) {
      result[key] = selection.evaluate(source as JsonObject);
    } else {
      result[key] = projectChild(source[key], selection);
    }
  }
  return result;
}

function projectChild(child: unknown, spec: Selection): unknown {
  if (Array.isArray(child)) return child.map((element) => projectValue(element, spec));
  if (child === null || child === undefined) return null;
  return projectValue(child, spec);
}
