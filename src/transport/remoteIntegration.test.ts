import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { RemoteBackend } from "./RemoteBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { eq, gt } from "../expressions/builders.js";

// The headline of the transport-as-backend symmetry (ARCHITECTURE.md §10): the exact same typed
// ORM runs client/server just by pointing the RepositoryManager at a RemoteBackend instead of a
// local one. Nothing in the model/query code changes.
describe("RepositoryManager over a RemoteBackend (client/server in-process)", () => {
  function clientServer() {
    const server = new InMemoryBackend();
    const transport = new InProcessTransport(new BackendAdapter(server));
    const remote = new RemoteBackend(transport, server.capabilities);
    return new RepositoryManager({ backend: remote });
  }

  it("runs the full define -> create -> save -> query loop over the wire", async () => {
    const orm = clientServer();
    const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });

    const peter = users.createInstance({ name: "Peter", age: 35 });
    users.save(peter);
    users.save(users.createInstance({ name: "John", age: 40 }));
    await users.persist();

    const all = await users.all().list();
    expect(all).toHaveLength(2);

    const peters = await users.all().filter(eq("name", "Peter")).list();
    expect(peters).toEqual([peter]); // identity preserved through the client repository

    const over38 = await users.all().filter(gt("age", 38)).list();
    expect(over38.map((u) => u.name)).toEqual(["John"]);
  });

  it("invalidates the client cache via the change feed crossing the boundary", async () => {
    const orm = clientServer();
    const users = orm.define({ name: "User", properties: { name: text(), age: integer() } });

    users.save(users.createInstance({ name: "Peter", age: 35 }));
    await users.persist();
    expect(await users.all().list()).toHaveLength(1);

    users.save(users.createInstance({ name: "John", age: 40 }));
    await users.persist();
    // The cache was invalidated by a change event that travelled server -> transport -> client.
    expect(await users.all().list()).toHaveLength(2);
  });
});
