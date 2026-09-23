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
});
