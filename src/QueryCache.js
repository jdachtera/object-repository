import { getHashMapKeys } from "./Util/Util";

export class QueryCache {
  queryCache = {};
  objectCache = {};
  expressionCache = {};

  getQueryResult(queryCollection) {
    var modelName = queryCollection.repository.getModelName();

    if (this.queryCache[modelName]) {
      var items = this.queryCache[modelName][
        this.getExpressionHash(queryCollection.expression)
      ];
      if (Array.isArray(items)) {
        return items.slice(0);
      }
    }
    return null;
  }

  getExpressionHash(expression) {
    if (expression) {
      return expression.toHash();
    } else {
      return "all";
    }
  }

  setQueryResult(queryCollection, items) {
    var modelName = queryCollection.repository.getModelName();
    if (!this.queryCache[modelName]) {
      this.queryCache[modelName] = {};
    }
    var hash = this.getExpressionHash(queryCollection.expression);

    this.queryCache[modelName][hash] = items;

    this.expressionCache[hash] = queryCollection.expression;
  }

  getCachedObject(uuid) {
    return this.objectCache[uuid] || null;
  }

  setCachedObject(object) {
    this.objectCache[object.uuid] = object;
  }

  async pushInstancesToCache(instances, repository) {
    var repositoryCache = this.queryCache[repository.getModelName()] || {};

    var hashes = getHashMapKeys(repositoryCache);

    for (const instance of instances) {
      for (const hash of hashes) {
        const expression = this.expressionCache[hash];

        const json = await repository.backend.getObjectProperties(instance);

        if (await expression.match(json)) {
          repositoryCache[hash].push(instance);
        } else {
          const index = repositoryCache[hash].indexOf(instance);
          if (index > -1) {
            repositoryCache[hash].splice(index, 1);
          }
        }
      }
    }
  }

  async removeInstancesFromCache(instances, repository) {
    const repositoryCache = this.queryCache[repository.getModelName()] || {};
    const hashes = getHashMapKeys(repositoryCache);

    for (const instance of instances) {
      for (const hash of hashes) {
        delete repositoryCache[hash];
      }
      delete this.objectCache[instance.uuid];
    }
  }

  async verifyQueryCaches(repository) {
    const repositoryCache = this.queryCache[repository.getModelName()] || {};
    const hashes = getHashMapKeys(repositoryCache);

    for (const hash of hashes) {
      const expression = this.expressionCache[hash];
      const queryCache = repositoryCache[hash];
      repositoryCache[hash] = [];

      for (const instance of queryCache) {
        const json = await repository.backend.getObjectProperties(instance);
        if (await expression.match(json)) {
          repositoryCache[hash].push(instance);
        }
      }
    }
  }
}
