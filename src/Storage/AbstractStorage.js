import { AbstractStorageService } from "./AbstractStorageService";
import { QueryCache } from "../QueryCache";
import { flatten, getHashMapKeys } from "../Util/Util";
import Expression from "../Expression";
import { RelationToOneProperty } from "../Property/RelationToOneProperty";
import { RelationToManyProperty } from "../Property/RelationToManyProperty";

export class AbstractStorage {
  repository = null;
  container = null;
  service = null;
  queryCache = null;

  static isSupported() {
    return false;
  }

  constructor({ repository, container, storageService }) {
    this.container = container;
    this.repository = repository;
    this.storageService = storageService;
    this.queryCache = this.container.getSingleton(QueryCache);

    this.initService();
    this.init();
  }

  initService() {
    this.service = this.container.getSingleton(this.storageService);
  }

  init() {}

  save(instance) {
    this.service.save(this.repository, instance);
  }

  remove(instance) {
    this.service.remove(this.repository, instance);
  }

  getSaveQueue() {
    return this.service.getSaveQueue(this.repository);
  }

  getRemoveQueue() {
    return this.service.getRemoveQueue(this.repository);
  }

  getUUID() {
    var s = [];
    var hexDigits = "0123456789ABCDEF";
    for (var i = 0; i < 32; i++) {
      s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
    }
    s[12] = "4";
    s[16] = hexDigits.substr((s[16] & 0x3) | 0x8, 1);

    var uuid = s.join("");
    return uuid;
  }

  async getObjectProperties(instance) {
    var object = {};
    var properties = this.getProperties();

    for (const propertyName of properties) {
      const property = this.repository.modelClass.properties[propertyName];

      const value = await property.getInstanceProperty(instance, propertyName);

      object[propertyName] = value;
    }
    return object;
  }

  async setObjectProperties(instance, json) {
    var properties = this.getProperties();

    for (const property of properties) {
      await this.repository.modelProperties[property].setInstanceProperty(
        instance,
        property,
        json[property]
      );
    }

    return instance;
  }

  async getObjectInstances(inArray) {
    var properties = this.repository.modelClass.properties;

    if (inArray.length === 0) {
      return [];
    }

    const outArray = inArray.map(json => {
      let instance = this.queryCache.getCachedObject(json.uuid);

      if (instance) {
        json = null;
      } else {
        instance = new this.repository.modelClass(json);
        this.queryCache.setCachedObject(instance);
      }
      return { json: json, instance: instance };
    });

    for (const propertyName of Object.keys(properties)) {
      const property = properties[propertyName];

      // Prefetch related objects in one go
      if (
        property instanceof RelationToOneProperty ||
        (property instanceof RelationToManyProperty && !property.lazy)
      ) {
        var uuids = flatten(
          outArray.filter(obj => !!obj.json).map(obj => {
            var json = obj.json;
            return Array.isArray(json[propertyName])
              ? json[propertyName]
              : json[propertyName].split(",");
          })
        );

        await property.repository
          .all()
          .filter(Expression.in("uuid", uuids))
          .list();
      }
    }

    return outArray.map(obj => obj.instance);
  }

  persist() {}

  query(queryCollection, context, callback) {}

  queryJson(queryCollection, context, callback) {}

  getProperties() {
    return Object.keys(this.repository.modelClass.properties);
  }
}
