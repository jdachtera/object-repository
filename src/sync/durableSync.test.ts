/**
 * The durable sync stack end to end: `SyncBackend` clients ⇄ `RemoteSyncTarget` ⇄ (transport) ⇄
 * `SyncTargetAdapter` ⇄ `BackendSyncTarget`. Proves the transport-bridged, backend-persisted server is a
 * drop-in for the in-memory reference target — convergence, LWW, field-level merge, and durability
 * (the changelog + its append cursor survive a fresh target over the same store).
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import type { Backend } from "../core/Backend.js";
import { SyncBackend } from "./SyncBackend.js";
import { BackendSyncTarget } from "./BackendSyncTarget.js";
import { RemoteSyncTarget } from "./RemoteSyncTarget.js";
import { SyncTargetAdapter } from "../transport/SyncTargetAdapter.js";
import { InProcessTransport } from "../transport/InProcessTransport.js";
import { HttpTransport } from "../transport/http/HttpTransport.js";
import { createRequestListener } from "../transport/http/createRequestListener.js";
import { text } from "../properties/factories.js";
import { all } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const ctx = SYSTEM_CONTEXT;
const allNotes: QueryPlan = { model: "Note", where: all().serialize(), order: [], paging: { start: 0 } };

/** A server store + the full transport bridge over it; `remote` is what a client's SyncBackend uses. */
function server(store: Backend = new InMemoryBackend()) {
  const target = new BackendSyncTarget(store);
  const transport = new InProcessTransport(new SyncTargetAdapter(target));
  return { store, target, remote: new RemoteSyncTarget(transport) };
}

const device = (remote: RemoteSyncTarget, nodeId: string, fieldLevel = false) =>
  new SyncBackend({ local: new InMemoryBackend(), remote, nodeId, fieldLevel });

