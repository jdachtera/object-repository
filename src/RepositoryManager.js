import { Container } from "./Container";
import { BaseModel } from "./BaseModel";
import { Repository } from "./Repository";
import { InMemoryStorage } from "./Storage/JsonBasedStorage/InMemoryStorage";

const createDefaultModelClass = name => {
  class Model extends BaseModel {}

  Object.defineProperty(Model, "name", {
    value: name,
    writable: false
  });

  return Model;
};

const createDefaultRepositoryClass = name => {
  class ModelRepository extends Repository {}

  Object.defineProperty(ModelRepository, "name", {
    value: name + "Repository",
    writable: false
  });

  return ModelRepository;
};

export class RepositoryManager {
  constructor() {
    this.container = new Container();
  }

  define({
    name,
    properties = {},
    model: ModelClass,
    repository: RepositoryClass,
    backend = [InMemoryStorage]
  }) {
    const Model = ModelClass || createDefaultModelClass(name);

    Model.properties = {
      ...BaseModel.properties,
      ...((ModelClass && ModelClass.properties) || {}),
      ...properties
    };

    const ModelRepository =
      RepositoryClass || createDefaultRepositoryClass(name);

    ModelRepository.prototype.container = this.container;
    ModelRepository.prototype.modelClass = Model;
    ModelRepository.prototype.backendClass = backend;

    const repositoryInstance = new ModelRepository();

    this.container.setSingleton(ModelRepository, repositoryInstance);

    return repositoryInstance;
  }
}
