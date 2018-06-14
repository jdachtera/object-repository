import { AbstractExpression } from "./AbstractExpression";

export class Not extends AbstractExpression {
  constructor({ expression }) {
    super();
    this.expression = expression;
  }

  async match(json) {
    return !(await this.expression.match(json));
  }

  stringify() {
    return JSON.stringify({
      type: "not",
      expression: this.expression.stringify()
    });
  }
}
