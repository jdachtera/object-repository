/** `object-repository/mongo` — the MongoDB document store (expression AST → native Mongo filter push-down). */
export { MongoBackend, compileMongoFilter, objectIdIdentity } from "./MongoBackend.ts";
export type {
  MongoDatabase,
  MongoCollection,
  MongoCursor,
  MongoFindOptions,
  MongoFilter,
  MongoIdentity,
  MongoRawQuery,
  MongoBackendOptions
} from "./MongoBackend.ts";
