import { Container } from "./Container";

describe("container", () => {
  it("should set and get objects using array key", () => {
    const container = new Container();

    const date = new Date();
    const key = [123, Function, Date];

    container.set(key, date);

    expect(container.get(key)).toEqual(date);
  });

  it("should construct and provide a singleton", () => {
    const container = new Container();

    class Ctor {}

    const instance = container.getSingleton(Ctor);

    expect(container.getSingleton(Ctor)).toEqual(instance);
  });

  it("should provide args to the singleton", () => {
    const container = new Container();

    class Ctor {
      constructor(setMe = false) {
        this.setMe = setMe;
      }
    }

    container.setInstanceDefaultArgs(Ctor, true);

    const instance = container.getSingleton(Ctor);

    expect(container.getSingleton(Ctor)).toEqual(instance);
    expect(instance.setMe).toEqual(true);
  });

  it("should use the factory to to construct the singleton", () => {
    const container = new Container();

    class Ctor {
      constructor(setMe = false) {
        this.setMe = setMe;
      }
    }

    class NewImplementation extends Ctor {}

    container.setInstanceDefaultArgs(Ctor, true);
    container.setInstanceFactory(
      Ctor,
      (...args) => new NewImplementation(...args)
    );

    const instance = container.getSingleton(Ctor);

    expect(instance instanceof NewImplementation).toEqual(true);
    expect(container.getSingleton(Ctor)).toEqual(instance);
    expect(instance.setMe).toEqual(true);
  });
});
