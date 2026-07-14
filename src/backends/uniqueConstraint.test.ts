/**
 * Unique-constraint enforcement in the reference (in-memory) backend. It learns the `unique` fields
 * from `registerModel` and, at `persist`, rejects a batch that would duplicate a value — against the
 * store or within the same batch — before mutating anything, so a violation leaves the store intact.
 * SQL/Mongo enforce the same shape through their real unique indexes.
 */
import { describe, it, expect } from "vitest";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { InMemoryBackend, UniqueConstraintError } from "./memory/InMemoryBackend.js";
import { text, integer } from "../properties/factories.js";

const userOrm = () => {
  const orm = new RepositoryManager();
  return orm.define({ name: "User", properties: { email: text({ unique: true }), name: text() } });
};

describe("unique constraints (reference backend)", () => {
  it("rejects a second record with the same unique value", async () => {
    const users = userOrm();
    users.save(users.createInstance({ email: "a@x.io", name: "Ann" }));
    await users.persist();

    users.save(users.createInstance({ email: "a@x.io", name: "Also Ann" }));
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await users.all().count()).toBe(1); // the conflicting write did not land
  });

  it("allows distinct values", async () => {
    const users = userOrm();
    users.save(users.createInstance({ email: "a@x.io", name: "Ann" }));
    users.save(users.createInstance({ email: "b@x.io", name: "Bo" }));
    await users.persist();
    expect(await users.all().count()).toBe(2);
  });

  it("re-saving the same record (same uuid) does not conflict with itself", async () => {
    const users = userOrm();
    const ann = users.createInstance({ email: "a@x.io", name: "Ann" });
    users.save(ann);
    await users.persist();

    ann.name = "Annabelle"; // update in place, same email + uuid
    users.save(ann);
    await expect(users.persist()).resolves.toBeDefined();
    expect((await users.all().list())[0]!.name).toBe("Annabelle");
  });

  it("catches a conflict within a single batch", async () => {
    const users = userOrm();
    users.save(users.createInstance({ email: "dup@x.io", name: "One" }));
    users.save(users.createInstance({ email: "dup@x.io", name: "Two" }));
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await users.all().count()).toBe(0); // whole batch discarded, store untouched
  });

  it("does not enforce uniqueness on absent/null values (NULLs distinct)", async () => {
    const orm = new RepositoryManager();
    const tags = orm.define({ name: "Tag", properties: { code: text({ unique: true }), label: text() } });
    tags.save(tags.createInstance({ label: "x" })); // no code
    tags.save(tags.createInstance({ label: "y" })); // no code
    await expect(tags.persist()).resolves.toBeDefined();
    expect(await tags.all().count()).toBe(2);
  });

  it("enforces a compound unique index over several fields", async () => {
    const orm = new RepositoryManager();
    const slots = orm.define({
      name: "Slot",
      properties: { day: text(), hour: integer() },
      indexes: [{ fields: ["day", "hour"], unique: true }]
    });
    slots.save(slots.createInstance({ day: "mon", hour: 9 }));
    slots.save(slots.createInstance({ day: "mon", hour: 10 })); // same day, different hour → ok
    await slots.persist();

    slots.save(slots.createInstance({ day: "mon", hour: 9 })); // full tuple repeats → conflict
    const error = await slots.persist().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect((error as UniqueConstraintError).fields).toEqual(["day", "hour"]);
    expect((error as UniqueConstraintError).model).toBe("Slot");
  });

  it("lets a batch free a value (remove) and reuse it (save) in the same unit", async () => {
    const users = userOrm();
    const ann = users.createInstance({ email: "shared@x.io", name: "Ann" });
    users.save(ann);
    await users.persist();

    // remove Ann and, in the same batch, create Bo with Ann's now-freed email
    users.remove(ann);
    users.save(users.createInstance({ email: "shared@x.io", name: "Bo" }));
    await expect(users.persist()).resolves.toBeDefined();
    const rows = await users.all().list();
    expect(rows.map((u) => u.name)).toEqual(["Bo"]);
  });

  it("lets two records swap their unique values in a single batch", async () => {
    const users = userOrm();
    const ann = users.createInstance({ email: "a@x.io", name: "Ann" });
    const bo = users.createInstance({ email: "b@x.io", name: "Bo" });
    users.save(ann).save(bo);
    await users.persist();

    // swap the emails in one unit of work — neither is a conflict (each vacates the other's target),
    // and the two-pass index update must not corrupt on the crossover
    ann.email = "b@x.io";
    bo.email = "a@x.io";
    users.save(ann).save(bo);
    await expect(users.persist()).resolves.toBeDefined();
    const byName = Object.fromEntries((await users.all().list()).map((u) => [u.name, u.email]));
    expect(byName).toEqual({ Ann: "b@x.io", Bo: "a@x.io" });

    // …and it stays enforced afterward: a third record can't take either now-occupied value
    users.save(users.createInstance({ email: "a@x.io", name: "Cy" }));
    await expect(users.persist()).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it("frees a value when a record is rewritten to a new one (index stays in sync)", async () => {
    const users = userOrm();
    const ann = users.createInstance({ email: "old@x.io", name: "Ann" });
    users.save(ann);
    await users.persist();

    await users.patch(ann.uuid, { email: "new@x.io" }); // Ann vacates old@x.io
    users.save(users.createInstance({ email: "old@x.io", name: "Bo" })); // …which Bo may now take
    await expect(users.persist()).resolves.toBeDefined();
    expect((await users.all().sort("name").list()).map((u) => u.email)).toEqual(["new@x.io", "old@x.io"]);
  });

  it("is a no-op for models without a unique field", async () => {
    const orm = new RepositoryManager();
    const notes = orm.define({ name: "Note", properties: { body: text() } });
    notes.save(notes.createInstance({ body: "same" }));
    notes.save(notes.createInstance({ body: "same" }));
    await expect(notes.persist()).resolves.toBeDefined();
    expect(await notes.all().count()).toBe(2);
  });

  it("a violation inside a transaction rolls the whole unit back", async () => {
    const backend = new InMemoryBackend();
    const orm = new RepositoryManager({ backend });
    const users = orm.define({ name: "User", properties: { email: text({ unique: true }), name: text() } });
    users.save(users.createInstance({ email: "a@x.io", name: "Ann" }));
    await users.persist();

    await expect(
      orm.transaction(async () => {
        users.save(users.createInstance({ email: "new@x.io", name: "New" }));
        users.save(users.createInstance({ email: "a@x.io", name: "Dup" })); // collides with the committed Ann
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(await users.all().count()).toBe(1); // neither queued write committed
  });
});
