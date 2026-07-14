import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { defineFactory, sequence } from "./factory.js";
import { text, integer, relationToOne, relationToMany } from "../properties/factories.js";
import { ValidationError } from "../properties/schema.js";

interface Author {
  uuid: string;
  name: string;
  books: Book[];
}
interface Book {
  uuid: string;
  title: string;
  author: Author | null;
}

function userRepo(backend = new InMemoryBackend()) {
  const orm = new RepositoryManager({ backend });
  const users = orm.define({
    name: "User",
    properties: { name: text(), age: integer({ default: 30 }), email: text({ required: true }) }
  });
  return { orm, users, backend };
}

describe("defineFactory — seeding / fixtures", () => {
  it("build() returns an unsaved, uuid-stamped, validated instance", async () => {
    const { users } = userRepo();
    const factory = defineFactory(users, { defaults: { name: "Anon", email: "a@x.io" } });
    const u = factory.build();
    expect(u.uuid).toHaveLength(32);
    expect(u.name).toBe("Anon");
    expect(u.age).toBe(30); // property-level default filled by createInstance
    expect(await users.all().count()).toBe(0); // build does not persist
  });

  it("layers property default < factory default < per-build override", async () => {
    const { users } = userRepo();
    const factory = defineFactory(users, { defaults: { name: "Default", age: 40, email: "d@x.io" } });
    expect(factory.build().age).toBe(40); // factory default beats property default (30)
    expect(factory.build({ age: 99 }).age).toBe(99); // override beats factory default
    expect(factory.build().name).toBe("Default");
  });

  it("calls a producer once per build with a monotonic 0-based seq", () => {
    const { users } = userRepo();
    const seen: number[] = [];
    const factory = defineFactory(users, {
      defaults: { name: (ctx) => `u${ctx.seq}`, email: (ctx) => { seen.push(ctx.seq); return `u${ctx.seq}@x.io`; } }
    });
    expect(factory.build().name).toBe("u0");
    expect(factory.build().name).toBe("u1");
    expect(seen).toEqual([0, 1]);
  });

  it("sequence() yields unique values across builds and can be shared between factories", () => {
    const seq = sequence((n) => `s${n}`);
    const { users } = userRepo();
    const f1 = defineFactory(users, { defaults: { name: seq, email: "x@x.io" } });
    const f2 = defineFactory(users, { defaults: { name: seq, email: "y@x.io" } });
    expect([f1.build().name, f2.build().name, f1.build().name]).toEqual(["s1", "s2", "s3"]);

    const raw = sequence();
    expect([raw(), raw(), raw()]).toEqual([1, 2, 3]);
  });

  it("create() persists and is readable on a cold read", async () => {
    const backend = new InMemoryBackend();
    const { users } = userRepo(backend);
    const factory = defineFactory(users, { defaults: { email: "c@x.io" } });
    const created = await factory.create({ name: "Cy" });

    // Fresh manager over the same backend — a real read, not the identity map.
    const { users: cold } = userRepo(backend);
    const loaded = await cold.get(created.uuid);
    expect(loaded).toMatchObject({ name: "Cy", email: "c@x.io" });
  });

  it("createMany() persists exactly n rows with distinct uuids in one flush", async () => {
    const { users } = userRepo();
    const factory = defineFactory(users, { defaults: { name: sequence((n) => `n${n}`), email: sequence((n) => `n${n}@x.io`) } });
    const many = await factory.createMany(5);
    expect(many).toHaveLength(5);
    expect(new Set(many.map((m) => m.uuid)).size).toBe(5);
    expect(await users.all().count()).toBe(5);
  });

  it("a function override is called per index in buildMany/createMany", async () => {
    const { users } = userRepo();
    const factory = defineFactory(users, { defaults: { name: "x", email: "x@x.io" } });
    const built = factory.buildMany(3, (i) => ({ age: i * 10 }));
    expect(built.map((b) => b.age)).toEqual([0, 10, 20]);
  });

  it("does not bypass validation — an invalid override throws", () => {
    const { users } = userRepo();
    const factory = defineFactory(users, { defaults: { name: "x", email: "x@x.io" } });
    expect(() => factory.build({ age: 3.5 })).toThrow(ValidationError);
  });

  it("enforces required-on-write — a missing required field throws at create()", async () => {
    const orm = new RepositoryManager();
    const accounts = orm.define({ name: "Account", properties: { handle: text({ required: true }) } });
    const factory = defineFactory(accounts, {});
    await expect(factory.create()).rejects.toThrow(ValidationError);
  });

  it("reset() restarts the seq counter", () => {
    const { users } = userRepo();
    const factory = defineFactory(users, { defaults: { name: (c) => `u${c.seq}`, email: "x@x.io" } });
    factory.build();
    factory.build();
    factory.reset();
    expect(factory.build().name).toBe("u0");
  });

  it("rejects a negative or non-integer count", () => {
    const { users } = userRepo();
    const factory = defineFactory(users, { defaults: { name: "x", email: "x@x.io" } });
    expect(() => factory.buildMany(-1)).toThrow(/non-negative integer/);
    expect(() => factory.buildMany(1.5)).toThrow(/non-negative integer/);
  });

  it("cascade-persists a related instance when the relation declares remoteProperty", async () => {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const authors = orm.define({
      name: "Author",
      properties: { name: text(), books: relationToMany<Book>({ model: "Book", remoteProperty: "author" }) }
    });
    const books = orm.define({
      name: "Book",
      properties: { title: text(), author: relationToOne<Author>({ model: "Author", remoteProperty: "books" }) }
    });
    const authorFactory = defineFactory(authors, { defaults: { name: "Ada" } });
    const bookFactory = defineFactory(books, { defaults: { title: "Book", author: () => authorFactory.build() } });

    const book = await bookFactory.create();
    // The related author rides the repository's remoteProperty cascade — readable on a cold read.
    const coldOrm = new RepositoryManager({ backend });
    const coldAuthors = coldOrm.define({
      name: "Author",
      properties: { name: text(), books: relationToMany<Book>({ model: "Book", remoteProperty: "author" }) }
    });
    coldOrm.define({
      name: "Book",
      properties: { title: text(), author: relationToOne<Author>({ model: "Author", remoteProperty: "books" }) }
    });
    expect(await coldAuthors.get(book.author!.uuid)).toMatchObject({ name: "Ada" });
  });
});
