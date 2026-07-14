/**
 * Transport/sync hardening: the network seam must survive malformed input from an untrusted client
 * rather than crash, hang, leak, or poison shared state. Each test drives a real server/socket.
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { createRequestListener } from "./http/createRequestListener.js";
import { attachWebSocketServer } from "./ws/attachWebSocketServer.js";
import { HybridLogicalClock } from "../sync/hlc.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text } from "../properties/factories.js";
import { eq } from "../expressions/builders.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

describe("WebSocket server survives malformed frames (no process crash)", () => {
  it("ignores a garbage frame and still answers the next valid request", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    attachWebSocketServer(wss, new BackendAdapter(new InMemoryBackend()));
    await new Promise<void>((r) => wss.on("listening", r));
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

    let unhandled: unknown;
    const onUnhandled = (e: unknown) => (unhandled = e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = new WsClient(url);
      await new Promise<void>((r) => client.on("open", () => r()));
      const reply = new Promise<Record<string, unknown>>((r) => client.on("message", (d) => r(JSON.parse(String(d)))));

      client.send("this is not json{{{"); // the crash frame
      client.send("null");
      client.send(JSON.stringify({ type: "nonsense" }));
      // server must still be alive to answer this
      client.send(JSON.stringify({ type: "request", id: 7, op: { method: "query", params: { plan: { model: "X", where: { type: "all" }, order: [], paging: { start: 0 } } } } }));

      const response = await reply;
      expect(response.id).toBe(7);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toBeUndefined(); // no unhandled rejection escaped
      client.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});

describe("HTTP body size cap", () => {
  const start = (maxBodyBytes?: number): Promise<{ server: Server; url: string }> =>
    new Promise((resolve) => {
      const server = createServer(createRequestListener(new BackendAdapter(new InMemoryBackend()), { maxBodyBytes }));
      server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc` }));
    });

  it("rejects an oversized body with 413 instead of buffering it", async () => {
    const { server, url } = await start(1000);
    try {
      const res = await fetch(url, { method: "POST", body: "x".repeat(5000) });
      expect(res.status).toBe(413);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("still serves a normal body", async () => {
    const { server, url } = await start();
    try {
      const res = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ method: "query", params: { plan: { model: "X", where: { type: "all" }, order: [], paging: { start: 0 } } } })
      });
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("HLC ignores a malformed remote version (no clock poisoning)", () => {
  it("keeps producing well-formed, monotonic stamps after a NaN version", () => {
    const hlc = new HybridLogicalClock("node");
    const before = hlc.now();
    hlc.update("not-a-timestamp"); // hostile/buggy peer
    hlc.update(":::");
    const after = hlc.now();
    expect(after).not.toContain("NaN");
    expect(after > before).toBe(true); // ordering still works
  });
});

describe("BackendAdapter model guard", () => {
  it("refuses reserved (_-prefixed) models over the wire", async () => {
    const adapter = new BackendAdapter(new InMemoryBackend());
    const res = await adapter.handle({ method: "query", params: { plan: { model: "_outbox", where: eq("uuid", "x").serialize(), order: [], paging: { start: 0 } } } }, SYSTEM_CONTEXT);
    expect(res.ok).toBe(false);
    expect(res.ok ? undefined : res.error?.code).toBe("FORBIDDEN_MODEL");
  });

  it("enforces an allow-list when provided (and permits listed models)", async () => {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const pub = orm.define({ name: "Public", properties: { name: text() } });
    pub.save(pub.createInstance({ name: "ok" }));
    await pub.persist();

    const adapter = new BackendAdapter(backend, undefined, undefined, ["Public"]);
    const allowed = await adapter.handle({ method: "query", params: { plan: { model: "Public", where: { type: "all" }, order: [], paging: { start: 0 } } } }, SYSTEM_CONTEXT);
    expect(allowed.ok).toBe(true);

    const denied = await adapter.handle({ method: "query", params: { plan: { model: "Secret", where: { type: "all" }, order: [], paging: { start: 0 } } } }, SYSTEM_CONTEXT);
    expect(denied.ok ? undefined : denied.error?.code).toBe("FORBIDDEN_MODEL");

    // a persist to a non-listed model is refused before any write lands
    const persist = await adapter.handle({ method: "persist", params: { saves: [{ model: "Secret", record: { uuid: "z", name: "x" } }], removes: [] } }, SYSTEM_CONTEXT);
    expect(persist.ok ? undefined : persist.error?.code).toBe("FORBIDDEN_MODEL");
  });

  it("clamps an unbounded query to maxPageSize (no whole-model dump)", async () => {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const items = orm.define({ name: "Item", properties: { name: text() } });
    for (let i = 0; i < 10; i++) items.save(items.createInstance({ name: `n${i}` }));
    await items.persist();

    const adapter = new BackendAdapter(backend, undefined, undefined, undefined, 3); // maxPageSize = 3
    // a client asks for everything (no paging.end) — the adapter must cap the returned window
    const res = await adapter.handle(
      { method: "query", params: { plan: { model: "Item", where: { type: "all" }, order: [], paging: { start: 0 } } } },
      SYSTEM_CONTEXT
    );
    expect(res.ok).toBe(true);
    expect((res.ok ? (res.result as unknown[]) : []).length).toBe(3);
  });

  it("maps an internal backend error to an opaque message (no schema/driver leak)", async () => {
    // a backend whose query throws a detailed internal error
    const backend = new InMemoryBackend();
    backend.query = () => Promise.reject(new Error("relation \"secret_users\" does not exist at line 3"));
    const adapter = new BackendAdapter(backend);
    const res = await adapter.handle(
      { method: "query", params: { plan: { model: "X", where: { type: "all" }, order: [], paging: { start: 0 } } } },
      SYSTEM_CONTEXT
    );
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error!.message).not.toContain("secret_users");
    expect(res.ok ? "" : res.error!.code).toBe("BACKEND_ERROR");
  });
});

describe("WebSocket auth seam receives the upgrade request", () => {
  it("passes the connection request to the context factory (so per-connection auth is possible)", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let seenHeaders: unknown;
    attachWebSocketServer(wss, new BackendAdapter(new InMemoryBackend()), {
      context: (req) => {
        seenHeaders = req.headers;
        return SYSTEM_CONTEXT;
      }
    });
    await new Promise<void>((r) => wss.on("listening", r));
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    try {
      const client = new WsClient(url, { headers: { "x-token": "abc" } });
      await new Promise<void>((r) => client.on("open", () => r()));
      await new Promise((r) => setTimeout(r, 20));
      expect(seenHeaders).toBeDefined();
      expect((seenHeaders as Record<string, unknown>)["x-token"]).toBe("abc");
      client.close();
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
