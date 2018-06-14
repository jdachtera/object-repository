import { AbstractExpression } from "./Expression/AbstractExpression";
import Expression from "./Expression";

export class QueryCollection {
  expression = null;

  //* Constructs a new QueryCollection for a given repository
  constructor(repository) {
    this.repository = repository;
    this.expression = new AbstractExpression();
    this.paging = { start: 0, end: undefined };
    this.order = [];
  }

  //* Returns a new QueryCollection with the filter expression applied
  filter(/* A db.Expression */ expression) {
    var newCollection = new QueryCollection(this.repository);

    var newExpression =
      this.expression.constructor === AbstractExpression
        ? expression
        : Expression.and(this.expression, expression);

    newCollection.expression = newExpression;

    return newCollection;
  }

  //* Return a clone of the QueryCollection
  clone(conf) {
    var newCollection = new QueryCollection(this.repository);
    newCollection.expression = this.expression;
    newCollection.order = Object.assign({}, this.order);
    newCollection.slice(this.paging.start, this.paging.end);
    Object.assign(newCollection, conf);
    return newCollection;
  }

  //* Set the slicing of the QueryCollection
  slice(start, end) {
    this.paging.start = start;
    this.paging.end = end;
    return this;
  }

  //* Sets the sorting of the QueryCollection
  sort(property, descending) {
    this.order.push({ property: property, descending: !!descending });
    return this;
  }

  //* Lists the items that match the QueryCollection's filter
  async list() {
    const items = await this.repository.query(this);
    return items;
  }

  //* Lists the uuids of the items that match the QueryCollection's filter
  async listUuids(context, callback) {
    const uuids = await this.repository.queryUuids(this);
    return uuids;
  }

  //* Executes the QueryCollection and iterates over the items
  async each(iteratorCallback) {
    const items = await this.list();
    items.forEach(iteratorCallback);
    return items;
  }
}
