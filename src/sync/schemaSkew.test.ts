/**
 * Schema skew on the sync path.
 *
 * This is the failure that used to be silent: a client months out of date pulled records in a shape it
 * could not interpret and pushed records the server no longer understood, and nothing anywhere said
 * so. Sync writes land below the Repository, so there is no validation to catch it either.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { InMemorySyncTarget } from "./InMemorySyncTarget.js";
import { RemoteSyncTarget } from "./RemoteSyncTarget.js";
import { SyncBackend, SyncSchemaError } from "./SyncBackend.js";
import { SyncTargetAdapter } from "../transport/SyncTargetAdapter.js";
import { InProcessTransport } from "../transport/InProcessTransport.js";
import { SYSTEM_CONTEXT } from "../core/types.js";
import type { SchemaVersioning } from "../core/types.js";

const ctx = SYSTEM_CONTEXT;

/** A client syncing against a server that declares versions 7 / floor 5. */
function connected(clientSchema?: SchemaVersioning, serverSchema: SchemaVersioning = { schemaVersion: 7, minSupportedSchemaVersion: 5 }) {
  const adapter = new SyncTargetAdapter(new InMemorySyncTarget(), serverSchema);
  const remote = new RemoteSyncTarget(new InProcessTransport(adapter));
  return new SyncBackend({ local: new InMemoryBackend(), remote, ...(clientSchema ? { schema: clientSchema } : {}) });
}

describe("the sync handshake", () => {
  it("lets a client within the supported range sync", async () => {
    await expect(connected({ schemaVersion: 6 }).reconcile(ctx)).resolves.toBeUndefined();
  });

  it("refuses a client below the server's floor, instead of exchanging records neither understands", async () => {
    const stale = connected({ schemaVersion: 3 });
    await expect(stale.reconcile(ctx)).rejects.toThrow(SyncSchemaError);
    await expect(stale.reconcile(ctx)).rejects.toThrow(/no longer supports anything below 5/);
  });

  it("refuses a client ahead of the server", async () => {
    await expect(connected({ schemaVersion: 9 }).reconcile(ctx)).rejects.toThrow(/Deploy the server before the client/);
  });

  it("carries the reason on the error, so a client can tell 'upgrade me' from a transport failure", async () => {
    try {
      await connected({ schemaVersion: 3 }).reconcile(ctx);
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as SyncSchemaError).code).toBe("SCHEMA_TOO_OLD");
    }
  });
});

describe("deployability of the check itself", () => {
  it("syncs against a server too old to know the handshake method", async () => {
    // An upgraded client must not be blocked by a server that has not been redeployed yet, so an
    // UNSUPPORTED_METHOD answer reads as 'unchecked' rather than as a refusal.
    const adapter = new SyncTargetAdapter(new InMemorySyncTarget()); // no schema declared
    const remote = new RemoteSyncTarget(new InProcessTransport(adapter));
    const client = new SyncBackend({ local: new InMemoryBackend(), remote, schema: { schemaVersion: 7 } });

    await expect(client.reconcile(ctx)).resolves.toBeUndefined();
  });

  it("syncs when the target has no handshake at all", async () => {
    // A directly-wired target (no transport) has no remote schema to ask about.
    const client = new SyncBackend({ local: new InMemoryBackend(), remote: new InMemorySyncTarget() });
    await expect(client.reconcile(ctx)).resolves.toBeUndefined();
  });

  it("checks once per session, not on every reconcile", async () => {
    let handshakes = 0;
    const inner = new InMemorySyncTarget();
    const client = new SyncBackend({
      local: new InMemoryBackend(),
      schema: { schemaVersion: 7 },
      remote: {
        pull: (cursor, c) => inner.pull(cursor, c),
        push: (changes, c) => inner.push(changes, c),
        handshake: async () => {
          handshakes += 1;
          return { compatible: true, basis: "version" };
        }
      }
    });

    await client.reconcile(ctx);
    await client.reconcile(ctx);
    await client.reconcile(ctx);
    expect(handshakes).toBe(1);
  });
});

describe("the server enforces, and nothing fails open", () => {
  it("refuses a client that never shakes hands, once the floor has risen past version 0", async () => {
    const adapter = new SyncTargetAdapter(new InMemorySyncTarget(), { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    const transport = new InProcessTransport(adapter);
    const response = await transport.request({ method: "pull", params: { cursor: null } }, ctx);
    expect(response).toMatchObject({ ok: false, error: { code: "SCHEMA_TOO_OLD" } });
  });

  it("still serves a pre-versioning client while the floor allows version 0", async () => {
    const adapter = new SyncTargetAdapter(new InMemorySyncTarget(), { schemaVersion: 1 }); // floor defaults to 0
    const response = await new InProcessTransport(adapter).request({ method: "pull", params: { cursor: null } }, ctx);
    expect(response.ok).toBe(true);
  });

  it("refuses a connected client on its next request after a redeploy raises the floor", async () => {
    let adapter = new SyncTargetAdapter(new InMemorySyncTarget(), { schemaVersion: 7, minSupportedSchemaVersion: 5 });
    const transport = new InProcessTransport({ handle: (request, context) => adapter.handle(request, context) });
    const client = new SyncBackend({ local: new InMemoryBackend(), remote: new RemoteSyncTarget(transport), schema: { schemaVersion: 6 } });
    await client.reconcile(ctx); // handshake passes, once per session

    adapter = new SyncTargetAdapter(new InMemorySyncTarget(), { schemaVersion: 8, minSupportedSchemaVersion: 7 });
    await expect(client.reconcile(ctx)).rejects.toMatchObject({ code: "SCHEMA_TOO_OLD" });
  });

  it("treats a failed handshake as a failure, not as a server too old to check", async () => {
    const transport = new InProcessTransport({
      handle: async () => ({ ok: false, error: { code: "UNAUTHORIZED", message: "who are you" } })
    });
    const client = new SyncBackend({ local: new InMemoryBackend(), remote: new RemoteSyncTarget(transport), schema: { schemaVersion: 6 } });
    await expect(client.reconcile(ctx)).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("refuses a version that isn't a whole number rather than let it pass every comparison", async () => {
    const floor = Number(process.env.SURELY_UNSET_MIN_SCHEMA); // NaN
    await expect(connected({ schemaVersion: 6 }, { schemaVersion: 7, minSupportedSchemaVersion: floor }).reconcile(ctx)).rejects.toMatchObject({
      code: "SCHEMA_INVALID"
    });
  });
});
