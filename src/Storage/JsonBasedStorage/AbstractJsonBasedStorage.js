import { AbstractStorage } from "../AbstractStorage";
import { AbstractJsonBasedStorageService } from "./AbstractJsonBasedStorageService";
import { Compare } from "../../Expression/Compare";
import { In } from "../../Expression/In";

export class AbstractJsonBasedStorage extends AbstractStorage {
  storageService = AbstractJsonBasedStorageService;

  static isSupported() {
    return false;
  }

  /**
   * Returns the objects saved in the localStorage or an empty array
   * @return {Array}
   */
  getObjects() {
    return this.service.getObjects(this.repository) || [];
  }

  async persist() {
    var saveQueue = this.getSaveQueue();
    var removeQueue = this.getRemoveQueue();

    for (const instance of saveQueue) {
      if (!(instance.uuid instanceof String && instance.uuid.length === 32)) {
        instance.uuid = this.getUUID();
      }

      const json = await this.getObjectProperties(instance);
      this.service.setObject(this.repository, json);
    }

    for (const instance of removeQueue) {
      this.service.removeObject(this.repository, instance.uuid);
    }

    return { savedInstances: saveQueue, removedInstances: removeQueue };
  }

  async query(queryCollection) {
    if (queryCollection.expression.property === "uuid") {
      if (
        queryCollection.expression.constructore === Compare &&
        queryCollection.expression.comparator === "="
      ) {
        var json = this.service.getObject(
          this.repository,
          queryCollection.expression.value
        );

        const instances = await this.getObjectInstances([json]);
        return instances;
      } else if (queryCollection.expression.constructor === In) {
        const jsonObjects = queryCollection.expression.values.map(uuid =>
          this.service.getObject(this.repository, uuid)
        );

        const instances = await this.getObjectInstances(jsonObjects);
        return instances;
      }
    }

    const jsonObjects = await this.service.filter(this.repository, json =>
      this.match(json, queryCollection.expression)
    );

    const instances = await this.getObjectInstances(jsonObjects);

    return instances;
  }

  async queryUuids(queryCollection) {
    return this.service
      .filter(this.repository, json =>
        this.match(json, queryCollection.expression)
      )
      .map(object => object.uuid);
  }

  async match(json, expression) {
    const result = expression ? await expression.match(json) : true;
    return result;
  }
}
