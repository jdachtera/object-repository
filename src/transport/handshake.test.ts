import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { RemoteBackend, SchemaMismatchError } from "./RemoteBackend.js";
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
