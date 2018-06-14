import { AbstractJsonBasedStorage } from "./AbstractJsonBasedStorage";

export class SessionStorage extends AbstractJsonBasedStorage {
  storageService = SessionStorageService;

  static isSupported() {
    return !!window.sessionStorage;
  }
}
