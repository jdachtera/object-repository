export class AbstractProperty {
  unique = false;

  constructor(conf = {}) {
    for (const property of Object.keys(conf)) {
      if (conf[property] !== undefined) {
        this[property] = conf[property];
      }
    }
  }

  async getInstanceProperty(instance, property) {
    const value = instance[property] || "";
    return value;
  }

  async setInstanceProperty(instance, property, value) {
    instance[property] = value;
    return instance;
  }
}
