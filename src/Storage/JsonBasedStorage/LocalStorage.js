import { AbstractJsonBasedStorageService } from "./AbstractJsonBasedStorageService";
import { LocalStorageService } from "./LocalStorageService";

export class LocalStorage extends AbstractJsonBasedStorageService {
  storageService = LocalStorageService;

  static isSupported() {
    return !!window.localStorage;
  }
}
