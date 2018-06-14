import isString from "is-string";
import { get } from "lodash";
import { InMemoryStorage } from "./Storage/JsonBasedStorage/InMemoryStorage";
import { QueryCache } from "./QueryCache";
import { Compare } from "./Expression/Compare";
import { In } from "./Expression/In";
import { ContainsExpression } from "./Expression/ContainsExpressions";
import { Between } from "./Expression/Between";
import { And } from "./Expression/And";
import { Or } from "./Expression/Or";
import Expression from "./Expression";
import { union, log } from "./Util/Util";
import { QueryCollection } from "./QueryCollection";
import { BaseModel } from "./BaseModel";

export class Repository {
  queryCache = null;

  _uuidQueue = [];
  _uuidPromises = [];
  _uuidImmediate = null;

  //* Constructs a new Repository
  constructor() {
    if (this.constructor === Repository) {
      throw 'You cannot use "Repository" directly. Please define your own subClass.';
    }

    this.queryCache = this.container.getSingleton(QueryCache);
    this.initBackend();
  }

  //* Returns the configuration object for a given repoistory and property
  getModelProperty(propertyName) {
    return this.modelClass.properties[propertyName];
  }

  addModelProperty(propertyName, property) {
    BaseModel.addProperty(this.modelClass, propertyName, property);
  }

  //* Returns this models name for use as Database name
  getModelName() {
    return this.modelClass.name;
  }

  findBackendClass() {
    if (Array.isArray(this.backendClass)) {
      for (const BackendCtor of this.backendClass) {
        if (BackendCtor && BackendCtor.isSupported()) {
          return BackendCtor;
          break;
        }
      }
    } else {
      const BackendCtor = this.backendClass;

      if (BackendCtor.isSupported()) {
        return BackendCtor;
      }
    }
  }

  //* @protected
  initBackend() {
    const BackendCtor = this.findBackendClass();

    if (!BackendCtor) {
      throw new Error("None of the specified storage backends are supported.");
    }

    this.backend = new BackendCtor({
      repository: this,
      container: this.container
    });
  }

  //* Returns a new QueryCollection for the repository which matches all items
  all() {
    return new QueryCollection(this);
  }

  //* Retrieves an instance of this repository by it's uuid
  async get(uuid) {
    return new Promise(resolve, reject => {
      clearImmediate(this._uuidImmediate);
      this._uuidQueue[uuid] = { resolve, reject };

      this._scheduledImmediate = setImmediate(() => {
        const queue = this._uuidQueue;
        this._uuidQueue = {};

        this.all()
          .filter(Expression.in("uuid", [...uuids]))
          .each(item => {
            queue[item.uuid].resolve(item);
            delete queue[item.uuid];
          })
          .then(() => {
            for (const uuid of Object.keys(queue)) {
              queue[item.uuid].reject();
            }
          });
      });
    });
  }

  //* Execute a given QueryCollection
  async query(queryCollection) {
    var cache = this.queryCache.getQueryResult(queryCollection);
    if (cache) {
      this.sortQueryCollection(queryCollection, cache);
      return cache;
    } else {
      const expression = await this.preprocessExpression(
        queryCollection.expression
      );

      // Catch uuid queries
      if (
        expression instanceof Compare &&
        expression.property === "uuid" &&
        expression.comparator === "="
      ) {
        return this.get(expression.value);
      } else if (expression instanceof In && expression.property === "uuid") {
        const cachedObjects = [];
        const uncachedUuids = [];

        for (const uuid of expression.values) {
          const cachedObject = this.queryCache.getCachedObject(uuid);
          if (cachedObject) {
            cachedObjects.push(cachedObject);
          } else {
            uncachedUuids.push(uuid);
          }
        }

        if (cachedObjects.length) {
          if (cachedObjects.length === expression.values.length) {
            return cachedObjects;
          } else {
            const items = union(
              await Promise.all(uncachedUuids.map(uuid => this.get(uuid))),
              cachedObjects
            );

            this.sortQueryCollection(queryCollection, items);
            this.queryCache.setQueryResult(queryCollection, items);
            return items;
          }
        }
      }
      const processedQueryCollection = queryCollection.clone({
        expression
      });

      const items = await this.backend.query(processedQueryCollection);      
      await Promise.all(items.map(item => item.loadRelations()));
      return items;
    }
  }

