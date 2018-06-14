import { Collection } from "./Collection";
import Expression from "../Expression";

export class LazyCollection extends Collection {
  ready = false;

  constructor(property, owner, inArray, inUuids) {
    super(property, owner);

    if (inArray) {
      this.addArray(inArray);
      this.ready = true;
    }

    if (inUuids) {
      this.uuids = inUuids;
    }
  }

  async load() {
    if (this.ready) {
      return this.array;
    } else {
      const items = await this.property.repository
        .all()
        .filter(Expression.in("uuid", this.uuids))
        .list();

      this.ready = true;
      this.clear();
      this.addArray(items);
      return items;
    }
  }

  async getUUIDS() {
    if (this.ready) {
      return super.getUUIDS();
    } else {
      return this.uuids || [];
    }
  }
}
