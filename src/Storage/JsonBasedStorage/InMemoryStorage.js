import { InMemoryStorageService } from "./InMemoryStorageService";
import { AbstractJsonBasedStorage } from "./AbstractJsonBasedStorage";

export class InMemoryStorage extends AbstractJsonBasedStorage {
  constructor({ repository, container, storageService }) {
    super({ repository, container, storageService: InMemoryStorageService });
  }

  static isSupported() {
    return true;
  }
}
