import { RelationToManyProperty } from "./RelationToManyProperty";

describe("RelationToManyProperty property class", () => {
  it("should set the collection property and query related object", async () => {
    class Model {
      static properties = {};
    }
    class Repository {
      modelClass = Model;
      async persist() {}
      add() {}
      all() {
        return new QueryCollection();
      }
      async query() {}
      async queryUuids() {}
    }

    class QueryCollection {
      filter() {
        return this;
      }
      async list() {
        return [{ uuid: "1" }, { uuid: "2" }, { uuid: "3" }];
      }
    }

    const repository = new Repository();

    const property = new RelationToManyProperty({ repository });
    const instance = new Model();

    await property.setInstanceProperty(instance, "friends", ["1", "2", "3"]);
    expect(instance.friends.toArray()).toEqual([
      { uuid: "1" },
      { uuid: "2" },
      { uuid: "3" }
    ]);
  });

  it("should set the collection property and lazy load related objects", async () => {
    class Model {
      static properties = {};
    }
    class Repository {
      modelClass = Model;
      async persist() {}
      add() {}
      all() {
        return new QueryCollection();
      }
      async query() {}
      async queryUuids() {}
    }

    class QueryCollection {
      filter() {
        return this;
      }
      async list() {
        return [{ uuid: "1" }, { uuid: "2" }, { uuid: "3" }];
      }
    }

    const repository = new Repository();

    const property = new RelationToManyProperty({ repository, lazy: true });
    const instance = new Model();

    await property.setInstanceProperty(instance, "friends", ["1", "2", "3"]);
    expect(instance.friends.toArray()).toEqual([]);

    await instance.friends.load();
    await expect(instance.friends.toArray()).toEqual([
      { uuid: "1" },
      { uuid: "2" },
      { uuid: "3" }
    ]);
  });

  it("should map the collection property", async () => {
    class Model {
      static properties = {};
      constructor(conf) {
        Object.assign(this, conf);
      }
    }
    class Repository {
      modelClass = Model;
      persist = jest.fn().mockReturnValue(new Promise(resolve => resolve()));
      add = jest.fn();
    }

    const repository = new Repository();

    const property = new RelationToManyProperty({ repository, lazy: true });
    const instance = new Model({
      friends: [{ uuid: "1" }, { uuid: "2" }, { uuid: "3" }]
    });

    const value = await property.getInstanceProperty(instance, "friends");
    expect(value).toEqual(["1", "2", "3"]);
  });

  it("should save the collection property", async () => {
    class Model {
      static properties = {};
      constructor(conf) {
        Object.assign(this, conf);
      }
    }
    class Repository {
      modelClass = Model;
      counter = 1;
      persist = jest.fn().mockReturnValue(new Promise(resolve => resolve()));
      save(object) {
        object.uuid = (this.counter++).toString();
      }
    }

    const repository = new Repository();

    const property = new RelationToManyProperty({ repository, lazy: true });
    const instance = new Model({
      friends: [{ name: "Peter" }, { name: "John" }, { name: "James" }]
    });

    const value = await property.getInstanceProperty(instance, "friends");
    expect(value).toEqual(["1", "2", "3"]);
  });
});
