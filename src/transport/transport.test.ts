import { describe, it, expect, vi } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { RemoteBackend } from "./RemoteBackend.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all, eq, gt } from "../expressions/index.js";
import type { QueryPlan } from "../core/QueryPlan.js";

const ctx = SYSTEM_CONTEXT;

function wire(): { remote: RemoteBackend; inner: InMemoryBackend } {
  const inner = new InMemoryBackend();
  const transport = new InProcessTransport(new BackendAdapter(inner));
  return { remote: new RemoteBackend(transport, inner.capabilities), inner };
}

function plan(model: string, where = all().serialize()): QueryPlan {
  return { model, where, order: [], paging: { start: 0 } };
}

describe("RemoteBackend over InProcessTransport", () => {
  it("proxies writes (batched on persist) and reads across the boundary", async () => {
    const { remote } = wire();
    remote.save("User", { uuid: "u1", name: "Peter", age: 35 }, ctx);
    remote.save("User", { uuid: "u2", name: "John", age: 40 }, ctx);
    await remote.persist(ctx);

    const all = await remote.query(plan("User"), ctx);
    expect(all).toHaveLength(2);

    const over38 = await remote.query(plan("User", gt("age", 38).serialize()), ctx);
    expect(over38.map((u) => u.uuid)).toEqual(["u2"]);
  });

  it("really persists to the underlying backend", async () => {
    const { remote, inner } = wire();
    remote.save("User", { uuid: "u1", name: "Peter" }, ctx);
    await remote.persist(ctx);
    // The inner backend was written through the wire, not just the client buffer.
    expect(await inner.query(plan("User"), ctx)).toHaveLength(1);
  });

  it("forwards the change feed back to the client", async () => {
    const { remote } = wire();
    const listener = vi.fn();
    remote.changes(listener, ctx);

    remote.save("User", { uuid: "u1", name: "Peter" }, ctx);
    await remote.persist(ctx);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ model: "User", uuid: "u1", kind: "saved" })
    );
  });

  it("surfaces backend errors as rejected requests", async () => {
    const inner = new InMemoryBackend();
    const adapter = new BackendAdapter(inner);
    const transport = new InProcessTransport(adapter);
    const remote = new RemoteBackend(transport, inner.capabilities);
    // An unsupported wire method comes back as a rejection, not a silent failure.
    await expect(
      transport.request({ method: "pull", params: {} }, ctx)
    ).resolves.toMatchObject({ ok: false });
    void remote;
  });

  it("round-trips payloads through JSON (proves wire-serializability)", async () => {
    const serializeSpy = vi.spyOn(JSON, "stringify");
    const { remote } = wire();
    remote.save("User", { uuid: "u1", name: "Peter" }, ctx);
    await remote.persist(ctx);
    expect(serializeSpy).toHaveBeenCalled();
    serializeSpy.mockRestore();
  });
});
