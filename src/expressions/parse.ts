import type { ExpressionNode } from "../core/QueryPlan.ts";
import type { Expression } from "./Expression.ts";
import { All, And, Any, Between, Compare, Contains, Exists, Expr, In, IsNull, Nin, Not, Or, Size, TextMatch } from "./nodes.ts";
import { parseValue } from "./values.ts";

/**
 * Rehydrate an `Expression` from its serialized AST node — the inverse of `serialize()` and the
 * receiving end of the wire protocol (ARCHITECTURE.md §4). A backend that received a `QueryPlan`
 * over a transport calls this to turn `plan.where` back into a runnable expression.
 *
 * The switch is exhaustive over the `ExpressionNode` union; adding a node type is a compile error
 * here until handled.
 */
export function parse(node: ExpressionNode): Expression {
  switch (node.type) {
    case "all":
      return new All();
    case "compare":
      return new Compare(node.property, node.comparator, node.value);
    case "in":
      return new In(node.property, node.values);
    case "nin":
      return new Nin(node.property, node.values);
    case "contains":
      return new Contains(node.property, node.value);
    case "between":
      return new Between(node.property, node.lowerEnd, node.upperEnd);
    case "exists":
      return new Exists(node.property, node.shouldExist);
    case "isNull":
      return new IsNull(node.property, node.negated);
    case "size":
      return new Size(node.property, node.length);
    case "textmatch":
      return new TextMatch(node.property, node.value, node.mode, node.caseInsensitive);
    case "expr":
      return new Expr(parseValue(node.left), node.comparator, parseValue(node.right));
    case "any":
      return new Any(node.property, parse(node.predicate));
    case "not":
      return new Not(parse(node.expression));
    case "and":
      return new And(node.expressions.map(parse));
    case "or":
      return new Or(node.expressions.map(parse));
  }
}
