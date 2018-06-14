import { AbstractProperty } from "./AbstractProperty";

export class LazyObject {
  constructor({
    property = null,
    uuid = "",
    instance = null,
    repository = null,
    ...rest
  }) {
    Object.assign(this, {
      property,
      uuid,
      instance,
      repository,
      ...rest
    });
  }

  async load() {
    if (!this.instance) {
      this.instance = await this.property.repository.get(this.uuid);
    }
    return this.instance;
  }
}

export class RelationToOneProperty extends AbstractProperty {
  constructor({
    remoteProperty = "",
    repository = null,
    lazy = false,
    ...rest
  } = {}) {
    super({ remoteProperty, lazy, repository, ...rest });
  }

  async setInstanceProperty(instance, property, value) {
    if (!value) {
      await super.setInstanceProperty(instance, property, null);
      return instance;
    } else {
      var lazyObject = new LazyObject({
        property: this,
        uuid: value
      });

      if (this.lazy) {
        await super.setInstanceProperty(instance, property, lazyObject);
        return instance;
      } else {
        const object = await lazyObject.load();
        await super.setInstanceProperty(instance, property, object);
        return instance;
      }
    }
  }

  async getInstanceProperty(instance, property) {
    var object = await super.getInstanceProperty(instance, property);

    if (object) {
      if (object.uuid) {
        return object.uuid;
      } else {
        this.repository.save(object);
        await this.repository.persist();
        return object.uuid;
      }
    } else {
      return "";
    }
  }
}
