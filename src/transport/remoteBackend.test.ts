import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { RemoteBackend } from "./RemoteBackend.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all } from "../expressions/builders.js";
import type { QueryPlan } from "../core/QueryPlan.js";
import type { Transport } from "../core/Transport.js";

const ctx = SYSTEM_CONTEXT;
const plan: QueryPlan = { model: "U", where: all().serialize(), order: [], paging: { start: 0 } };

describe("RemoteBackend", () => {
  it("round-trips queryUuids and remove through the in-process transport", async () => {
    const inner = new InMemoryBackend();
    const remote = new RemoteBackend(new InProcessTransport(new BackendAdapter(inner)), inner.capabilities);
    remote.save("U", { uuid: "a", n: 1 }, ctx);
    remote.save("U", { uuid: "b", n: 2 }, ctx);
    await remote.persist(ctx);

    expect((await remote.queryUuids(plan, ctx)).sort()).toEqual(["a", "b"]);

    remote.remove("U", { uuid: "a", n: 1 }, ctx);
    await remote.persist(ctx);
    expect(await remote.query(plan, ctx)).toHaveLength(1);
  });

  it("changes() is a no-op unsubscribe when the transport has no subscribe channel", () => {
    const noSub: Transport = { request: async () => ({ ok: true, result: [] }) };
    const remote = new RemoteBackend(noSub, new InMemoryBackend().capabilities);
    const unsubscribe = remote.changes(() => {}, ctx);
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("surfaces a remote error, with or without an error body", async () => {
    const withError: Transport = { request: async () => ({ ok: false, error: { code: "BOOM", message: "nope" } }) };
    await expect(new RemoteBackend(withError, new InMemoryBackend().capabilities).query(plan, ctx)).rejects.toThrow(
      /BOOM: nope/
    );
    const bare: Transport = { request: async () => ({ ok: false }) };
    await expect(new RemoteBackend(bare, new InMemoryBackend().capabilities).query(plan, ctx)).rejects.toThrow(/failed/);
  });
});
