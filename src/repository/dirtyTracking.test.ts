import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { text, integer, embedded } from "../properties/factories.js";
import type { Context, JsonObject } from "../core/types.js";

type Sub = { plan: string };

/** Records the `dirty` hint passed to every `save()` call, alongside the full record. */
class RecordingBackend extends InMemoryBackend {
  readonly calls: { record: JsonObject; dirty?: readonly string[] }[] = [];

  override save(model: string, record: JsonObject, ctx: Context, dirty?: readonly string[]): void {
    this.calls.push({ record: { ...record }, dirty });
    super.save(model, record, ctx, dirty);
  }
}

function userRepo(backend: RecordingBackend) {
  const orm = new RepositoryManager({ backend });
  return orm.define({
    name: "User",
    properties: { firstName: text(), age: integer(), subscription: embedded<Sub>() }
  });
}

function timestampedUserRepo(backend: RecordingBackend) {
  const orm = new RepositoryManager({ backend });
  return orm.define({
    name: "User",
    properties: { firstName: text(), age: integer() },
    timestamps: true
  });
}

describe("dirty / field-level change tracking", () => {
  it("a brand-new instance saves with no dirty hint (insert path, full write)", async () => {
    const backend = new RecordingBackend();
    const users = userRepo(backend);
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    users.save(peter);
    await users.persist();

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.dirty).toBeUndefined();
  });

  it("re-saving a loaded instance with one changed field reports only that field as dirty", async () => {
    const backend = new RecordingBackend();
    const users = userRepo(backend);
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    users.save(peter);
    await users.persist();

    // Load fresh through a sibling repository sharing the backend, so materialize() sets its own
    // baseline independent of the instance already in `users`'s identity map.
    const users2 = userRepo(backend);
    const loaded = (await users2.get(peter.uuid))!;
    loaded.age = 36;
    users2.save(loaded);
    await users2.persist();

    const secondCall = backend.calls.at(-1)!;
    expect(secondCall.dirty).toEqual(["age"]);
  });

  it("mutating an embedded-relation field reports that field name as dirty", async () => {
    const backend = new RecordingBackend();
    const users = userRepo(backend);
    const peter = users.createInstance({ firstName: "Peter", age: 35, subscription: { plan: "free" } });
    users.save(peter);
    await users.persist();

    peter.subscription = { plan: "pro" };
    users.save(peter);
    await users.persist();

    const secondCall = backend.calls.at(-1)!;
    expect(secondCall.dirty).toEqual(["subscription"]);
  });

  it("saving with no real change omits the dirty hint instead of an empty list", async () => {
    const backend = new RecordingBackend();
    const users = userRepo(backend);
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    users.save(peter);
    await users.persist();

    users.save(peter); // identical fields — nothing actually changed
    await users.persist();

    const secondCall = backend.calls.at(-1)!;
    expect(secondCall.dirty).toBeUndefined();
  });

  it("timestamps:true always reports updatedAt as dirty alongside a real change", async () => {
    const backend = new RecordingBackend();
    const users = timestampedUserRepo(backend);
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    users.save(peter);
    await users.persist();

    await new Promise((resolve) => setTimeout(resolve, 2)); // let the epoch-ms `updatedAt` actually advance
    peter.age = 40;
    users.save(peter);
    await users.persist();

    const secondCall = backend.calls.at(-1)!;
    expect(secondCall.dirty).toContain("age");
    expect(secondCall.dirty).toContain("updatedAt");
  });

  it("remove() clears the baseline, so a later same-uuid save is treated as a fresh insert", async () => {
    const backend = new RecordingBackend();
    const users = userRepo(backend);
    const peter = users.createInstance({ firstName: "Peter", age: 35, uuid: "fixed-uuid" });
    users.save(peter);
    await users.persist();

    users.remove(peter);
    await users.persist();

    // Re-create with the same uuid — no baseline should survive the remove.
    const reborn = users.createInstance({ firstName: "Peter", age: 20, uuid: "fixed-uuid" });
    users.save(reborn);
    await users.persist();

    const lastCall = backend.calls.at(-1)!;
    expect(lastCall.dirty).toBeUndefined();
  });

  it("a save() after patch() diffs against the patched state, not the pre-patch one", async () => {
    const backend = new RecordingBackend();
    const users = userRepo(backend);
    const peter = users.createInstance({ firstName: "Peter", age: 35 });
    users.save(peter);
    await users.persist();

    const patched = (await users.patch(peter.uuid, { age: 50 }))!;
    backend.calls.length = 0; // patch() takes the native/read-modify-write path, not save() — reset

    patched.firstName = "Petra";
    users.save(patched);
    await users.persist();

    const call = backend.calls.at(-1)!;
    expect(call.dirty).toEqual(["firstName"]); // age isn't dirty — the baseline already reflects 50
  });
});
