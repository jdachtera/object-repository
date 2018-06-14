import { AbstractJsonBasedStorageService } from "./AbstractJsonBasedStorageService";

export class CookieStorageService extends AbstractJsonBasedStorageService {
  get(key) {
    return enyo.getCookie(key);
  }

  set(key, value) {
    enyo.setCookie(key, value);
  }

  removeObject(repository, uuid) {
    var modelName = repository.getModelName();
    enyo.setCookie(this.storage[modelName + "-" + uuid], "", { "Max-Age": 0 });
  }
}
