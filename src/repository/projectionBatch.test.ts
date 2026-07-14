/**
 * `select()` must load each relation **once across the whole page**, not once per row (the N+1 the
 * main `list()` path already avoids). This pins the batching for all four relation shapes — to-one and
 * to-many, each in `reference` and `embed` storage — by counting the backend queries: it stays a small
 * constant as the row count grows.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { text, relationToOne, relationToMany } from "../properties/factories.js";
import type { Context, JsonObject } from "../core/types.js";
import type { QueryPlan } from "../core/QueryPlan.js";

/** InMemoryBackend that counts `query` calls, to assert the projection load is batched, not N+1. */
class CountingBackend extends InMemoryBackend {
  queries = 0;
  async query(plan: QueryPlan, ctx: Context): Promise<JsonObject[]> {
    this.queries += 1;
    return super.query(plan, ctx);
  }
}

type Category = { name: string };
type Tag = { label: string };
type Meta = { note: string };
type Comment = { body: string };

function blog() {
  const backend = new CountingBackend();
  const orm = new RepositoryManager({ backend });
  const categories = orm.define({ name: "Category", properties: { name: text() } });
  const tags = orm.define({ name: "Tag", properties: { label: text() } });
  const metas = orm.define({ name: "Meta", properties: { note: text() } });
  const comments = orm.define({ name: "Comment", properties: { body: text() } });
  const posts = orm.define({
    name: "Post",
    properties: {
      title: text(),
      category: relationToOne<Category>({ model: "Category" }), //            to-one  reference
      meta: relationToOne<Meta>({ model: "Meta", storage: "embed" }), //      to-one  embed
      tags: relationToMany<Tag>({ model: "Tag" }), //                         to-many reference
      comments: relationToMany<Comment>({ model: "Comment", storage: "embed" }) // to-many embed
    }
  });
  return { backend, categories, tags, metas, comments, posts };
}

describe("select() batches relation loading across the page (no N+1)", () => {
  it("loads all four relation shapes with a constant number of queries", async () => {
    const { backend, categories, tags, metas, comments, posts } = blog();

    // shared reference targets (so the batch also de-dupes)
    const tech = categories.createInstance({ name: "tech" });
    const life = categories.createInstance({ name: "life" });
    const [ts, ta] = [tags.createInstance({ label: "ts" }), tags.createInstance({ label: "async" })];
    categories.save(tech).save(life);
    tags.save(ts).save(ta);
    metas.save(metas.createInstance({}));
    comments.save(comments.createInstance({}));
    await categories.persist();

    for (let i = 0; i < 5; i++) {
      posts.save(
        posts.createInstance({
          title: `p${i}`,
          category: i % 2 ? tech : life,
          meta: metas.createInstance({ note: `m${i}` }),
          tags: [ts, ta],
          comments: [comments.createInstance({ body: `c${i}a` }), comments.createInstance({ body: `c${i}b` })]
        })
      );
    }
    await posts.persist();

    backend.queries = 0;
    const rows = (await posts
      .all()
      .sort("title")
      .select({
        title: true,
        category: { name: true },
        meta: { note: true },
        tags: { label: true },
        comments: { body: true }
      })) as Array<{
      title: string;
      category: Category;
      meta: Meta;
      tags: Tag[];
      comments: Comment[];
    }>;

    // 5 posts, but only: 1 query for the posts + 1 for Category + 1 for Tag = 3. Embeds add none.
    // The old per-row path would have been 1 + 5 (category) + 5 (tags) = 11.
    expect(backend.queries).toBe(3);

    // …and the projection is correct: order preserved, values + nesting intact.
    expect(rows.map((r) => r.title)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(rows.map((r) => r.category.name)).toEqual(["life", "tech", "life", "tech", "life"]);
    expect(rows.map((r) => r.meta.note)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(rows[0]!.tags.map((t) => t.label)).toEqual(["ts", "async"]);
    expect(rows[2]!.comments.map((c) => c.body)).toEqual(["c2a", "c2b"]);
  });

  it("stays constant as the page grows (10 rows → same query count as 5)", async () => {
    const { backend, categories, posts } = blog();
    const cat = categories.createInstance({ name: "x" });
    categories.save(cat);
    await categories.persist();
    for (let i = 0; i < 10; i++) posts.save(posts.createInstance({ title: `p${i}`, category: cat }));
    await posts.persist();

    backend.queries = 0;
    await posts.all().select({ title: true, category: { name: true } });
    expect(backend.queries).toBe(2); // 1 posts + 1 batched Category, independent of the 10 rows
  });
});
