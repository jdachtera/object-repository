/**
 * Batched relation loading (N+1 elimination). Loading a relation across a set of sibling rows issues
 * ONE `WHERE uuid IN (…)` query for the whole batch instead of one per row, so the query count stays
 * constant as the row count grows. Proven by counting backend queries on a cold read (empty caches),
 * plus the identity map still shares references for a deduplicated to-one relation.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { text, relationToOne, relationToMany } from "../properties/factories.js";
import type { Context, JsonObject } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";

/** In-memory backend that counts how many `query` calls it serves. */
class CountingBackend extends InMemoryBackend {
  queries = 0;
  async query(plan: QueryPlan, ctx: Context): Promise<JsonObject[]> {
    this.queries++;
    return super.query(plan, ctx);
  }
}

interface UserModel {
  uuid: string;
  name: string;
  events: EventModel[];
}
interface EventModel {
  uuid: string;
  title: string;
  users: UserModel[];
}
function manyToMany(orm: RepositoryManager) {
  const users = orm.define({
    name: "User",
    properties: { name: text(), events: relationToMany<EventModel>({ model: "Event", remoteProperty: "users" }) }
  });
  const events = orm.define({
    name: "Event",
    properties: { title: text(), users: relationToMany<UserModel>({ model: "User", remoteProperty: "events" }) }
  });
  return { users, events };
}

interface PostModel {
  uuid: string;
  title: string;
  author: AuthorModel | null;
}
interface AuthorModel {
  uuid: string;
  name: string;
  posts: PostModel[];
}
function postsAndAuthors(orm: RepositoryManager) {
  const posts = orm.define({
    name: "Post",
    properties: { title: text(), author: relationToOne<AuthorModel>({ model: "Author", remoteProperty: "posts" }) }
  });
  const authors = orm.define({
    name: "Author",
    properties: { name: text(), posts: relationToMany<PostModel>({ model: "Post", remoteProperty: "author" }) }
  });
  return { posts, authors };
}

describe("batched relation loading avoids N+1", () => {
  it("loads a to-many relation for many rows in a constant number of queries", async () => {
    const backend = new CountingBackend();
    const writer = manyToMany(new RepositoryManager({ backend }));
    const N = 25;
    for (let i = 0; i < N; i++) {
      const event = writer.events.createInstance({ title: `e${i}` });
      writer.users.save(writer.users.createInstance({ name: `u${i}`, events: [event] }));
    }
    await writer.users.persist();

    // cold read through a fresh manager (empty identity map)
    backend.queries = 0;
    const reader = manyToMany(new RepositoryManager({ backend }));
    const loaded = (await reader.users.all().list()) as UserModel[];

    expect(loaded).toHaveLength(N);
    expect(loaded.every((u) => u.events.length === 1)).toBe(true); // every relation loaded
    // 1 query for users + 1 for all their events; the events' inverse users resolve from cache.
    expect(backend.queries).toBeLessThanOrEqual(3); // constant, not N+1 (which would be ~26)
  });

  it("deduplicates a to-one relation into one query and shares the instance", async () => {
    const backend = new CountingBackend();
    const writer = postsAndAuthors(new RepositoryManager({ backend }));
    const ada = writer.authors.createInstance({ name: "Ada" });
    const bob = writer.authors.createInstance({ name: "Bob" });
    for (let i = 0; i < 20; i++) {
      writer.posts.save(writer.posts.createInstance({ title: `p${i}`, author: i % 2 === 0 ? ada : bob }));
    }
    await writer.posts.persist();

    backend.queries = 0;
    const reader = postsAndAuthors(new RepositoryManager({ backend }));
    const loaded = (await reader.posts.all().list()) as PostModel[];

    expect(loaded).toHaveLength(20);
    expect(loaded.every((p) => p.author !== null)).toBe(true);
    // 1 query for posts + 1 for the two distinct authors (deduped); authors' posts resolve from cache.
    expect(backend.queries).toBeLessThanOrEqual(3);
    // identity map: every post by the same author points at the *same* author object
    const adaPosts = loaded.filter((p) => p.author!.name === "Ada");
    expect(new Set(adaPosts.map((p) => p.author)).size).toBe(1);
  });

  it("still returns correct, per-row relation contents (not just a shared blob)", async () => {
    const backend = new CountingBackend();
    const writer = manyToMany(new RepositoryManager({ backend }));
    const [e1, e2, e3] = [1, 2, 3].map((n) => writer.events.createInstance({ title: `e${n}` }));
    writer.users.save(writer.users.createInstance({ name: "a", events: [e1!, e2!] }));
    writer.users.save(writer.users.createInstance({ name: "b", events: [e3!] }));
    writer.users.save(writer.users.createInstance({ name: "c", events: [] }));
    await writer.users.persist();

    const reader = manyToMany(new RepositoryManager({ backend }));
    const byName = new Map((await reader.users.all().list()).map((u) => [u.name, u as UserModel]));
    expect(byName.get("a")!.events.map((e) => e.title).sort()).toEqual(["e1", "e2"]);
    expect(byName.get("b")!.events.map((e) => e.title)).toEqual(["e3"]);
    expect(byName.get("c")!.events).toEqual([]);
  });
});