describe("durable sync stack (SyncBackend ⇄ transport ⇄ BackendSyncTarget)", () => {
  it("propagates a write from one client to another through the backend-persisted server", async () => {
    const { remote } = server();
    const a = device(remote, "A");
    const b = device(remote, "B");

    a.save("Note", { uuid: "n1", text: "hello" }, ctx);
    await a.persist(ctx);
    expect(await b.query(allNotes, ctx)).toHaveLength(0); // not yet pushed

    await a.reconcile(ctx); // push over the transport
    await b.reconcile(ctx); // pull over the transport

    const onB = await b.query(allNotes, ctx);
    expect(onB.map((n) => n.uuid)).toEqual(["n1"]);
    expect(onB[0]!.text).toBe("hello");
  });

  it("resolves concurrent edits last-write-wins by HLC version", async () => {
    const { remote } = server();
    const a = device(remote, "A");
    const b = device(remote, "B");

    a.save("Note", { uuid: "n1", text: "v0" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    a.save("Note", { uuid: "n1", text: "from-A" }, ctx);
    await a.persist(ctx);
    b.save("Note", { uuid: "n1", text: "from-B" }, ctx); // later → higher HLC
    await b.persist(ctx);

    await a.reconcile(ctx);
    await b.reconcile(ctx);
    await a.reconcile(ctx);

    expect((await a.query(allNotes, ctx))[0]!.text).toBe("from-B");
    expect((await b.query(allNotes, ctx))[0]!.text).toBe("from-B");
  });

  it("field-level: concurrent edits to different fields both survive through the durable server", async () => {
    const { remote } = server();
    const a = device(remote, "A", true);
    const b = device(remote, "B", true);

    a.save("Note", { uuid: "n1", title: "t0", body: "b0" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    a.save("Note", { uuid: "n1", title: "t0", body: "A-body" }, ctx, ["body"]); // A edits body
    await a.persist(ctx);
    b.save("Note", { uuid: "n1", title: "B-title", body: "b0" }, ctx, ["title"]); // B edits title
    await b.persist(ctx);

    await a.reconcile(ctx);
    await b.reconcile(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    const onA = (await a.query(allNotes, ctx))[0]!;
    const onB = (await b.query(allNotes, ctx))[0]!;
    expect(onA.title).toBe("B-title");
    expect(onA.body).toBe("A-body");
    expect(onB).toEqual(onA); // both converge to the per-field merge
  });

  it("is durable: a fresh target over the same store keeps the log and re-seeds its append cursor", async () => {
    const store = new InMemoryBackend();
    // First server instance: push n1, then n2.
    {
      const { remote } = server(store);
      const a = device(remote, "A");
      a.save("Note", { uuid: "n1", text: "one" }, ctx);
      await a.persist(ctx);
      await a.reconcile(ctx);
      a.save("Note", { uuid: "n2", text: "two" }, ctx);
      await a.persist(ctx);
      await a.reconcile(ctx);
    }

    // "Restart": a brand-new stack over the SAME store. A fresh client pulls the whole history…
    const restarted = server(store);
    const c = device(restarted.remote, "C");
    await c.reconcile(ctx);
    expect((await c.query(allNotes, ctx)).map((n) => n.uuid).sort()).toEqual(["n1", "n2"]);

    // …and a new push lands at a higher seq (cursor re-seeded), so C's next pull sees only the new row.
    const beforeCursor = await restarted.target.pull(null, ctx);
    const d = device(restarted.remote, "D");
    d.save("Note", { uuid: "n3", text: "three" }, ctx);
    await d.persist(ctx);
    await d.reconcile(ctx);
    const delta = await restarted.target.pull(beforeCursor.cursor, ctx);
    expect(delta.changes.map((ch) => ch.uuid)).toEqual(["n3"]);
  });

  it("persists the changelog in real SQL (SQLite) and re-seeds across a fresh target", async () => {
    const db = new DatabaseSync(":memory:"); // one connection = one durable store, shared across "restarts"

    // First server over the SQLite store: push n1.
    {
      const { remote } = server(new SQLiteBackend(db));
      const a = device(remote, "A");
      a.save("Note", { uuid: "n1", text: "one" }, ctx);
      await a.persist(ctx);
      await a.reconcile(ctx);
    }

    // Fresh target/backend over the SAME sqlite connection — the changelog table is already there.
    const restarted = server(new SQLiteBackend(db));
    const c = device(restarted.remote, "C");
    await c.reconcile(ctx);
    expect((await c.query(allNotes, ctx)).map((n) => n.uuid)).toEqual(["n1"]);

    // A new push lands after the persisted history (seq re-seeded from the SQL max), not on top of it.
    const d = device(restarted.remote, "D");
    d.save("Note", { uuid: "n2", text: "two" }, ctx);
    await d.persist(ctx);
    await d.reconcile(ctx);
    await c.reconcile(ctx);
    expect((await c.query(allNotes, ctx)).map((n) => n.uuid).sort()).toEqual(["n1", "n2"]);
  });

  it("reports an older-version push as a conflict, and round-trips a tombstone", async () => {
    const target = new BackendSyncTarget(new InMemoryBackend());
    const v = (n: number) => `00000000000000${n}:000000:A`; // HLC-shaped, sortable
    await target.push([{ model: "N", uuid: "x", kind: "saved", record: { v: 2 }, version: v(2) }], ctx);
    const stale = await target.push([{ model: "N", uuid: "x", kind: "saved", record: { v: 1 }, version: v(1) }], ctx);
    expect(stale.acknowledged).toEqual([]);
    expect(stale.conflicts.map((c) => c.uuid)).toEqual(["x"]);
    expect(stale.conflicts[0]!.record).toEqual({ v: 2 }); // server's newer value, for the client to adopt

    const removed = await target.push([{ model: "N", uuid: "x", kind: "removed", version: v(3) }], ctx);
    expect(removed.acknowledged).toEqual(["x"]);
    // The log is append-only, so pull replays every version in seq order; the last for x is the tombstone.
    const forX = (await target.pull(null, ctx)).changes.filter((c) => c.uuid === "x");
    expect(forX.at(-1)!.kind).toBe("removed");
    expect(forX.at(-1)!.record).toBeUndefined();
  });

  it("SyncTargetAdapter rejects non-sync methods and surfaces target errors", async () => {
    const adapter = new SyncTargetAdapter(new BackendSyncTarget(new InMemoryBackend()));
    const bad = await adapter.handle({ method: "query", params: {} } as never, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("UNSUPPORTED_METHOD");

    const throwing = new SyncTargetAdapter({
      pull: () => Promise.reject(new Error("target down")),
      push: () => Promise.resolve({ acknowledged: [], conflicts: [] })
    });
    const err = await throwing.handle({ method: "pull", params: { cursor: null } }, ctx);
    expect(err.ok).toBe(false);
    expect(err.error).toEqual({ code: "SYNC_ERROR", message: "target down" });
  });

  it("RemoteSyncTarget throws on a non-ok transport response", async () => {
    const remote = new RemoteSyncTarget({
      request: () => Promise.resolve({ ok: false, error: { code: "X", message: "boom" } })
    });
    await expect(remote.pull(null, ctx)).rejects.toThrow("boom");
    await expect(remote.push([], ctx)).rejects.toThrow("boom");
  });

  it("works over a real HTTP server (createRequestListener + HttpTransport)", async () => {
    const target = new BackendSyncTarget(new InMemoryBackend());
    const httpServer: Server = createServer(createRequestListener(new SyncTargetAdapter(target)));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const remote = new RemoteSyncTarget(new HttpTransport(`http://127.0.0.1:${port}`));
      const a = device(remote, "A");
      const b = device(remote, "B");

      a.save("Note", { uuid: "n1", text: "over-http" }, ctx);
      await a.persist(ctx);
      await a.reconcile(ctx);
      await b.reconcile(ctx);

      expect((await b.query(allNotes, ctx))[0]!.text).toBe("over-http");
    } finally {
      httpServer.close();
    }
  });
});
