import { AbstractJsonBasedStorageService } from "./AbstractJsonBasedStorageService";

export class InMemoryStorageService extends AbstractJsonBasedStorageService {
  storage = {};
}
