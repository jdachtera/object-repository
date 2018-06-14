import { text } from "./Property";

import { RelationToManyProperty } from "./Property/RelationToManyProperty";
import {
  RelationToOneProperty,
  LazyObject
} from "./Property/RelationToOneProperty";
import { Collection } from "./Collection/Collection";
import { getHashMapKeys } from "./Util/Util";
import { LazyCollection } from "./Collection/LazyCollection";

export class BaseModel {
  static properties = { uuid: text({ length: 32, unique: true }) };

  uuid = "";

  static addProperty(ModelClass, propertyName, property) {
    ModelClass.properties[propertyName] = property;
  }

  constructor(data) {
    for (const propertyName of Object.keys(this.constructor.properties)) {
      const property = this.constructor.properties[propertyName];

      if (property instanceof RelationToManyProperty) {
        const value = Array.isArray(data[propertyName])
          ? data[propertyName]
          : [];

        const uuids = typeof value[0] === "string" ? value : null;
        const items = typeof value[0] === "string" ? null : value;

        if (uuids) {
          this[propertyName] = new LazyCollection(property, this, null, uuids);
        } else {
          this[propertyName] = new Collection(property, this, null, uuids);
          this[propertyName].addArray(items);
        }
      } else if (data.hasOwnProperty(propertyName)) {
        this[propertyName] = data[propertyName];
      }
    }
  }

  setProperty(key, value) {
    this[key] = value;
  }

  getProperty(key) {
    return this[key];
  }

  toJSON() {
    let json = {};
    let properties = getHashMapKeys(this.constructor.properties);

    properties.push("uuid");

    for (const name of properties) {
      const value = this[name],
        property = this.constructor.properties[name];
      if (property && property instanceof RelationToManyProperty) {
        json[name] = value.map(item => item.uuid);
      } else if (property && property instanceof RelationToOneProperty) {
        json[name] = value && value.uuid;
      } else {
        json[name] = value && value.toString();
      }
    }

    return json;
  }

  addMMObject(name, object) {
    var property = this.ctor.properties[name];
    if (property instanceof RelationToManyProperty && object) {
      var index = this[name].indexOf(object);
      if (index === -1) {
        this[name].push(object);
        if (property.remoteProperty) {
          const remoteProperty = property.repository.getModelProperty(
            property.remoteProperty
          );
          if (remoteProperty instanceof RelationToManyProperty) {
            object._addMMObject(property.remoteProperty, this);
          } else if (remoteProperty instanceof RelationToOneProperty) {
            object.setProperty(property.remoteProperty, this);
          }
        }
      }
    }
  }

  removeMMObject(name, object) {
    const property = this.constructor.properties[name];
    if (property instanceof RelationToManyProperty) {
      var index = this[name].indexOf(object);
      if (index !== -1) {
        this[name].splice(index, index + 1);
        if (property.remoteProperty) {
          const remoteProperty = property.repository.getModelProperty(
            property.remoteProperty
          );

          if (remoteProperty instanceof RelationToManyProperty) {
            object._removeMMObject(property.remoteProperty, this);
          } else if (remoteProperty instanceof RelationToOneProperty) {
            object.setProperty(property.remoteProperty, null);
          }
        }
      }
    }
  }

  _relatedObjectChanged(property, object, old) {
    var conf = this.persisted[property];
    if (conf.remoteProperty) {
      var remoteConf = this.container.getPropertyConf(
        conf.repositoryKind,
        conf.remoteProperty
      );

      if (remoteConf.type === "RelationToMany") {
        if (object) {
          object._addMMObject(conf.remoteProperty, this);
        }
        if (old) {
          object._removeMMObject(conf.remoteProperty, this);
        }
      } else if (remoteConf.type === "RelationToOne") {
        if (object) {
          object.setProperty(conf.remoteProperty, this);
        }
        if (old) {
          old.setProperty(conf.remoteProperty, null);
        }
      }
    }
  }

  _destroyRelations() {
    var properties = Object.keys(this.persisted);

    for (const property of properties) {
      const conf = this.persisted[property];
      if (conf.type === "RelationToMany") {
        const repository = this.container.getSingleton(conf.repositoryClass);
        const collection = this.getProperty(property);

        for (const object of collection) {
          this.removeMMObject(property, object);
          if (conf.owner) {
            repository.remove(object);
          } else {
            repository.save(object);
          }
        }
      } else if (conf.type === "RelationToOne") {
        const object = this.getProperty(property);
        this.setProperty(property, null);
        if (object) {
          const repository = this.container.getSingleton(conf.repositoryClass);
          if (conf.owner) {
            repository.remove(object);
          } else {
            repository.save(object);
          }
        }
      }
    }
  }

  async loadRelations() {
    await Promise.all(
      Object.keys(this.constructor.properties).map(async propertyName => {
        const value = this[propertyName];
        const property = this.constructor.properties[propertyName];

        if (
          (property instanceof RelationToManyProperty ||
            property instanceof RelationToOneProperty) &&
          (value instanceof LazyCollection || value instanceof LazyObject) &&
          !property.lazy
        ) {
          await this[propertyName].load();
        }
      })
    );
  }
}
