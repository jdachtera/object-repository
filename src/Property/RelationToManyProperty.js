import { AbstractProperty } from "./AbstractProperty";
import { LazyCollection } from "../Collection/LazyCollection";
import { Collection } from "../Collection/Collection";

export class RelationToManyProperty extends AbstractProperty {
  constructor({ lazy = false, repository = null, ...rest } = {}) {
    super({ ...rest, lazy, repository });
  }

  async getInstanceProperty(instance, property) {
    var collection =
      (await super.getInstanceProperty(instance, property)) || [];

    if (Array.isArray(collection)) {
      collection = new LazyCollection(this, instance, collection, null);
      await super.setInstanceProperty(instance, property, collection);
    }

    if (collection instanceof Collection) {
      const uuids = await collection.getUUIDS();

      return uuids;
    } else {
      return [];
    }
  }

  async setInstanceProperty(instance, property, value) {
    if (value) {
      if (!Array.isArray(value)) {
        value = value.toString().split(",");
        if (value[0] === "") {
          value.unshift();
        }
      }
    } else {
      value = [];
    }

    var collection = new LazyCollection(this, instance, null, value);

    await super.setInstanceProperty(instance, property, collection);

    if (this.lazy) {
      return instance;
    } else {
      await collection.load();
      return instance;
    }
  }
}
