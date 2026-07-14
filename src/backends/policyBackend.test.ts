import { describe, it, expect, vi } from "vitest";
import { InMemoryBackend } from "./memory/InMemoryBackend.js";
import { SQLiteBackend } from "./sqlite/SQLiteBackend.js";
import { PolicyBackend, PolicyError, type AccessPolicy } from "./decorators/PolicyBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text } from "../properties/factories.js";
import { all, eq } from "../expressions/index.js";
import type { Context, JsonObject } from "../core/types.js";
import type { QueryPlan, ExpressionNode } from "../core/QueryPlan.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function ctxFor(id: string): Context {
  return { identity: { id } };
}

// Row-level security: a context may only read and write rows it owns.
const ownerPolicy: AccessPolicy = {
  read: (_model, ctx) => eq("owner", ctx.identity ? ctx.identity.id : "__anonymous__"),
  write: (_model, record, ctx) => !!ctx.identity && record.owner === ctx.identity.id
};

function plan(model: string, where: ExpressionNode = all().serialize()): QueryPlan {
  return { model, where, order: [], paging: { start: 0 } };
}

describe("PolicyBackend (backend level)", () => {
  function seeded() {
    const inner = new InMemoryBackend();
    const backend = new PolicyBackend(inner, ownerPolicy);
    backend.save("Note", { uuid: "n1", owner: "alice", text: "a1" }, ctxFor("alice"));
    backend.save("Note", { uuid: "n2", owner: "alice", text: "a2" }, ctxFor("alice"));
    backend.save("Note", { uuid: "n3", owner: "bob", text: "b1" }, ctxFor("bob"));
    return { backend, inner };
  }

  it("rewrites reads to enforce row-level security", async () => {
    const { backend } = seeded();
    await backend.persist(ctxFor("alice"));

    const aliceNotes = await backend.query(plan("Note"), ctxFor("alice"));
    expect(aliceNotes.map((n) => n.uuid).sort()).toEqual(["n1", "n2"]);

    const bobNotes = await backend.query(plan("Note"), ctxFor("bob"));
    expect(bobNotes.map((n) => n.uuid)).toEqual(["n3"]);
  });

  it("AND-s the policy with the caller's own filter", async () => {
    const { backend } = seeded();
    await backend.persist(ctxFor("alice"));
    const filtered = await backend.query(plan("Note", eq("text", "a1").serialize()), ctxFor("alice"));
    expect(filtered.map((n) => n.uuid)).toEqual(["n1"]);
    // bob can't reach alice's row even by filtering for it
    const denied = await backend.query(plan("Note", eq("text", "a1").serialize()), ctxFor("bob"));
    expect(denied).toEqual([]);
  });

  it("denies writes to records the context does not own", () => {
    const inner = new InMemoryBackend();
    const backend = new PolicyBackend(inner, ownerPolicy);
    expect(() => backend.save("Note", { uuid: "x", owner: "alice" }, ctxFor("bob"))).toThrow(PolicyError);
    // remove is gated the same way; an owned remove is allowed and reaches the inner store
    expect(() => backend.remove("Note", { uuid: "x", owner: "alice" }, ctxFor("bob"))).toThrow(PolicyError);
    expect(() => backend.remove("Note", { uuid: "x", owner: "alice" }, ctxFor("alice"))).not.toThrow();
  });

  it("queryUuids and count are policy-scoped (native count on a counting store, fallback otherwise)", async () => {
    const { backend } = seeded();
    await backend.persist(ctxFor("alice"));
    // queryUuids goes through the same rewrite
    expect((await backend.queryUuids(plan("Note"), ctxFor("alice"))).sort()).toEqual(["n1", "n2"]);
    // in-memory inner isn't a CountingBackend → count falls back to query().length, still scoped
    expect(await backend.count(plan("Note"), ctxFor("alice"))).toBe(2);
    expect(await backend.count(plan("Note"), ctxFor("bob"))).toBe(1);

    // a counting inner (SQLite) → count pushes down through the rewritten plan
    const sql = new PolicyBackend(new SQLiteBackend(new DatabaseSync(":memory:")), ownerPolicy);
    sql.save("Note", { uuid: "s1", owner: "alice" }, ctxFor("alice"));
    sql.save("Note", { uuid: "s2", owner: "bob" }, ctxFor("bob"));
    await sql.persist(ctxFor("alice"));
    expect(await sql.count(plan("Note"), ctxFor("alice"))).toBe(1);
  });

  it("does not leak another context's saved events on the change feed", async () => {
    const inner = new InMemoryBackend();
    const backend = new PolicyBackend(inner, ownerPolicy);
    const aliceListener = vi.fn();
    backend.changes(aliceListener, ctxFor("alice"));

    backend.save("Note", { uuid: "n1", owner: "alice" }, ctxFor("alice"));
    backend.save("Note", { uuid: "n2", owner: "bob" }, ctxFor("bob"));
    await backend.persist(ctxFor("alice"));

    const seen = aliceListener.mock.calls.map((call) => (call[0] as JsonObject).uuid);
    expect(seen).toContain("n1");
    expect(seen).not.toContain("n2");
  });

  it("drops removed events under a read policy (can't prove the deleted record was visible)", async () => {
    const inner = new InMemoryBackend();
    const backend = new PolicyBackend(inner, ownerPolicy);
    backend.save("Note", { uuid: "n1", owner: "alice" }, ctxFor("alice"));
    backend.save("Note", { uuid: "n2", owner: "bob" }, ctxFor("bob"));
    await backend.persist(ctxFor("alice"));

    const aliceListener = vi.fn();
    backend.changes(aliceListener, ctxFor("alice"));
    // remove bob's note — a `removed` event carries only model+uuid, so with a read policy in force it
    // must NOT reach alice (leaking that n2 existed and was deleted).
    backend.remove("Note", { uuid: "n2", owner: "bob" }, ctxFor("bob"));
    await backend.persist(ctxFor("bob"));

    const removed = aliceListener.mock.calls.map((c) => c[0] as { kind: string; uuid: string }).filter((e) => e.kind === "removed");
    expect(removed).toEqual([]);
  });
});

describe("PolicyBackend (through the Repository stack)", () => {
  it("scopes a repository's reads/writes to the manager's context", async () => {
    const backend = new PolicyBackend(new InMemoryBackend(), ownerPolicy);

    const aliceOrm = new RepositoryManager({ backend, context: ctxFor("alice") });
    const bobOrm = new RepositoryManager({ backend, context: ctxFor("bob") });

    const aliceNotes = aliceOrm.define({ name: "Note", properties: { owner: text(), text: text() } });
    const bobNotes = bobOrm.define({ name: "Note", properties: { owner: text(), text: text() } });

    aliceNotes.save(aliceNotes.createInstance({ owner: "alice", text: "secret" }));
    await aliceNotes.persist();

    expect(await aliceNotes.all().list()).toHaveLength(1);
    expect(await bobNotes.all().list()).toHaveLength(0); // bob can't see alice's note

    // bob can't forge a note owned by alice
    expect(() => bobNotes.save(bobNotes.createInstance({ owner: "alice", text: "forged" }))).toThrow(
      PolicyError
    );
  });
});
