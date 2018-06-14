import { List } from "./List";
import { RelationToManyProperty } from "../Property/RelationToManyProperty";
import { RelationToOneProperty } from "../Property/RelationToOneProperty";

export class Collection extends List {
  constructor(property, owner) {
    super();
    this.property = property;
    this.owner = owner;
    this.remoteProperty = this.property.repository.modelClass.properties[
      this.property.remoteProperty
    ];
  }

  onAdd(item) {
    try {
      if (this.remoteProperty instanceof RelationToManyProperty) {
        item[this.property.remoteProperty].add(this.owner);
      } else if (this.remoteProperty instanceof RelationToOneProperty) {
        item[this.property.remoteProperty] = this.owner;
      }
    } catch (e) {
      console.log(
        typeof item,
        typeof item === "string" && item,
        this.property.remoteProperty,
        item[this.property.remoteProperty]
      );
      throw e;
    }
  }

  onRemove(item) {
    if (this.remoteProperty instanceof RelationToManyProperty) {
      item[this.property.remoteProperty].remove(this.owner);
    } else if (this.remoteProperty instanceof RelationToOneProperty) {
      item[this.property.remoteProperty] = null;
    }
  }

  async getUUIDS() {
    for (const item of this.array) {
      if (!item.uuid) {
        this.property.repository.save(item);
      }
    }

    await this.property.repository.persist();

    return this.array.map(item => item.uuid);
  }
}
