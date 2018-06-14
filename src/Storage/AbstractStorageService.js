import { resolveCallbackQueue } from "../Util/Util";

export class AbstractStorageService {
  queue = [];

  debug = true;

  initializedRepositories = {};

  repositoryQueue = {};

  saveQueue = {};
  removeQueue = {};

  locked = true;

  constructor() {
    this.lock();
    this.init();
  }

  init() {
    this.unlock();
  }

  lock() {
    this.locked = true;
  }

  getRemoveQueue(repository) {
    const queue = this.removeQueue[repository.getModelName()] || [];
    const uniqueCopy = queue.filter(
      (item, index, arr) => arr.indexOf(item, index + 1) < 0
    );
    queue.length = 0;
    return uniqueCopy;
  }

  getSaveQueue(repository) {
    const queue = this.saveQueue[repository.getModelName()] || [];
    const uniqueCopy = queue.filter(
      (item, index) => queue.indexOf(item, index + 1) < 0
    );
    queue.length = 0;
    return uniqueCopy;
  }

  unlock() {
    this.locked = false;
    resolveCallbackQueue(this.queue);
  }

  getRepositoryState(inRepository) {
    switch (this.initializedRepositories[inRepository.getModelName()]) {
      case "ready":
        return "ready";
        break;
      case "initializing":
        return "initializing";
        break;
      default:
        return "uninitialized";
        break;
    }
  }

  setRepositoryState(inRepository, inValue) {
    switch (inValue) {
      case "ready":
        this.initializedRepositories[inRepository.getModelName()] = "ready";
        resolveCallbackQueue(
          this.repositoryQueue[inRepository.getModelName()] || []
        );
        break;
      case "initializing":
        this.initializedRepositories[inRepository.getModelName()] =
          "initializing";
        break;
      default:
        this.initializedRepositories[inRepository.getModelName()] =
          "uninitialized";
        break;
    }
  }

  save(repository, instance) {
    const modelName = repository.getModelName();
    this.saveQueue[modelName] = this.saveQueue[modelName] || [];
    this.saveQueue[modelName].push(instance);
  }

  remove(repository, instance) {
    const modelName = repository.getModelName();
    this.removeQueue[modelName] = this.removeQueue[modelName] || [];
    this.removeQueue[modelName].push(instance);
  }

  do(asyncCallback, overrideLock) {
    if (this.locked && !overrideLock) {
      return new Promise((resolve, reject) => {
        this.queue.push(() => this.do(asyncCallback).then(resolve, reject));
      });
    } else {
      return asyncCallback();
    }
  }

  async doRepository(repository, asyncCallback) {
    const state = this.getRepositoryState(repository);

    if (
      Array.isArray(this.repositoryQueue[repository.getModelName()]) === false
    ) {
      this.repositoryQueue[repository.getModelName()] = [];
    }

    if (this.locked) {
      return new Promise((resolve, reject) => {
        this.queue.push(() =>
          this.doRepository(repository, asyncCallback).then(resolve, reject)
        );
      });
    } else if (state === "initializing" || state === "uninitialized") {
      return new Promise((resolve, reject) => {
        this.repositoryQueue[repository.getModelName()].queue.push(() =>
          this.doRepository(repository, asyncCallback).then(resolve, reject)
        );
      });
    } else {
      return asyncCallback();
    }
  }
}
