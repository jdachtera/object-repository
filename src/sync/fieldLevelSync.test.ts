import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SyncBackend } from "./SyncBackend.js";
import { InMemorySyncTarget } from "./InMemorySyncTarget.js";
import { all } from "../expressions/index.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";
import type { JsonObject } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;
const allNotes: QueryPlan = { model: "Note", where: all().serialize(), order: [], paging: { start: 0 } };

function device(server: InMemorySyncTarget, nodeId: string): SyncBackend {
  return new SyncBackend({ local: new InMemoryBackend(), remote: server, nodeId, fieldLevel: true });
}

const row = async (be: SyncBackend): Promise<JsonObject> => (await be.query(allNotes, ctx))[0]!;

describe("SyncBackend — field-level deltas", () => {
  it("merges concurrent edits to DIFFERENT fields (both survive)", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");

    // Seed n1 with two fields on A, propagate to B.
    a.save("Note", { uuid: "n1", title: "t0", body: "b0" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);
    expect(await row(b)).toMatchObject({ title: "t0", body: "b0" });

    // A edits only `title`; B edits only `body` — offline, concurrently.
    a.save("Note", { uuid: "n1", title: "from-A", body: "b0" }, ctx, ["title"]);
    await a.persist(ctx);
    b.save("Note", { uuid: "n1", title: "t0", body: "from-B" }, ctx, ["body"]);
    await b.persist(ctx);

    await a.reconcile(ctx);
    await b.reconcile(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    // Both replicas converge to BOTH edits — the whole-record LWW would have lost one.
    for (const be of [a, b]) {
      expect(await row(be)).toMatchObject({ title: "from-A", body: "from-B" });
    }
  });

  it("resolves a same-field conflict by the higher HLC version", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");
    a.save("Note", { uuid: "n1", title: "t0", body: "b0" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    a.save("Note", { uuid: "n1", title: "A-title", body: "b0" }, ctx, ["title"]);
    await a.persist(ctx);
    b.save("Note", { uuid: "n1", title: "B-title", body: "b0" }, ctx, ["title"]); // B writes after A
    await b.persist(ctx);

    await a.reconcile(ctx);
    await b.reconcile(ctx);
    await a.reconcile(ctx);

    for (const be of [a, b]) expect((await row(be)).title).toBe("B-title"); // later HLC wins the field
  });

  it("a no-op re-save does not bump versions or clobber a concurrent other-field edit", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");
    a.save("Note", { uuid: "n1", title: "t0", body: "b0" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);

    // A re-saves an IDENTICAL record (dirty undefined = nothing changed).
    a.save("Note", { uuid: "n1", title: "t0", body: "b0" }, ctx);
    await a.persist(ctx);
    // B edits body meanwhile.
    b.save("Note", { uuid: "n1", title: "t0", body: "from-B" }, ctx, ["body"]);
    await b.persist(ctx);

    await a.reconcile(ctx);
    await b.reconcile(ctx);
    await a.reconcile(ctx);

    // A's no-op did not bump `body`, so B's edit still wins on both.
    for (const be of [a, b]) expect((await row(be)).body).toBe("from-B");
  });

  it("propagates a fresh insert (all fields versioned) and later single-field edits", async () => {
    const server = new InMemorySyncTarget();
    const a = device(server, "A");
    const b = device(server, "B");
    a.save("Note", { uuid: "n1", title: "hello", body: "world" }, ctx);
    await a.persist(ctx);
    await a.reconcile(ctx);
    await b.reconcile(ctx);
    expect(await row(b)).toMatchObject({ title: "hello", body: "world" });

    b.save("Note", { uuid: "n1", title: "hello!", body: "world" }, ctx, ["title"]);
    await b.persist(ctx);
    await b.reconcile(ctx);
    await a.reconcile(ctx);
    expect((await row(a)).title).toBe("hello!");
    expect((await row(a)).body).toBe("world");
  });
});
