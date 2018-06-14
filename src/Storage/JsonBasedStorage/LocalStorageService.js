import { AbstractJsonBasedStorageService } from "./AbstractJsonBasedStorageService";

export class LocalStorageService extends AbstractJsonBasedStorageService {
  storage = window.localStorage;
}
