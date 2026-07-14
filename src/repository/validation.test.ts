/**
 * Field defaults + required-on-write enforcement (property `default` / `required`). Defaults fill an
 * absent field in `createInstance` and again at write time (so a plain object saved directly still
 * gets them); `required` rejects a still-absent-or-null field at `save`. Both run in-memory, fully.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { text, integer } from "../properties/factories.js";
import { ValidationError } from "../properties/schema.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

describe("field defaults", () => {
  it("fills an absent field in createInstance, but a provided value wins", () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { name: text(), role: text({ default: "member" }) } });

    expect(users.createInstance({ name: "Ann" }).role).toBe("member");
    expect(users.createInstance({ name: "Bo", role: "admin" }).role).toBe("admin");
  });

  it("calls a factory default per instance", () => {
    let n = 0;
    const orm = new RepositoryManager();
    const items = orm.define({ name: "Item", properties: { seq: integer({ default: () => ++n }) } });
    expect(items.createInstance({}).seq).toBe(1);
    expect(items.createInstance({}).seq).toBe(2);
  });

  it("fills an undefined field but leaves an explicit null alone (write path)", () => {
    const orm = new RepositoryManager();
    const users = orm.define({ name: "User", properties: { name: text(), role: text({ default: "member" }) } });
    // raw objects (bypassing createInstance) exercise the write-time default fill directly
    const absent = { uuid: "u1", name: "Ann" } as { uuid: string; name: string; role?: string | null };
    const explicit = { uuid: "u2", name: "Bo", role: null } as { uuid: string; name: string; role: string | null };
    users.save(absent as never);
    users.save(explicit as never);
    expect(absent.role).toBe("member"); // undefined → default filled
    expect(explicit.role).toBeNull(); // explicit null → untouched
  });

  it("applies the default at write time for a plain object saved directly", async () => {
    const backend = new InMemoryBackend();
    const writer = new RepositoryManager({ backend });
    writer.define({ name: "User", properties: { name: text(), role: text({ default: "member" }) } });
    const reader = new RepositoryManager({ backend }).define({
      name: "User",
      properties: { name: text(), role: text({ default: "member" }) }
    });

    // bypass createInstance entirely — a raw object with no `role`
    writer.repository("User")!.save({ uuid: "u1", name: "Ann" } as never);
    await writer.repository("User")!.persist();

    const stored = await reader.get("u1"); // fresh cache → reads what actually persisted
    expect(stored!.role).toBe("member");
  });
});

describe("required fields", () => {
  const orm = () => {
    const m = new RepositoryManager();
    return m.define({ name: "User", properties: { name: text(), email: text({ required: true }) } });
  };

  it("throws a ValidationError when a required field is absent at save", () => {
    const users = orm();
    const instance = users.createInstance({ name: "Ann" }); // no email
    let error: unknown;
    try {
      users.save(instance);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toMatch(/email.*required/);
    expect((error as ValidationError).issues[0]!.path).toEqual(["email"]);
  });

  it("throws when a required field is explicitly null (write path)", () => {
    const users = orm();
    // a raw object with an explicit null email — the schema isn't run on save, so `required` is the guard
    expect(() => users.save({ uuid: "x", name: "Ann", email: null } as never)).toThrow(/required/);
  });

  it("passes when the required field is present", async () => {
    const users = orm();
    users.save(users.createInstance({ name: "Ann", email: "ann@x.io" }));
    await users.persist();
    expect(await users.all().count()).toBe(1);
  });

  it("a required field with a default never fails (the default fills it)", async () => {
    const m = new RepositoryManager();
    const posts = m.define({ name: "Post", properties: { title: text(), status: text({ required: true, default: "draft" }) } });
    posts.save(posts.createInstance({ title: "Hello" }));
    await posts.persist();
    expect((await posts.all().list())[0]!.status).toBe("draft");
  });

  it("does not disturb models that declare no required/default (backward compatible)", async () => {
    const m = new RepositoryManager();
    const notes = m.define({ name: "Note", properties: { body: text() } });
    notes.save(notes.createInstance({})); // body absent, not required → fine
    await notes.persist();
    expect(await notes.all().count()).toBe(1);
  });
});

// A default that fails its own schema surfaces as a validation error when applied.
describe("default validity", () => {
  it("validates the produced default", () => {
    const m = new RepositoryManager({ context: SYSTEM_CONTEXT });
    const bad = m.define({
      name: "Bad",
      // integer() default that isn't an integer → makeDefault validates and throws
      properties: { n: integer({ default: 1.5 }) }
    });
    expect(() => bad.createInstance({})).toThrow(ValidationError);
  });
});
