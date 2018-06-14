import { AbstractStorageService } from "../AbstractStorageService";
import { getHashMapKeys } from "../../Util/Util";

export class AbstractJsonBasedStorageService extends AbstractStorageService {
  storage = null;

  set(key, value) {
    this.storage[key] = value;
  }

  get(key) {
    return this.storage[key];
  }

  getObjects(repository) {
    var modelName = repository.getModelName(),
      length = modelName.length,
      objects = [];

    for (var key in this.storage) {
      if (this.storage.hasOwnProperty(key)) {
        if (key.substring(0, length) === modelName) {
          objects.push(JSON.parse(this.storage[key]));
        }
      }
    }
    return objects;
  }

  async filter(repository, filterCallback) {
    var modelName = repository.getModelName(),
      length = modelName.length,
      keys = getHashMapKeys(this.storage),
      objects = [];

    for (const key of keys) {
      if (key.substring(0, length) === modelName) {
        var object = JSON.parse(this.storage[key]);
        const match = await filterCallback(object);

        if (match) {
          objects.push(object);
        }
      }
    }

    return objects;
  }

  setObject(repository, object) {
    var modelName = repository.getModelName();
    this.set(modelName + "-" + object.uuid, JSON.stringify(object));
  }

  getObject(repository, uuid) {
    var modelName = repository.getModelName();
    return JSON.parse(this.get(modelName + "-" + uuid));
  }

  removeObject(repository, uuid) {
    var modelName = repository.getModelName();
    return delete this.storage[modelName + "-" + uuid];
  }
}
