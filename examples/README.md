# Examples

Runnable demos of the ORM. They import the **compiled package** (`../dist/index.js`), so they
exercise the same public surface a real consumer sees — build first.

```bash
pnpm demo                 # build + run multi-backend.ts
# or, after a build:
node examples/multi-backend.ts
```

Node 22.18+ strips the TypeScript types on the fly, so the examples run with plain `node` — no
separate compile step for the example file itself.

## `multi-backend.ts`

The headline claim, made falsifiable: **one model definition and one block of query/write code,
run against four different stores, producing byte-for-byte identical results.**

It defines a small music-library model once (`timestamps: true`, a compound index, an `array`
field) and runs the same scenario against each backend:

| Backend | Store |
|---|---|
| `InMemoryBackend` | a plain in-process map |
| `SQLiteBackend` | embedded SQLite via `node:sqlite` |
| `IndexedDBBackend` | browser IndexedDB, via `fake-indexeddb` in Node |
| `MongoBackend` *(optional)* | a real `mongod`, if `MONGO_URL` is set |

The scenario touches the breadth of the query pipeline — filters (`gt`, `startsWith`, `size`),
sort + paging, `aggregate`/`groupBy` and `groupByExpr` push-down, a computed server-side patch
(`score = plays * 2`), an array patch (`push`), `upsert` (update + insert), and auto
timestamps — then JSON-compares every backend's output against the first. If they ever diverge,
it prints the diff and exits non-zero.

```bash
node examples/multi-backend.ts
MONGO_URL=mongodb://localhost:27017 node examples/multi-backend.ts   # add the live-Mongo pass
```

## `realtime-chat.ts`  (`pnpm demo:chat`)

The **browser-vs-server** story over a WebSocket. One server owns the message store; three clients
("browsers") each run the *same* ORM model, but their backend is a `RemoteBackend` over a
`WebSocketTransport`. When one client saves a message, the server's change feed pushes it to every
other connected client live — no polling — and a late joiner reads the whole history back through
the same typed API. Swap `RemoteBackend` for a local store and the identical code runs embedded.

```bash
node examples/realtime-chat.ts
```

## `stats-aggregation.ts`  (`pnpm demo:stats`)

Why **aggregate push-down across the transport** matters. The server holds a large event table in
SQLite; a client asks "revenue by country" two ways, with a metering transport counting exactly
what crosses the wire:

- **push-down** — `groupBy(...sum...)` travels as an `aggregate` request; the server runs the
  `GROUP BY` and returns only the handful of summary rows.
- **naive** — fetch every row and reduce in the client; the whole table crosses the wire.

Same typed query, identical result — but the push-down moves kilobytes where the naive path moves
megabytes (≈14,000× less data on the default 50k-row table). That's the §11 "no silent O(n) cliff":
the heavy lifting stays next to the data.

```bash
node examples/stats-aggregation.ts
N=200000 node examples/stats-aggregation.ts   # bigger table, starker contrast
```

## `web/`  (`pnpm demo:web`)

An interactive **three-demo hub** served by one tiny Node server (`server.mjs`) on
`http://localhost:8080` — no bundler, no framework. Each page imports the compiled ORM from `/orm.js`
as a native ES module, so the browser runs the *same* ORM as the server; only the backend differs.

```bash
pnpm demo:web                 # build + serve on http://localhost:8080
pnpm demo:web --db=memory     # swap the store (sqlite | memory | postgres | mysql | mongo | mongo-memory)
```

### Swapping the server DB

The store behind the query demos (stats) and the chat store is chosen with `--db` (or the `DB` env
var), defaulting to `sqlite`. This is the ORM's whole point made visible: the same model, query, and
transport code runs unchanged — only the server backend differs, and aggregate push-down still
happens (natively for SQLite/Mongo, via the reference reducer for in-memory).

```bash
pnpm demo:web --db=sqlite         # embedded SQLite (default)
pnpm demo:web --db=memory         # in-process store
pnpm demo:web --db=postgres       # in-process Postgres emulator (pg-mem), zero setup
pnpm demo:web --db=mongo-memory   # ephemeral MongoDB (mongodb-memory-server)
POSTGRES_URL=postgres://localhost/app pnpm demo:web --db=postgres   # a real Postgres (pg)
MYSQL_URL=mysql://root@localhost/app   pnpm demo:web --db=mysql     # MySQL (needs `pnpm add mysql2`)
MONGO_URL=mongodb://localhost:27017    pnpm demo:web --db=mongo     # a real MongoDB
```

`--db=postgres` with no `POSTGRES_URL` runs an **in-process Postgres emulator** (`pg-mem`) — real
`jsonb` SQL and `GROUP BY` push-down with zero setup and no network — and with a `POSTGRES_URL` it
uses the `pg` driver against a real server. `--db=mongo-memory` spins up a throwaway `mongod` via
`mongodb-memory-server` (downloads a binary on first run, so it needs one-time network access;
offline environments should use `sqlite`/`memory`/`postgres`). `--db=mysql` needs a `MYSQL_URL` and
the `mysql2` package. The active store is shown on the stats page header and in `/api/orm/info`. The
offline-sync "cloud" is a `SyncTarget` (a different interface), so it stays an in-memory changelog.

### Offline Sync — `/sync.html`  (IndexedDB · `SyncBackend` · HLC)

A shared "Team Tasks" list where each browser tab is a device with its own IndexedDB store wrapped in
a `SyncBackend`; they reconcile through the server over a JSON pull/push API.

1. **Offline editing** — flip the Online/Offline switch and keep adding/checking tasks. They save
   instantly to this device's IndexedDB and pile up in the *outbox*; flip back online and they push.
2. **Two devices** — click *Open Device B* (a separate IndexedDB store). Edits on one device appear
   on the other after a sync; both converge to the server's state.
3. **Conflict (last-write-wins)** — take both devices offline, rename the same task differently on
   each, then bring both online: the later hybrid-logical-clock stamp wins on every replica.

### Live Stats — `/stats.html`  (`RemoteBackend` over `HttpTransport` · aggregate push-down)

The browser queries a server-side SQLite table (50k seeded events) through a `RemoteBackend`.
`groupBy` travels as one `aggregate` request, the server runs the SQL `GROUP BY`, and only the bars
you see come back — a metering transport shows it moving ~14,000× less data than *Compare vs
fetch-all* (which drags the whole table to the browser for the identical result). Change the group
key or the min-amount filter to re-query live.

### Realtime Chat — `/chat.html`  (`RemoteBackend` over `WebSocketTransport` · change feed)

Browser clients connect over a `WebSocketTransport` (the browser's native `WebSocket`) to one shared
server store. A message saved by anyone is pushed to every other client through the server's change
feed — open two tabs and watch them update with no polling.

### Verifying it

All three flows are asserted end to end in a real headless Chromium:

```bash
pnpm demo:web:verify   # boots the server on a private port, drives all three demos, tears down
```

It checks offline queue/flush + two-device convergence + HLC conflict resolution, aggregate
push-down vs fetch-all (and the byte savings), and live cross-client WebSocket delivery — exiting
non-zero on any failure. Needs `playwright-core` (a devDependency) and a Chromium build; it uses the
one on `PLAYWRIGHT_BROWSERS_PATH`, or set `PW_CHROMIUM_PATH` to point at your own. No browser download.
