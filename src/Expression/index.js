import { ContainsExpression } from "./ContainsExpressions";
import { Compare } from "./Compare";
import { And } from "./And";
import { Or } from "./Or";
import { Not } from "./Not";
import { In } from "./In";
import { Between } from "./Between";

export default class Expression {
  //* Returns a new AndExpression combining the expressions provided as arguments
  static and(...expressions) {
    return new And({ expressions });
  }
  //* Returns a new OrExpression combining the expressions provided as arguments
  static or(...expressions) {
    return new Or({ expressions });
  }
  //* Negates a given Expression
  static not(expression) {
    return new Not({ expression });
  }
  //* Returns a new CompareExpression
  static compare(property, comparator, value) {
    return new Compare({ property, comparator, value });
  }
  //* Returns a new CompareExpression wit the = comparator applied
  static eq(property, value) {
    return new Compare({ property, comparator: "=", value });
  }
  //* Returns a new CompareExpression wit the != comparator applied
  static neq(property, value) {
    return new Compare({ property, comparator: "!=", value });
  }
  //* Returns a new CompareExpression wit the > comparator applied
  static gt(property, value) {
    return new Compare({ property, comparator: ">", value });
  }
  //* Returns a new CompareExpression wit the < comparator applied
  static lt(property, value) {
    return new Compare({ property, comparator: "<", value });
  }
  //* Returns a new CompareExpression wit the >= comparator applied
  static gteq(property, value) {
    return new Compare({ property, comparator: ">=", value });
  }
  //* Returns a new CompareExpression wit the <= comparator applied
  static lteq(property, value) {
    return new Compare({ property, comparator: "<=", value });
  }
  //* Returns a new InExpression
  static in(property, values) {
    return new In({ property, values });
  }
  //* Returns a new ContainsExpression
  static contains(property, value) {
    return new ContainsExpression({ property, value });
  }
  //* Returns a new BetweenExpression
  static between(property, lowerEnd, upperEnd) {
    return new Between({ property, lowerEnd, upperEnd });
  }
}
