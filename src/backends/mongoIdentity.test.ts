import { describe, it, expect } from "vitest";
import { MongoBackend, objectIdIdentity, type MongoCollection, type MongoDatabase, type MongoFilter } from "./mongo/MongoBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text } from "../properties/factories.js";
import { eq } from "../expressions/index.js";

// A minimal stand-in for a BSON ObjectId: an opaque value whose string form is its hex.
class Oid {
  constructor(readonly hex: string) {}
  toString(): string {
    return this.hex;
  }
}
const norm = (v: unknown): unknown => (v instanceof Oid ? `oid:${v.hex}` : v);

function matches(doc: Record<string, unknown>, filter: MongoFilter): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$and") {
      if (!(cond as MongoFilter[]).every((c) => matches(doc, c))) return false;
    } else if (cond && typeof cond === "object" && !(cond instanceof Oid) && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>;
      if ("$in" in ops) {
        if (!(ops.$in as unknown[]).some((v) => norm(v) === norm(doc[key]))) return false;
      } else return false; // other operators unused in this test
    } else if (norm(doc[key]) !== norm(cond)) {
      return false;
    }
  }
  return true;
}

class Coll implements MongoCollection {
  docs: Record<string, unknown>[] = [];
  find(filter: MongoFilter) {
    const result = this.docs.filter((d) => matches(d, filter)).map((d) => ({ ...d }));
    return { toArray: async () => result };
  }
  async countDocuments(filter: MongoFilter): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length;
  }
  aggregate() {
    return { toArray: async () => [] };
  }
  async createIndex(): Promise<unknown> {
    return "idx";
  }
  async updateOne(filter: MongoFilter, update: object, options: { upsert?: boolean } = {}): Promise<unknown> {
    const doc = this.docs.find((d) => matches(d, filter));
    const u = update as { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> };
    if (doc) {
      Object.assign(doc, u.$set ?? {});
      return { modifiedCount: 1 };
    }
    if (options.upsert) {
      const inserted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(filter)) if (!(v && typeof v === "object" && !(v instanceof Oid))) inserted[k] = v;
      Object.assign(inserted, u.$set ?? {}, u.$setOnInsert ?? {});
      this.docs.push(inserted);
    }
    return { modifiedCount: 0 };
  }
  async updateMany(): Promise<unknown> {
    return { modifiedCount: 0 };
  }
  async bulkWrite(ops: object[]): Promise<unknown> {
    for (const op of ops as Array<Record<string, { filter: MongoFilter; update?: { $set: Record<string, unknown> } }>>) {
      const upd = op.updateOne;
      const del = op.deleteOne;
      if (upd) {
        const doc = this.docs.find((d) => matches(d, upd.filter));
        if (doc) Object.assign(doc, upd.update!.$set);
        else this.docs.push({ ...upd.update!.$set });
      } else if (del) {
        const i = this.docs.findIndex((d) => matches(d, del.filter));
        if (i >= 0) this.docs.splice(i, 1);
      }
    }
    return {};
  }
}

class Db implements MongoDatabase {
  colls = new Map<string, Coll>();
  collection(name: string): Coll {
    if (!this.colls.has(name)) this.colls.set(name, new Coll());
    return this.colls.get(name)!;
  }
}

describe("MongoBackend with objectIdIdentity (ObjectId _id and FK fields)", () => {
  let counter = 0;
  const newHex = () => (counter++).toString(16).padStart(24, "0");

  function orm(db: Db) {
    const identity = objectIdIdentity(Oid as unknown as new (hex: string) => unknown, { Fav: ["userId"] });
    return new RepositoryManager({ backend: new MongoBackend(db, identity), generateId: newHex });
  }

  it("stores new records keyed on ObjectId _id (no uuid field) and reads them back as hex", async () => {
    const db = new Db();
    const users = orm(db).define({ name: "User", properties: { email: text() } });
    const user = users.createInstance({ email: "a@x.com" });
    users.save(user);
    await users.persist();

    // stored doc is keyed on an ObjectId `_id`; there is no `uuid` field on disk
    const stored = db.collection("User").docs[0]!;
    expect(stored._id).toBeInstanceOf(Oid);
    expect((stored._id as Oid).hex).toBe(user.uuid);
    expect("uuid" in stored).toBe(false);

    // read back: identity surfaces as the hex `uuid`
    const [loaded] = await users.all().list();
    expect(loaded!.uuid).toBe(user.uuid);
    expect(loaded!.email).toBe("a@x.com");

    // query by uuid compiles to a `_id` ObjectId match
    const [byId] = await users.all().filter(eq("uuid", user.uuid)).list();
    expect(byId!.uuid).toBe(user.uuid);
  });

  it("adopts pre-existing ObjectId-keyed documents", async () => {
    const db = new Db();
    db.collection("User").docs.push({ _id: new Oid("a".repeat(24)), email: "old@x.com" });
    const users = orm(db).define({ name: "User", properties: { email: text() } });

    const [loaded] = await users.all().filter(eq("email", "old@x.com")).list();
    expect(loaded!.uuid).toBe("a".repeat(24));
  });

  it("maps foreign-key fields between hex and ObjectId", async () => {
    const db = new Db();
    const manager = orm(db);
    const users = manager.define({ name: "User", properties: { email: text() } });
    const favs = manager.define({ name: "Fav", properties: { userId: text(), label: text() } });

    const user = users.createInstance({ email: "a@x.com" });
    users.save(user);
    await users.persist();

    favs.save(favs.createInstance({ userId: user.uuid, label: "liked" }));
    await favs.persist();

    // stored FK is an ObjectId
    expect(db.collection("Fav").docs[0]!.userId).toBeInstanceOf(Oid);
    // query by the hex FK matches, and it reads back as hex
    const [fav] = await favs.all().filter(eq("userId", user.uuid)).list();
    expect(fav!.userId).toBe(user.uuid);
    expect(fav!.label).toBe("liked");
  });
});
