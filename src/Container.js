export class Container {
  keys = [];
  values = [];

  set(key, value) {
    const index = this.indexOf(key);

    if (index > -1) {
      this.values[index] = value;
    } else {
      this.keys.push(key);
      this.values.push(value);
    }
    return value;
  }

  get(key) {
    const index = this.indexOf(key);

    if (index > -1) {
      return this.values[index];
    }

    return undefined;
  }

  indexOf(key) {
    const arrayKey = Array.isArray(key) ? key : [key];
    for (let i = 0; i < this.keys.length; i++) {
      const currentKey = this.keys[i];

      if (currentKey.length !== arrayKey.length) {
        continue;
      }

      let matches = true;

      for (let k = 0; k < arrayKey.length; k++) {
        if (arrayKey[k] !== currentKey[k]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return i;
      }
    }
    return -1;
  }

  createInstance(Ctor, args) {
    const factory = this.get([Ctor, "factory"]);
    const defaultArgs = this.get([Ctor, "defaultArgs"]);
    const argsArray = Array.isArray(args)
      ? args
      : Array.isArray(defaultArgs)
        ? defaultArgs
        : [];

    const instance =
      typeof factory === "function"
        ? factory(...argsArray)
        : new Ctor(...argsArray);

    return instance;
  }

  getSingleton(Ctor) {
    const instance = this.get([Ctor, "singleton"]);

    if (instance) {
      return instance;
    }

    return this.setSingleton(Ctor, this.createInstance(Ctor));
  }

  setSingleton(Ctor, instance) {
    return this.set([Ctor, "singleton"], instance);
  }

  setInstanceFactory(Ctor, factory) {
    return this.set([Ctor, "factory"], factory);
  }

  setInstanceDefaultArgs(Ctor, ...defaultArgs) {
    return this.set([Ctor, "defaultArgs"], defaultArgs);
  }
}
