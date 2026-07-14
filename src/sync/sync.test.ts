import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SyncBackend } from "./SyncBackend.js";
import { InMemorySyncTarget } from "./InMemorySyncTarget.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text } from "../properties/factories.js";
import { all } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";

const ctx = SYSTEM_CONTEXT;
const allNotes: QueryPlan = { model: "Note", where: all().serialize(), order: [], paging: { start: 0 } };

function device(server: InMemorySyncTarget, nodeId: string): SyncBackend {
  return new SyncBackend({ local: new InMemoryBackend(), remote: server, nodeId });
}

describe("SyncBackend (backend level)", () => {
  it("reads offline-first and propagates a write to another device through the server", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");

    a.save("Note", { uuid: "n1", text: "hello" }, ctx);
    await a.persist(ctx);

    // Local immediately; not yet visible elsewhere.
    expect(await a.query(allNotes, ctx)).toHaveLength(1);
    expect(await b.query(allNotes, ctx)).toHaveLength(0);

    await a.reconcile(ctx); // push
    await b.reconcile(ctx); // pull

    const onB = await b.query(allNotes, ctx);
    expect(onB.map((n) => n.uuid)).toEqual(["n1"]);
    expect(onB[0]!.text).toBe("hello");
  });

  it("resolves concurrent edits last-write-wins by HLC version", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");

    // Seed n1 and sync both devices.
    a.save("Note", { uuid: "n1", text: "v0" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    // Both edit offline; B writes after A, so B's HLC version is greater.
    a.save("Note", { uuid: "n1", text: "from-A" }, ctx);
    await a.persist(ctx);
    b.save("Note", { uuid: "n1", text: "from-B" }, ctx);
    await b.persist(ctx);

    await a.reconcile(ctx); // A pushes from-A
    await b.reconcile(ctx); // B pulls from-A (older, ignored), pushes from-B (wins)
    await a.reconcile(ctx); // A pulls from-B (newer, applied)

    expect((await a.query(allNotes, ctx))[0]!.text).toBe("from-B");
    expect((await b.query(allNotes, ctx))[0]!.text).toBe("from-B");
  });

  it("propagates removals", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");

    a.save("Note", { uuid: "n1", text: "hello" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);
    expect(await b.query(allNotes, ctx)).toHaveLength(1);

    a.remove("Note", { uuid: "n1" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    expect(await b.query(allNotes, ctx)).toHaveLength(0);
  });

  it("arbitrates remove-vs-edit by version via tombstones (edit after remove resurrects)", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");

    a.save("Note", { uuid: "n1", text: "v0" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    // A removes (tombstone) and syncs it out.
    a.remove("Note", { uuid: "n1" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);

    // B pulls the tombstone (advancing its clock past it), then edits — so the edit's version wins.
    await b.reconcile(ctx);
    expect(await b.query(allNotes, ctx)).toHaveLength(0); // tombstone applied on B
    b.save("Note", { uuid: "n1", text: "revived" }, ctx);
    await b.persist(ctx);
    await b.reconcile(ctx); // push edit (newer than tombstone)
    await a.reconcile(ctx); // pull edit -> resurrect

    expect((await a.query(allNotes, ctx)).map((n) => n.text)).toEqual(["revived"]);
    expect((await b.query(allNotes, ctx)).map((n) => n.text)).toEqual(["revived"]);
  });
});

describe("SyncBackend (durable outbox)", () => {
  it("recovers and pushes pending changes from the local store after a restart", async () => {
    const server = new InMemorySyncTarget();
    const local = new InMemoryBackend(); // stands in for a durable store across "restarts"

    // First instance writes offline but never reconciles (simulating a crash before sync).
    const before = new SyncBackend({ local, remote: server, nodeId: "A" });
    before.save("Note", { uuid: "n1", text: "unsynced" }, ctx);
    await before.persist(ctx);

    // A fresh SyncBackend over the same local store reconciles — the outbox survived.
    const after = new SyncBackend({ local, remote: server, nodeId: "A" });
    await after.reconcile(ctx);

    const b = device(server, "B");
    await b.reconcile(ctx);
    expect((await b.query(allNotes, ctx)).map((n) => n.uuid)).toEqual(["n1"]);
  });
});

describe("SyncBackend (through the Repository stack)", () => {
  it("runs an offline-first repository that syncs to another replica", async () => {
    const server = new InMemorySyncTarget();
    const backendA = device(server, "A");
    const backendB = device(server, "B");

    const ormA = new RepositoryManager({ backend: backendA });
    const notesA = ormA.define({ name: "Note", properties: { text: text() } });

    const note = notesA.createInstance({ text: "offline note" });
    notesA.save(note);
    await notesA.persist();
    await backendA.reconcile(SYSTEM_CONTEXT);

    const ormB = new RepositoryManager({ backend: backendB });
    const notesB = ormB.define({ name: "Note", properties: { text: text() } });
    await backendB.reconcile(SYSTEM_CONTEXT);

    const loaded = await notesB.all().list();
    expect(loaded.map((n) => n.text)).toEqual(["offline note"]);
    expect(loaded[0]!.uuid).toBe(note.uuid); // client-minted uuid survived the round trip
  });
});
