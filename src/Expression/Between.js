import { AbstractExpression } from "./AbstractExpression";

export class Between extends AbstractExpression {
  constructor({ property, lowerEnd, upperEnd }) {
    super();
    this.property = property;
    this.lowerEnd = lowerEnd;
    this.upperEnd = upperEnd;
  }

  match(json) {
    var result =
      json[this.property] >= this.lowerEnd &&
      json[this.property] <= this.upperEnd;

    return new Promise(resolve => resolve(result));
  }

  stringify() {
    return JSON.stringify({
      type: "between",
      property: this.property,
      lowerEnd: this.lowerEnd,
      upperEnd: this.upperEnd
    });
  }
}
