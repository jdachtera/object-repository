# Sync deployment — client & server

Offline-first sync is a `SyncBackend` on the client reconciling with a `SyncTarget` on the server. This
page is the **durable, networked** wiring: a server whose changelog lives in a real store, reached over a
transport. (For the reactive/optimistic story that sits on top, see [`reactive.md`](./reactive.md).)

```
client:  SyncBackend({ local: IndexedDBBackend, remote: RemoteSyncTarget(transport) })
                                                          │  pull / push  (HTTP or WS)
server:  createRequestListener( SyncTargetAdapter( BackendSyncTarget(realStore) ) )
                                                    └── durable changelog in Postgres / SQLite / Mongo
```

Four pieces, all shipped:

| Piece | Side | What it is |
| ----- | ---- | ---------- |
| `BackendSyncTarget` | server | a durable `SyncTarget` — the append-only changelog + last-write-wins protocol, persisted in an injected `Backend` (survives restarts) |
| `SyncTargetAdapter` | server | exposes a `SyncTarget`'s `pull`/`push` over a transport (the sync analogue of `BackendAdapter`) |
| `RemoteSyncTarget` | client | a `SyncTarget` that proxies `pull`/`push` to the server over a `Transport` |
| `SyncBackend` | client | the offline-first local store + reconcile loop (unchanged) |

## Server

```ts
import { RepositoryManager } from "object-repository";
import { SQLiteBackend } from "object-repository/sqlite";               // or object-repository/postgres, object-repository/mongo …
import { BackendSyncTarget } from "object-repository/sync";
import { SyncTargetAdapter } from "object-repository/transport";
import { createRequestListener } from "object-repository/transport";
import { createServer } from "node:http";

// The changelog is persisted in whatever backend you inject — here a SQLite file.
const store = new SQLiteBackend(db);
const target = new BackendSyncTarget(store);            // durable hub

const listener = createRequestListener(new SyncTargetAdapter(target), {
  context: (req) => authenticate(req),                  // → the Context every pull/push runs under
});
createServer(listener).listen(8080);
```

The changelog lives in its own model (`__sync_changes__` by default — override with `changelogModel`)
in that store, so it can share a database with anything else. The **pull cursor is a server-assigned
append sequence**, not the HLC version: a change pushed from a device with a lagging clock still lands at
the end of the log and reaches every client — `version` is used only to arbitrate last-write-wins.

## Client

```ts
import { RepositoryManager } from "object-repository";
import { IndexedDBBackend } from "object-repository/indexeddb";
import { SyncBackend, RemoteSyncTarget } from "object-repository/sync";
import { HttpTransport } from "object-repository/transport";

const remote = new RemoteSyncTarget(new HttpTransport("https://api.example.com"));
const backend = new SyncBackend({ local: new IndexedDBBackend(), remote, nodeId: deviceId, fieldLevel: true });
const orm = new RepositoryManager({ backend });

// Reads/writes are instant + local; call reconcile() to push the outbox and pull remote changes.
await backend.reconcile(ctx);                            // on connect, on a timer, on reconnect
```

`local` can be any backend: `IndexedDBBackend` (persists across reloads, pulls only the delta since its
last cursor — the normal choice), or `InMemoryBackend` (ephemeral; re-downloads the log each session).
Set `fieldLevel: true` on **every** client for per-field last-write-wins (concurrent edits to different
fields of one record both survive) — it must be uniform across the deployment.

## Guarantees & limits

- **Durable.** The changelog persists in the injected store; a restarted server re-seeds its append
  cursor from the persisted max, so sequence numbers never collide (verified over SQLite and in-memory).
- **Convergence.** Two clients through the durable server converge under whole-record LWW and field-level
  merge, identically to the in-memory reference target (same test battery).
- **Single-process sequence.** `push` is serialized within one process so `seq` assignment and the
  conflict check are atomic. Across **multiple** server processes sharing one store, front the sequence
  with a real DB sequence/lock or run a single hub — otherwise concurrent pushes on two processes could
  reuse a `seq`.
- **Log growth.** The changelog is append-only (it must be, to serve field-level merges and tombstones);
  compaction — collapsing superseded whole-record versions past a horizon — is not yet built.
- **Transport.** `pull`/`push` are request/response, so `HttpTransport` is the natural fit; reconcile is
  client-driven (poll / on-reconnect). A server→client *push* of new changes (so clients reconcile the
  instant a peer writes) would ride the WebSocket change feed — not wired into the sync path yet.
- **Auth.** Authenticated via the `Context` the transport supplies; wrap the target for per-request
  authorization the same way you'd wrap a backend with `PolicyBackend`.
