import { TextProperty } from "./TextProperty";

export class JSONDataProperty extends TextProperty {
  async preStringify(value, property, instance) {
    return value;
  }

  async postParse(json, property, instance) {
    return json;
  }

  async getInstanceProperty(instance, property) {
    return (
      JSON.stringify(
        await this.preStringify(
          await super.getInstanceProperty(instance, property),
          property,
          instance
        )
      ) || ""
    );
  }

  async setInstanceProperty(instance, property, value) {
    await super.setInstanceProperty(
      instance,
      property,
      await this.postParse(JSON.parse(value), property, instance)
    );

    return instance;
  }
}
