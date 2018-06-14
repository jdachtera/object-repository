import { CookieStorageService } from "./CookieStorageService";
import { AbstractJsonBasedStorage } from "./AbstractJsonBasedStorage";

export class CookieStorage extends AbstractJsonBasedStorage {
  storageService = CookieStorageService;

  static isSupported() {
    var supported = false;

    enyo.setCookie("test", 1);
    if (enyo.getCookie("test")) {
      enyo.setCookie("test", "", { "Max-Age": 0 });
      supported = true;
    }

    return supported;
  }
}
