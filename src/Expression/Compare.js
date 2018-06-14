import { AbstractExpression } from "./AbstractExpression";

export class Compare extends AbstractExpression {
  constructor({ property, comparator, value }) {
    super();
    if (comparator == "==") {
      comparator = "=";
    }

    this.property = property;
    this.comparator = comparator;
    this.value = (value && value.uuid) || value;
  }

  match(json) {
    let value = false;
    switch (this.comparator) {
      case "==":
      case "=":
        value = json[this.property] === this.value;
        break;
      case "!=":
        value = json[this.property] != this.value;
        break;
      case ">=":
        value = json[this.property] >= this.value;
        break;
      case "<=":
        value = json[this.property] <= this.value;
        break;
      case ">":
        value = json[this.property] > this.value;
        break;
      case "<":
        value = json[this.property] < this.value;
        break;
    }

    return new Promise(resolve => resolve(value));
  }

  stringify() {
    return JSON.stringify({
      type: "compare",
      property: this.property,
      comparator: this.comparator,
      value: this.value
    });
  }
}
