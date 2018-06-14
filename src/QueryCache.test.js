import { QueryCache } from "./QueryCache";
import { QueryCollection } from "./QueryCollection";

describe("QueryCache", () => {
  it("should cache a single object", async () => {
    const queryCache = new QueryCache();

    const currentCacheEntry = queryCache.getCachedObject("123");
    expect(currentCacheEntry).toEqual(null);

    const object = { uuid: "123" };

    queryCache.setCachedObject(object);
    expect(queryCache.getCachedObject("123")).toEqual(object);
  });

  it("should cache a query result", async () => {
    const queryCache = new QueryCache();

    class MockBackend {
      getObjectProperties(instance) {
        return {
          uuid: instance.uuid
        };
      }
    }

    class MockRepository {
      backend = new MockBackend();
      getModelName() {
        return "MockModel";
      }
    }

    class MockExpression {
      toHash() {
        return "hash123";
      }
      match = jest
        .fn()
        .mockReturnValueOnce(new Promise(resolve => resolve(true)));
    }

    class MockQueryCollection {
      repository = new MockRepository();
      expression = new MockExpression();

      toHash() {
        return "hash123";
      }
    }

    class Model {
      constructor(props) {
        Object.assign(this, props);
      }
    }

    const queryCollection = new MockQueryCollection();

    const currentCacheEntry = queryCache.getQueryResult(queryCollection);
    expect(currentCacheEntry).toEqual(null);

    const instances = [
      new Model({ uuid: "1" }),
      new Model({ uuid: "2" }),
      new Model({ uuid: "3" })
    ];

    queryCache.setQueryResult(queryCollection, instances);
    const newCacheEntry = queryCache.getQueryResult(queryCollection);

    expect(newCacheEntry).toEqual(instances);
    const newInstance = new Model({ uuid: "4" });

    await queryCache.pushInstancesToCache(
      [newInstance],
      queryCollection.repository
    );

    const updatedCollectionCache = queryCache.getQueryResult(queryCollection);

    expect(updatedCollectionCache).toEqual([
      instances[0],
      instances[1],
      instances[2],
      newInstance
    ]);
  });
});
