import { AbstractExpression } from "./AbstractExpression";

export class Or extends AbstractExpression {
  constructor({ expressions }) {
    super();
    this.expressions = expressions;
  }

  async match(json) {
    for (const expression of this.expressions) {
      const result = await expression.match(json);
      if (result) {
        return true;
      }
    }
    return false;
  }

  stringify() {
    var strings = this.expressions
      .map(expression => expression.stringify())
      .sort();

    return JSON.stringify({
      type: "or",
      expressions: strings
    });
  }
}
