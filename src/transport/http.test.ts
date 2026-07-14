import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { HttpTransport } from "./http/HttpTransport.js";
import { createRequestListener } from "./http/createRequestListener.js";
import { RemoteBackend } from "./RemoteBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { gt } from "../expressions/builders.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { generateUuid } from "../core/uuid.js";

const ctx = SYSTEM_CONTEXT;

async function startServer(backend: InMemoryBackend): Promise<{ server: Server; url: string }> {
  const server = createServer(createRequestListener(new BackendAdapter(backend)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe("HTTP transport", () => {
  it("runs the full typed ORM over a real HTTP server", async () => {
    const inner = new InMemoryBackend();
    const { server, url } = await startServer(inner);
    try {
      const orm = new RepositoryManager({
        backend: new RemoteBackend(new HttpTransport(url), inner.capabilities)
      });
      const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });

      users.save(users.createInstance({ name: "Peter", age: 35 }));
      users.save(users.createInstance({ name: "John", age: 40 }));
      await users.persist();

      expect(await users.all().list()).toHaveLength(2);
      const over38 = await users.all().filter(gt("age", 38)).list();
      expect(over38.map((u) => u.name)).toEqual(["John"]);
    } finally {
      server.close();
    }
  });

  it("answers a malformed RPC body with a 400 BAD_REQUEST", async () => {
    const { server, url } = await startServer(new InMemoryBackend());
    try {
      const res = await fetch(`${url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("BAD_REQUEST");
    } finally {
      server.close();
    }
  });

  it("delivers the change feed over Server-Sent Events", async () => {
    const inner = new InMemoryBackend();
    const { server, url } = await startServer(inner);
    const transport = new HttpTransport(url);
    const events: Array<{ uuid: string; model: string; kind: string }> = [];
    const unsubscribe = transport.subscribe!(
      { method: "changes", params: {} },
      (event) => events.push(event as (typeof events)[number]),
      ctx
    );
    try {
      // Retry the write until the SSE connection is established and an event arrives — robust
      // against the connect race without depending on internal timing.
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
      server.close();
    }
  });
});
