import { AbstractExpression } from "./AbstractExpression";

export class And extends AbstractExpression {
  constructor({ expressions }) {
    super();
    this.expressions = expressions;
  }

  async match(json) {
    for (let i = 0; i < this.expressions.length; i++) {
      const expression = this.expressions[i];
      const result = await expression.match(json);
      if (!result) {
        return false;
      }
    }
    return true;
  }

  stringify() {
    var strings = this.expressions
      .map(expression => expression.stringify())
      .sort();

    return JSON.stringify({
      type: "and",
      expressions: strings
    });
  }
}
