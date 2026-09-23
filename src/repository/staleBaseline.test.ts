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

  it("stops carrying fields forward for a model another process rolled back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-baseline-"));
    try {
      const file = join(dir, "db.sqlite");
      const processA = new SQLiteBackend(new DatabaseSync(file));
      const processB = new SQLiteBackend(new DatabaseSync(file));
      processA.save("Doc", { uuid: "d1", title: "t" }, SYSTEM_CONTEXT);
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
      expect(stored).toEqual({ uuid: "d1", title: "edited" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
