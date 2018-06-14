import { AbstractExpression } from "./AbstractExpression";

export class In extends AbstractExpression {
  constructor({ property, values }) {
    super();
    this.property = property;
    this.values = values.map(v => v.uuid || v);
  }

  match(json) {
    return new Promise(resolve =>
      resolve(this.values.indexOf(json[this.property]) > -1)
    );
  }

  stringify() {
    return JSON.stringify({
      type: "in",
      property: this.property,
      values: this.values
    });
  }
}
