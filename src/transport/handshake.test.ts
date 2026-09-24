import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { RemoteBackend, SchemaMismatchError, SchemaTooOldError, SchemaTooNewError } from "./RemoteBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { schemaFingerprint } from "../properties/fingerprint.js";
import { SYSTEM_CONTEXT } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;

describe("schema fingerprint", () => {
  it("is stable across definition / property order and changes with the shape", () => {
    const a = { User: { name: text(), age: integer() }, Post: { title: text() } };
    const b = { Post: { title: text() }, User: { age: integer(), name: text() } }; // reordered
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));

    expect(schemaFingerprint({ User: { name: text() } })).not.toBe(
      schemaFingerprint({ User: { name: integer() } }) // same field, different type
    );
    expect(schemaFingerprint({ User: { name: text() } })).not.toBe(
      schemaFingerprint({ User: { name: text({ unique: true }) } }) // unique flag changed
    );
  });

  it("RepositoryManager.fingerprint reflects all defined models", () => {
    const m1 = new RepositoryManager();
    m1.define({ name: "User", properties: { name: text(), age: integer() } });
    const m2 = new RepositoryManager();
    m2.define({ name: "User", properties: { name: text(), age: integer() } });
    expect(m1.fingerprint()).toBe(m2.fingerprint());

    const m3 = new RepositoryManager();
    m3.define({ name: "User", properties: { name: text(), age: text() } }); // age type drifted
    expect(m3.fingerprint()).not.toBe(m1.fingerprint());
  });
});

describe("RemoteBackend.handshake", () => {
  function server(fingerprint?: string) {
    return new InProcessTransport(new BackendAdapter(new InMemoryBackend(), fingerprint));
  }

  it("passes when client and server schemas match", async () => {
    const fp = schemaFingerprint({ User: { name: text(), age: integer() } });
    const remote = new RemoteBackend(server(fp), new InMemoryBackend().capabilities);
    await expect(remote.handshake(fp, ctx)).resolves.toBeUndefined();
  });

  it("throws SchemaMismatchError when they differ", async () => {
    const serverFp = schemaFingerprint({ User: { name: text(), age: integer() } });
    const clientFp = schemaFingerprint({ User: { name: text(), age: text() } }); // drift
    const remote = new RemoteBackend(server(serverFp), new InMemoryBackend().capabilities);
    await expect(remote.handshake(clientFp, ctx)).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  it("is a no-op when the server advertises no fingerprint", async () => {
    const remote = new RemoteBackend(server(undefined), new InMemoryBackend().capabilities);
    await expect(remote.handshake("anything", ctx)).resolves.toBeUndefined();
  });
});

describe("a rolling deploy: the two ends legitimately differ", () => {
  /** The server after the rename, mid-window. */
  const serverManager = () => {
    const orm = new RepositoryManager({
      backend: new InMemoryBackend(),
      schema: { schemaVersion: 7, minSupportedSchemaVersion: 5 }
    });
    orm.define({
      name: "User",
      properties: { fullName: text(), name: text({ deprecatedSince: 7, mirrors: "fullName" }) }
    });
    return orm;
  };

  /** An older client instance, still deployed, that only knows the original field. */
  const clientManager = (schemaVersion: number) => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend(), schema: { schemaVersion } });
    orm.define({ name: "User", properties: { name: text() } });
    return orm;
  };

  const connect = (server: RepositoryManager) => {
    const adapter = new BackendAdapter(
      new InMemoryBackend(),
      server.fingerprint(),
      undefined,
      undefined,
      undefined,
      { schemaVersion: 7, minSupportedSchemaVersion: 5 }
    );
    return new RemoteBackend(new InProcessTransport(adapter), new InMemoryBackend().capabilities);
  };

  it("connects even though the fingerprints differ, because both declare a version", async () => {
    const server = serverManager();
    const client = clientManager(6);
    expect(client.fingerprint()).not.toBe(server.fingerprint()); // the window, by construction

    await expect(
      connect(server).handshake(client.fingerprint(), ctx, { schemaVersion: 6 })
    ).resolves.toBeUndefined();
  });

  it("refuses a client below the server's floor, so it fails at connect rather than mid-query", async () => {
    const server = serverManager();
    const stale = clientManager(4);
    await expect(connect(server).handshake(stale.fingerprint(), ctx, { schemaVersion: 4 })).rejects.toThrow(
      SchemaTooOldError
    );
  });

  it("refuses a client ahead of the server", async () => {
    const server = serverManager();
    const ahead = clientManager(9);
    await expect(connect(server).handshake(ahead.fingerprint(), ctx, { schemaVersion: 9 })).rejects.toThrow(
      SchemaTooNewError
    );
  });

  it("still refuses drift when the client declares no version at all", async () => {
    // Nothing changes for anyone not using the gate: shapes must match exactly.
    const server = serverManager();
    const unversioned = new RepositoryManager({ backend: new InMemoryBackend() });
    unversioned.define({ name: "User", properties: { name: text() } });

    await expect(connect(server).handshake(unversioned.fingerprint(), ctx)).rejects.toThrow(SchemaMismatchError);
  });
});

describe("per-request enforcement over the backend transport", () => {
  it("refuses a query from a client below the floor even without a handshake, with a typed error", async () => {
    const { BackendAdapter } = await import("./BackendAdapter.js");
    const { InProcessTransport } = await import("./InProcessTransport.js");
    const { RemoteBackend, SchemaTooOldError, SchemaMismatchError } = await import("./RemoteBackend.js");
    const { InMemoryBackend } = await import("../backends/memory/InMemoryBackend.js");
    const { SYSTEM_CONTEXT } = await import("../core/types.js");
    const adapter = new BackendAdapter(new InMemoryBackend(), undefined, undefined, undefined, undefined, { schemaVersion: 7, minSupportedSchemaVersion: 7 });
    const remote = new RemoteBackend(new InProcessTransport(adapter), new InMemoryBackend().capabilities);
    const query = remote.query({ model: "User", where: { type: "all" }, order: [], paging: { start: 0 } }, SYSTEM_CONTEXT);
    await expect(query).rejects.toBeInstanceOf(SchemaTooOldError);
    await expect(query).rejects.toBeInstanceOf(SchemaMismatchError); // one instanceof catches every refusal
  });
});

describe("commands under a versioned server", () => {
  it("are served for an up-to-date client, and refused for a stale one", async () => {
    const { BackendAdapter } = await import("./BackendAdapter.js");
    const { InProcessTransport } = await import("./InProcessTransport.js");
    const { InMemoryBackend } = await import("../backends/memory/InMemoryBackend.js");
    const { RepositoryManager } = await import("../repository/RepositoryManager.js");
    const { command } = await import("./command.js");
    const commands = { ping: command({ handler: async () => "pong" }) };
    const adapter = new BackendAdapter(new InMemoryBackend(), undefined, commands, undefined, undefined, { schemaVersion: 3 });
    const transport = new InProcessTransport(adapter);

    const current = new RepositoryManager({ schema: { schemaVersion: 3 } }).commands<typeof commands>(transport);
    await expect(current.ping(undefined)).resolves.toBe("pong");

    const stale = new RepositoryManager({ schema: { schemaVersion: 1 } }).commands<typeof commands>(transport);
    await expect(stale.ping(undefined)).rejects.toMatchObject({ code: "SCHEMA_TOO_OLD" });
  });
});
