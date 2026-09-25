/**
 * A migration run by another process changes the stored shape behind this process's repositories. The
 * repository's write baselines — which carry undeclared fields forward on save — must follow, or a
 * dropped field comes back with the next save.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { RepositoryManager } from "./RepositoryManager.js";
import { text } from "../properties/factories.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { MigrationBuilder } from "../migrations/types.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

describe("a field dropped by another process's migration", () => {
  it("is not written back by this process's next save, once it has refreshed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-baseline-"));
    try {
      const file = join(dir, "db.sqlite");
      const processA = new SQLiteBackend(new DatabaseSync(file));
      const processB = new SQLiteBackend(new DatabaseSync(file));

      // A record carrying a field the application doesn't declare (written by an older build).
      processA.save("Doc", { uuid: "d1", title: "t", ssn: "123-45" }, SYSTEM_CONTEXT);
      await processA.persist(SYSTEM_CONTEXT);

      const appA = new RepositoryManager({ backend: processA });
      const docs = appA.define({ name: "Doc", properties: { title: text() } });
      await appA.refreshSchemaState(); // at startup
      const doc = (await docs.get("d1"))!; // the baseline now holds `ssn`

      // Another process removes the field.
      await new RepositoryManager({ backend: processB }).migrate([{ name: "0001_drop_ssn", up: (m) => m.dropField("Doc", "ssn") }], {
        models: { Doc: { fields: [], indexes: [] } }
      });

      await appA.refreshSchemaState(); // after the deploy
      doc.title = "edited";
      await docs.save(doc).persist();

      const [stored] = await processB.query({ model: "Doc", where: { type: "all" }, order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
      expect(stored).toEqual({ uuid: "d1", title: "edited" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not written back after the first refresh of a process that never read the journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-baseline-"));
    try {
      const file = join(dir, "db.sqlite");
      const processA = new SQLiteBackend(new DatabaseSync(file));
      const processB = new SQLiteBackend(new DatabaseSync(file));
      processA.save("Doc", { uuid: "d1", title: "t", ssn: "123-45" }, SYSTEM_CONTEXT);
      await processA.persist(SYSTEM_CONTEXT);

      const appA = new RepositoryManager({ backend: processA });
      const docs = appA.define({ name: "Doc", properties: { title: text() } }); // no window: no startup read
      const doc = (await docs.get("d1"))!;

      await new RepositoryManager({ backend: processB }).migrate([{ name: "0001_drop_ssn", up: (m) => m.dropField("Doc", "ssn") }], {
        models: { Doc: { fields: [], indexes: [] } }
      });

      await appA.refreshSchemaState(); // its first read of the journal
      doc.title = "edited";
      await docs.save(doc).persist();
      const [stored] = await processB.query({ model: "Doc", where: { type: "all" }, order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
      expect(stored).toEqual({ uuid: "d1", title: "edited" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a renamed value on a record loaded before the rename", async () => {
    const { InMemoryBackend } = await import("../backends/memory/InMemoryBackend.js");
    const { integer } = await import("../properties/factories.js");
    const backend = new InMemoryBackend();
    backend.save("User", { uuid: "u1", name: "Ann", age: 1 }, SYSTEM_CONTEXT);
    await backend.persist(SYSTEM_CONTEXT);
    const orm = new RepositoryManager({ backend });
    const users = orm.define({ name: "User", properties: { fullName: text(), age: integer() } });
    const user = (await users.get("u1"))!; // loaded before: no `fullName` stored yet

    await orm.migrate([{ name: "0001_fullname", up: (m) => m.renameField("User", "name", "fullName", "text") }]);
    user.age = 2;
    await users.save(user).persist();
    const [stored] = await backend.query({ model: "User", where: { type: "all" }, order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
    expect(stored).toEqual({ uuid: "u1", fullName: "Ann", age: 2 });
  });

  it("replays a rename and a later drop of the renamed field in the order they ran", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-baseline-"));
    try {
      const file = join(dir, "db.sqlite");
      const processA = new SQLiteBackend(new DatabaseSync(file));
      const processB = new SQLiteBackend(new DatabaseSync(file));
      processA.save("Doc", { uuid: "d1", title: "t", a: "x" }, SYSTEM_CONTEXT);
      await processA.persist(SYSTEM_CONTEXT);

      const appA = new RepositoryManager({ backend: processA });
      const docs = appA.define({ name: "Doc", properties: { title: text() } });
      await appA.refreshSchemaState();
      const doc = (await docs.get("d1"))!;

      // These two names load from the journal in the reverse of the order they ran.
      await new RepositoryManager({ backend: processB }).migrate(
        [
          { name: "0001_rename_0", up: (m) => m.renameField("Doc", "a", "b", "text") },
          { name: "0002_drop_0", up: (m) => m.dropField("Doc", "b") }
        ],
        { models: { Doc: { fields: [], indexes: [] } } }
      );

      await appA.refreshSchemaState();
      doc.title = "edited";
      await docs.save(doc).persist();
      const [stored] = await processB.query({ model: "Doc", where: { type: "all" }, order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
      expect(stored).toEqual({ uuid: "d1", title: "edited" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows another process's rollback: drops what it removed, keeps what it didn't touch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-baseline-"));
    try {
      const file = join(dir, "db.sqlite");
      const processA = new SQLiteBackend(new DatabaseSync(file));
      const processB = new SQLiteBackend(new DatabaseSync(file));
      processA.save("Doc", { uuid: "d1", title: "t", keep: "k" }, SYSTEM_CONTEXT); // `keep` is undeclared
      await processA.persist(SYSTEM_CONTEXT);

      const migration = {
        name: "0001_extra",
        up: (m: MigrationBuilder) => m.addField("Doc", "extra", "text", { fill: "e" }),
        down: (m: MigrationBuilder) => m.dropField("Doc", "extra")
      };
      const models = { Doc: { fields: [], indexes: [] } };
      const appB = new RepositoryManager({ backend: processB });
      await appB.migrate([migration], { models });

      const appA = new RepositoryManager({ backend: processA });
      const docs = appA.define({ name: "Doc", properties: { title: text() } });
      await appA.refreshSchemaState();
      const doc = (await docs.get("d1"))!; // the baseline holds `extra`

      await appB.rollback([migration], 1, { models });
      await appA.refreshSchemaState();
      doc.title = "edited";
      await docs.save(doc).persist();
      const [stored] = await processB.query({ model: "Doc", where: { type: "all" }, order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
      expect(stored).toEqual({ uuid: "d1", title: "edited", keep: "k" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
