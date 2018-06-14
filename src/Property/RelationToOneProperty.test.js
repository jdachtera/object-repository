import { RelationToOneProperty } from "./RelationToOneProperty";

describe("RelationToOne property class", () => {
  it("should fetch the related object", async () => {
    class Model {}
    class Repository {
      async get(uuid) {
        return { uuid, name: "Peter" };
      }
    }

    const repository = new Repository();
    const property = new RelationToOneProperty({ repository });
    const instance = new Model();

    await property.setInstanceProperty(instance, "friend", "1");
    expect(instance.friend.uuid).toEqual("1");
    expect(instance.friend.name).toEqual("Peter");
  });

  it("should fetch the related object lazily", async () => {
    class Model {}
    class Repository {
      async get(uuid) {
        return { uuid, name: "Peter" };
      }
    }

    const repository = new Repository();
    const property = new RelationToOneProperty({ repository, lazy: true });
    const instance = new Model();

    await property.setInstanceProperty(instance, "friend", "1");
    expect(instance.friend.uuid).toEqual("1");
    expect(instance.friend.name).toBeUndefined();
    expect(await instance.friend.load()).toEqual({ name: "Peter", uuid: "1" });
  });

  it("should map the rleated object property", async () => {
    class Model {
      constructor(conf) {
        Object.assign(this, conf);
      }
    }
    class Repository {
      persist = jest.fn().mockReturnValue(new Promise(resolve => resolve()));
      add = jest.fn();
    }

    const repository = new Repository();

    const property = new RelationToOneProperty({ repository });
    const instance = new Model({
      friend: { uuid: "1", name: "Peter" }
    });

    const value = await property.getInstanceProperty(instance, "friend");
    expect(value).toEqual("1");
  });

  it("should save the related object", async () => {
    class Model {
      constructor(conf) {
        Object.assign(this, conf);
      }
    }
    class Repository {
      counter = 1;
      persist = jest.fn().mockReturnValue(new Promise(resolve => resolve()));
      save(object) {
        object.uuid = (this.counter++).toString();
      }
    }

    const repository = new Repository();

    const property = new RelationToOneProperty({ repository });
    const instance = new Model({
      friend: { name: "Peter" }
    });

    const value = await property.getInstanceProperty(instance, "friend");
    expect(value).toEqual("1");
  });
});
