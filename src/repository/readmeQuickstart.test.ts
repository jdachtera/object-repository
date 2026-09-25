/** The README quickstart's migration must actually run on the backend the README constructs. */
import { it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { text } from "../properties/factories.js";
it("the README quickstart migration runs on the in-memory backend", async () => {
  const orm = new RepositoryManager();
  const users = orm.define({ name: "User", properties: { name: text(), state: text() } });
  await users.save(users.createInstance({ name: "Ada" })).persist();
  await orm.migrate([
    { name: "0001_add_status", up: (m) => m.addField("User", "status", "text", { fill: "active" }) },
    { name: "0002_rename", up: (m) => m.renameField("User", "status", "state", "text"), down: (m) => m.renameField("User", "state", "status", "text") }
  ]);
  expect((await users.all().list())[0]!.state).toBe("active");
});
