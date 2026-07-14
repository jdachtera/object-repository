import { describe, it, expect, vi } from "vitest";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import type { AddressInfo } from "node:net";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { WebSocketTransport } from "./ws/WebSocketTransport.js";
import { attachWebSocketServer } from "./ws/attachWebSocketServer.js";
import { RemoteBackend } from "./RemoteBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { gt } from "../expressions/builders.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { generateUuid } from "../core/uuid.js";

const ctx = SYSTEM_CONTEXT;

async function startServer(
  backend: InMemoryBackend
): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  attachWebSocketServer(wss, new BackendAdapter(backend));
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const port = (wss.address() as AddressInfo).port;
  return { wss, url: `ws://127.0.0.1:${port}` };
}

// `ws`'s client implements the browser-style addEventListener surface the transport expects.
const transportFor = (url: string) =>
  new WebSocketTransport(url, { WebSocket: WsClient as unknown as never });

describe("WebSocket transport", () => {
  it("runs the full typed ORM over a WebSocket connection", async () => {
    const inner = new InMemoryBackend();
    const { wss, url } = await startServer(inner);
    const transport = transportFor(url);
    try {
      const orm = new RepositoryManager({
        backend: new RemoteBackend(transport, inner.capabilities)
      });
      const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });

      users.save(users.createInstance({ name: "Peter", age: 35 }));
      users.save(users.createInstance({ name: "John", age: 40 }));
      await users.persist();

      expect(await users.all().list()).toHaveLength(2);
      const over38 = await users.all().filter(gt("age", 38)).list();
      expect(over38.map((u) => u.name)).toEqual(["John"]);
    } finally {
      transport.close();
      wss.close();
    }
  });

  it("delivers the change feed over the duplex connection", async () => {
    const inner = new InMemoryBackend();
    const { wss, url } = await startServer(inner);
    const transport = transportFor(url);
    const events: Array<{ uuid: string; model: string; kind: string }> = [];
    const unsubscribe = transport.subscribe!(
      { method: "changes", params: {} },
      (event) => events.push(event as (typeof events)[number]),
      ctx
    );
    try {
      await vi.waitFor(
        async () => {
          inner.save("User", { uuid: generateUuid(), name: "x" }, ctx);
          await inner.persist(ctx);
          expect(events.length).toBeGreaterThan(0);
        },
        { timeout: 2000, interval: 50 }
      );
      expect(events[0]).toMatchObject({ model: "User", kind: "saved" });
    } finally {
      unsubscribe();
      transport.close();
      wss.close();
    }
  });

  it("rejects in-flight requests when the connection closes (no hung promises)", async () => {
    // A controllable fake socket: open it, let a request go out (server never replies), then fire
    // `close`. The in-flight request must reject rather than hang forever.
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const fake = {
      readyState: 1,
      send: () => {},
      close: () => {},
      addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => {
        handlers[type] = fn;
      }
    };
    const FakeWebSocket = function () {
      return fake;
    } as unknown as never;

    const transport = new WebSocketTransport("ws://unused", { WebSocket: FakeWebSocket });
    const inflight = transport.request({ method: "handshake", params: {} }, ctx);
    handlers.open!({}); // resolve the connection so the request is sent and becomes pending
    await Promise.resolve();
    await Promise.resolve();
    handlers.close!({}); // server/socket dropped — the reply will never arrive
    await expect(inflight).rejects.toThrow(/closed/i);
  });
});
