import { AbstractExpression } from "./AbstractExpression";

export class ContainsExpression extends AbstractExpression {
  constructor({ property, value }) {
    super();
    this.property = property;
    this.value = value.uuid || value;
  }

  match(json) {
    return new Promise(resolve =>
      resolve(json[this.property].indexOf(this.value) > -1)
    );
  }

  stringify() {
    return JSON.stringify({
      type: "contains",
      property: this.property,
      value: this.value
    });
  }
}