  sortQueryCollection(queryCollection, items) {
    if (queryCollection.order.length) {
      items.sort(function(a, b) {
        var i, order, aProp, bProp, result;
        for (var i = 0; i < queryCollection.order.length; i++) {
          order = queryCollection.order[i];
          aProp = get(a, order.property);
          bProp = get(b, order.property);
          result = !order.descending
            ? aProp > bProp
              ? 1
              : aProp < bProp
                ? -1
                : 0
            : aProp < bProp
              ? 1
              : aProp > bProp
                ? -1
                : 0;
          if (result !== 0) {
            break;
          }
        }
        return result;
      });
    }
    return items;
  }

  //* Execute a given QueryCollection and retrieve only the matching uuids
  //* @protected
  async queryUuids(queryCollection) {
    var cache = this.queryCache.getQueryResult(queryCollection);

    if (cache) {
      return cache;
    } else {
      let expression = this.preprocessExpression(queryCollection.expression);
      const cachedObjects = [];

      // Catch uuid queries
      if (
        expression instanceof Compare &&
        expression.property === "uuid" &&
        expression.comparator === "="
      ) {
        const cachedObject = db.QueryCache.getCachedObject(expression.value);
        if (cachedObject) {
          return [null, cachedObject.uuid];
        }
      } else if (expression instanceof In && expression.property === "uuid") {
        for (const uuid of expression.values) {
          const cachedObject = this.queryCache.getCachedObject(uuid);
          if (cachedObject) {
            cachedObjects.push(cachedObject.uuid);
          } else {
            newValues.push(uuid);
          }
        }

        if (cachedObjects.length) {
          if (cachedObjects.length === expression.values.length) {
            return cachedObjects;
          }
          expression = expression.clone({ values: newValues });
        }
      }

      rewrittenQueryCollection = queryCollection.clone({
        expression: expression
      });

      const items = await this.backend.queryUuids(rewrittenQueryCollection);
      return union(items, cachedObjects);
    }
  }

  //* Preprocess a query expression for this repository.
  //* This delegates expressions concerning related properties to their corresponding repositories.
  // @protected
  preprocessExpression(expression) {
    switch (expression.constructor) {
      case Compare:
      case In:
      case ContainsExpression:
      case Between:
        var propertyParts = String.prototype.split.call(
          expression.property,
          "."
        );

        if (propertyParts.length > 1) {
          const localProperty = propertyParts.shift();
          const propertyConf = Repository.getPropertyConf(this, localProperty);
          const remoteRepository = this.repository(
            propertyConf.repositoryClass
          );
          const queryCollection = new QueryCollection(remoteRepository);
          const newExpression = expression.clone({
            property: propertyParts.join(".")
          });

          if (remoteRepository) {
            queryCollection.filter(newExpression).listUuids(uuids => {
              if (propertyConf.type === "RelationToOne") {
                return Expression.in(localProperty, uuids);
              } else if (propertyConf.type === "RelationToMany") {
                var expressions = uuids.map(uuid =>
                  Expression.contains(localProperty, uuid)
                );

                return new Or(expressions);
              }
            });
          } else {
            throw "Invalid Query: Property " +
              localProperty +
              " of model " +
              this.modelClass +
              " does not exist or is no relation";
          }
        } else {
          return expression;
        }
        break;
      case And:
      case Or:
        const expressions = expression.expressions.map(expression =>
          this.preprocessExpression(expression)
        );
        return new expression.constructor({ expressions });
        break;
      default:
        return expression;

        break;
    }
  }

  //* Persists pending changes to the repository
  async persist() {
    const { savedInstances, removedInstances } = await this.backend.persist();

    log("persisted", "saved:", savedInstances, "removed:", removedInstances);

    await this.queryCache.removeInstancesFromCache(removedInstances, this);
    await this.queryCache.pushInstancesToCache(savedInstances, this);
  }

  //* Queues an instance for saving
  save(instance) {
    this.backend.save(instance);
    return this;
  }

  //* Queues an instance for removal
  remove(instance) {
    this.backend.remove(instance);
    instance._destroyRelations();
    return this;
  }

  createInstance(data) {
    return new this.modelClass(data);
  }
}
