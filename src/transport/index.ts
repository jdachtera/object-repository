/**
 * Transport-as-backend layer (ARCHITECTURE.md §10): the `Backend` contract carried across a
 * process boundary. `RemoteBackend` (client) proxies to a `BackendAdapter` (server) wrapping a real
 * backend, over a `Transport`. The in-process transport runs the whole stack with no network.
 */
export { RemoteBackend, SchemaMismatchError } from "./RemoteBackend.ts";
export { BackendAdapter } from "./BackendAdapter.ts";
export { SyncTargetAdapter } from "./SyncTargetAdapter.ts";
export { InProcessTransport } from "./InProcessTransport.ts";
export type { InProcessTransportOptions } from "./InProcessTransport.ts";
export { HttpTransport } from "./http/HttpTransport.ts";
export type { HttpTransportOptions } from "./http/HttpTransport.ts";
export { createRequestListener } from "./http/createRequestListener.ts";
export type { HttpServerOptions } from "./http/createRequestListener.ts";
export { WebSocketTransport } from "./ws/WebSocketTransport.ts";
export type { WebSocketTransportOptions } from "./ws/WebSocketTransport.ts";
export { attachWebSocketServer } from "./ws/attachWebSocketServer.ts";
export type { WebSocketServerOptions } from "./ws/attachWebSocketServer.ts";
export { command, commandClient, invokeCommand, executeCommand, CommandError, isChangeDeliverable, requireIdentity, requireRole } from "./command.ts";
export type { Command, CommandMap, CommandMiddleware, CommandClient, CommandClientOptions, CommandReply, ChangeDeliverable } from "./command.ts";
