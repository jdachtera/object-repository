export class SessionStorageService extends AbstractJsonBasedStorageService {
  storage = window.sessionStorage;
}
