/**
 * Regression: a dirty hint naming a *removed* field must not produce an empty `$set`.
 *
 * `persist` translates a dirty hint (§12) into `$set`/`$unset`. When the caller deletes a key and
 * names it in `dirty`, the "still present in the record" filter leaves nothing to set — and Mongo
 * rejects `{$set: {}}` with `FailedToParse: '$set' is empty`, failing the entire `bulkWrite`, taking
 * every unrelated write batched alongside it down too.
 */
import { describe, it, expect } from "vitest";
import { MongoBackend, type MongoCollection, type MongoDatabase } from "./mongo/MongoBackend.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;

interface Captured {
  collection: string;
  ops: unknown[];
}

/** A database stub that records `bulkWrite` calls instead of talking to a server. */
function spyDb(): { db: MongoDatabase; writes: Captured[] } {
  const writes: Captured[] = [];
  const db = {
    collection(name: string) {
      return {
        bulkWrite: async (ops: unknown[]) => {
          writes.push({ collection: name, ops });
          return { ok: 1 };
        },
        find: () => ({ toArray: async () => [] }),
        createIndex: async () => undefined,
        listIndexes: () => ({ toArray: async () => [] })
      } as unknown as MongoCollection;
    }
  } as unknown as MongoDatabase;
  return { db, writes };
}

const updateOf = (writes: Captured[]): Record<string, unknown> =>
  (writes[0]!.ops[0] as { updateOne: { update: Record<string, unknown> } }).updateOne.update;

describe("MongoBackend.persist — $set/$unset shaping", () => {
  it("emits only $unset when every dirty field was deleted", async () => {
    const { db, writes } = spyDb();
    const backend = new MongoBackend(db);

    // `computeDirty` never lists `uuid`, so a lone deleted field is exactly what the Repository emits.
    backend.save("Note", { uuid: "u1" }, ctx, ["title"]); // `title` deleted by the caller
    await backend.persist(ctx);

    expect(writes).toHaveLength(1);
    const update = updateOf(writes);
    expect(update.$unset).toEqual({ title: "" });
    expect("$set" in update).toBe(false); // an empty $set would fail the whole bulkWrite
  });

  it("still emits $set for a normal dirty save", async () => {
    const { db, writes } = spyDb();
    const backend = new MongoBackend(db);

    backend.save("Note", { uuid: "u1", title: "t1" }, ctx, ["title"]);
    await backend.persist(ctx);

    const update = updateOf(writes);
    expect(update.$set).toMatchObject({ title: "t1" });
    expect("$unset" in update).toBe(false);
  });

  it("emits both when a dirty hint mixes a changed and a deleted field", async () => {
    const { db, writes } = spyDb();
    const backend = new MongoBackend(db);

    backend.save("Note", { uuid: "u1", title: "t1" }, ctx, ["title", "subtitle"]);
    await backend.persist(ctx);

    const update = updateOf(writes);
    expect(update.$set).toMatchObject({ title: "t1" });
    expect(update.$unset).toEqual({ subtitle: "" });
  });

  it("pushes no operation at all when a dirty hint names nothing to do", async () => {
    const { db, writes } = spyDb();
    const backend = new MongoBackend(db);

    backend.save("Note", { uuid: "u1" }, ctx, []);
    await backend.persist(ctx);

    expect(writes).toHaveLength(0);
  });

  it("a save with no dirty hint still writes the whole record", async () => {
    const { db, writes } = spyDb();
    const backend = new MongoBackend(db);

    backend.save("Note", { uuid: "u1", title: "t1" }, ctx);
    await backend.persist(ctx);

    expect(updateOf(writes).$set).toMatchObject({ title: "t1" });
  });
});
