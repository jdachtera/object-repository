export class AbstractExpression {
  //* Returns a unique hash for the expression
  toHash() {
    var str = this.stringify();
    return str;
  }

  //* Returns a unique string for the expression
  stringify() {
    return '{type: "all"}';
  }

  //* Checks if a given instance matches the expression
  async match(json) {
    return true;
  }

  clone(conf) {
    return new this.constructor({
      ...this,
      ...conf
    });
  }
}
