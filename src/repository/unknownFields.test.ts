/**
 * Regression: a build must not delete stored fields it doesn't declare.
 *
 * `serialize()` encodes an instance from the declared property map, and the stores replace whole
 * records — so before undeclared fields were carried forward from the write baseline (§12), a manager
 * with a narrower property map silently dropped every field it didn't know about on each
 * read-modify-write. Two builds over one store is the steady state during a rolling deploy and the
 * whole premise of an expand/contract migration window, so this has to hold on every backend.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { IndexedDBBackend } from "../backends/indexeddb/IndexedDBBackend.js";
import { RepositoryManager } from "./RepositoryManager.js";
import { text } from "../properties/factories.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import { all } from "../expressions/index.js";
import type { Backend, PersistedChange } from "../core/Backend.js";
import type { Context, JsonObject } from "../core/types.js";
import "fake-indexeddb/auto";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const ctx = SYSTEM_CONTEXT;

const BACKENDS: Array<[string, () => Backend]> = [
  ["InMemory", () => new InMemoryBackend()],
  ["SQLite", () => new SQLiteBackend(new DatabaseSync(":memory:"))],
  ["IndexedDB", () => new IndexedDBBackend({ name: `unknown-fields-${Math.random().toString(36).slice(2)}` })]
];

/** Read a model's stored rows straight from the backend, below the Repository's decode. */
const storedRows = (backend: Backend, model: string): Promise<JsonObject[]> =>
  backend.query({ model, where: all().serialize(), order: [], paging: { start: 0 } }, ctx);

describe("undeclared stored fields survive a narrower build's writes", () => {
  for (const [label, mk] of BACKENDS) {
    it(`${label}: a read-modify-write keeps a field this manager never declared`, async () => {
      const backend = mk();
      const orm = new RepositoryManager({ backend });
      // This build knows `title`. It has never heard of `nickname` or `legacyCount`.
      const notes = orm.define({ name: "Note", properties: { title: text() } });

      // A wider build (or an older one) wrote a record carrying fields this one doesn't declare.
      backend.save("Note", { uuid: "n1", title: "t0", nickname: "Annie", legacyCount: 7 }, ctx);
      await backend.persist(ctx);

      const note = await notes.get("n1");
      expect(note).not.toBeNull();
      note!.title = "t1";
      notes.save(note!);
      await notes.persist();

      const [row] = await storedRows(backend, "Note");
      expect(row!.title).toBe("t1"); // the declared edit landed
      expect(row!.nickname).toBe("Annie"); // ...without eating the undeclared neighbours
      expect(row!.legacyCount).toBe(7);
    });
  }

  it("does not report an untouched undeclared field as dirty", async () => {
    const seen: PersistedChange[] = [];
    const inner = new InMemoryBackend();
    // A thin spy so the assertion is on the hint the Repository actually emits, not on a private.
    const backend: Backend = {
      capabilities: inner.capabilities,
      query: (plan, c) => inner.query(plan, c),
      queryUuids: (plan, c) => inner.queryUuids(plan, c),
      save: (model, record, c: Context, dirty) => {
        seen.push({ model, record, dirty });
        inner.save(model, record, c, dirty);
      },
      remove: (model, record, c) => inner.remove(model, record, c),
      persist: (c) => inner.persist(c),
      changes: (listener, c) => inner.changes(listener, c)
    };

    const orm = new RepositoryManager({ backend });
    const notes = orm.define({ name: "Note", properties: { title: text() } });
    backend.save("Note", { uuid: "n1", title: "t0", nickname: "Annie" }, ctx);
    await backend.persist(ctx);
    seen.length = 0;

    const note = await notes.get("n1");
    note!.title = "t1";
    notes.save(note!);
    await notes.persist();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.record.nickname).toBe("Annie"); // carried forward...
    expect(seen[0]!.dirty).toEqual(["title"]); // ...but unchanged, so never marked dirty
  });

  it("a record the repository observed on the change feed is preserved without ever being loaded", async () => {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const notes = orm.define({ name: "Note", properties: { title: text() } });

    // The repository is already subscribed, so this write reaches it as a change event and becomes a
    // baseline — no `get()` required.
    backend.save("Note", { uuid: "n1", title: "t0", nickname: "Annie" }, ctx);
    await backend.persist(ctx);

    notes.save(notes.createInstance({ uuid: "n1", title: "t1" }));
    await notes.persist();

    const [observed] = await storedRows(backend, "Note");
    expect(observed!.nickname).toBe("Annie");
  });

  it("the documented limit: a blind save against a record this repository never saw replaces it", async () => {
    const backend = new InMemoryBackend();

    // Seeded *before* any repository exists, so there is no load and no observed change event —
    // nothing anywhere to carry forward from.
    backend.save("Note", { uuid: "n1", title: "t0", nickname: "Annie" }, ctx);
    await backend.persist(ctx);

    const orm = new RepositoryManager({ backend });
    const notes = orm.define({ name: "Note", properties: { title: text() } });
    notes.save(notes.createInstance({ uuid: "n1", title: "t1" }));
    await notes.persist();

    const [row] = await storedRows(backend, "Note");
    expect(row!.title).toBe("t1");
    expect(row!.nickname).toBeUndefined();
  });
});
