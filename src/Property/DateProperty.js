import { IntegerProperty } from "./IntegerProperty";

export class DateProperty extends IntegerProperty {
  constructor({ autoUpdate = false, ...rest } = {}) {
    super({ ...rest, autoUpdate });
  }

  async getInstanceProperty(instance, property) {
    if (this.autoUpdate) {
      var now = Date.now();
      var date = new Date();
      date.setTime(now);
      await super.setInstanceProperty(instance, property, date);
      return now;
    } else {
      var value = await super.getInstanceProperty(instance, property);

      if (value instanceof Date) {
        value = value.getTime();
      } else {
        value = 0;
      }
      return value;
    }
  }

  async setInstanceProperty(instance, property, value) {
    var time = parseInt(value, 10);
    if (isNaN(time)) {
      time = 0;
    }
    var date = new Date();
    date.setTime(time);
    await super.setInstanceProperty(instance, property, date);
    return instance;
  }
}
