/**
 * Backend for the web demos — one small Node server, three stories, no framework or bundler.
 *
 *   • Offline sync  — a shared InMemorySyncTarget the browser replicas reconcile through
 *                     (JSON pull/push at /api/sync/*).
 *   • Live stats    — a server-side SQLite table exposed over the ORM's HTTP transport at
 *                     /api/orm/rpc, so the browser's RemoteBackend (from /dist/transport/index.js)
 *                     pushes `groupBy` down to SQL.
 *   • Realtime chat — an InMemoryBackend behind a WebSocket BackendAdapter at /ws/chat, whose
 *                     change feed fans saved messages out to every connected client.
 *
 * The compiled ORM tree is served under /dist/ and imported by the pages as native ES modules, each
 * page pulling only the subpath entries it needs (core, transport, sync, indexeddb).
 *
 *   npm run demo:web        # builds the lib, then starts this on http://localhost:8080
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { InMemoryBackend, RepositoryManager, text, integer, date, SYSTEM_CONTEXT } from "../../dist/index.js";
import { SQLiteBackend } from "../../dist/backends/sqlite/index.js";
import { MongoBackend } from "../../dist/backends/mongo/index.js";
import { PostgresBackend } from "../../dist/backends/sql/PostgresBackend.js";
import { MySqlBackend } from "../../dist/backends/sql/MySqlBackend.js";
import { InMemorySyncTarget } from "../../dist/sync/index.js";
import { BackendAdapter, createRequestListener, attachWebSocketServer } from "../../dist/transport/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const ctx = SYSTEM_CONTEXT;
const PORT = Number(process.env.PORT ?? 8080);
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

// Which server-side store backs the query demos (stats) and the chat store. The offline-sync "cloud"
// is a SyncTarget (a different interface), so it stays an InMemorySyncTarget regardless.
//   node server.mjs --db=sqlite   (default)   npm run demo:web -- --db=memory
//   --db=mongo         needs MONGO_URL (e.g. mongodb://localhost:27017)
//   --db=mongo-memory  spins up an ephemeral mongod via mongodb-memory-server (no MONGO_URL; it
//                      downloads a mongod binary on first run, so it needs network access once)
//   --db=postgres      uses POSTGRES_URL via `pg` if set, else an in-process pg-mem (zero setup)
//   --db=mysql         needs MYSQL_URL and the `mysql2` package installed
const DB = (argOf("--db") ?? process.env.DB ?? "sqlite").toLowerCase();

/** Build a fresh backend of the selected kind. `label` just namespaces the Mongo db / SQLite file. */
async function makeBackend(label) {
  switch (DB) {
    case "memory":
      return new InMemoryBackend();
    case "sqlite":
      return new SQLiteBackend(new DatabaseSync(process.env.SQLITE_PATH ? `${process.env.SQLITE_PATH}.${label}` : ":memory:"));
    case "mongo":
    case "mongo-memory": {
      const url = DB === "mongo-memory" ? await memoryMongoUrl() : process.env.MONGO_URL;
      if (!url) throw new Error("--db=mongo requires MONGO_URL (e.g. MONGO_URL=mongodb://localhost:27017); or use --db=mongo-memory");
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(url);
      await client.connect();
      mongoClients.push(client);
      return new MongoBackend(client.db(`orm_demo_${label}`));
    }
    case "postgres": {
      if (process.env.POSTGRES_URL) {
        const { default: pg } = await import("pg");
        const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
        return new PostgresBackend(pool);
      }
      // No URL → an in-process Postgres emulator (pg-mem): real jsonb SQL, zero setup, no network.
      const { newDb } = await import("pg-mem");
      const { Pool } = newDb().adapters.createPg();
      return new PostgresBackend(new Pool());
    }
    case "mysql": {
      const url = process.env.MYSQL_URL;
      if (!url) throw new Error("--db=mysql requires MYSQL_URL (e.g. mysql://user:pass@host:3306/db)");
      const mysql = await import("mysql2/promise"); // requires `npm i mysql2`
      return new MySqlBackend(mysql.createPool(url));
    }
    default:
      throw new Error(`unknown --db "${DB}" (use sqlite | memory | mongo | mongo-memory | postgres | mysql)`);
  }
}
const mongoClients = [];
let mongoMemory; // shared ephemeral mongod (mongodb-memory-server), started lazily and reused

/** URL of an in-process mongod, started once and shared across the stats + chat stores. */
async function memoryMongoUrl() {
  if (!mongoMemory) {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    // Pin a real release — the auto-detected latest can 404 on the CDN for newer distros.
    mongoMemory = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION ?? "8.0.4" } });
  }
  return mongoMemory.getUri();
}

// Tidy up the ephemeral mongod + clients on exit so we don't leak a mongod process.
async function shutdown() {
  await Promise.allSettled(mongoClients.map((c) => c.close()));
  await mongoMemory?.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Offline sync: one shared "cloud" changelog ─────────────────────────────────────────────────
let cloud = new InMemorySyncTarget();

// ── Live stats: a table of events, seeded once, exposed over the ORM HTTP transport ────────────
const COUNTRIES = ["US", "DE", "FR", "GB", "JP", "BR"];
const N = Number(process.env.N ?? 50_000);
const statsStore = await makeBackend("stats").catch(onStoreError);
await seedStats(statsStore, N); // ready before we listen, so the first query sees a full table

function onStoreError(err) {
  console.error(`\n  Could not start the "${DB}" store: ${err?.message ?? err}`);
  if (DB === "mongo-memory") {
    console.error("  (--db=mongo-memory downloads a mongod binary on first run; this needs one-time");
    console.error("   network access. Offline? Use --db=sqlite / --db=memory, or --db=mongo with MONGO_URL.)\n");
  }
  process.exit(1);
}
const ormListener = createRequestListener(new BackendAdapter(statsStore), {
  rpcPath: "/api/orm/rpc",
  changesPath: "/api/orm/changes"
});

// ── Realtime chat: the same selected store behind a WebSocket adapter (attached below) ─────────
const chatStore = await makeBackend("chat").catch(onStoreError);

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function seedStats(store, n) {
  const mgr = new RepositoryManager({ backend: store });
  const events = mgr.define({ name: "Event", properties: { country: text({ index: true }), amount: integer(), ts: date() } });
  let s = 42 >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  for (let i = 0; i < n; i++) {
    const country = COUNTRIES[Math.floor(rand() * COUNTRIES.length)];
    const amount = 1 + Math.floor(rand() * 1000);
    const yr = 2022 + Math.floor(rand() * 3);
    events.save(events.createInstance({ country, amount, ts: new Date(Date.UTC(yr, Math.floor(rand() * 12), 1)) }));
  }
  return events.persist();
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res, status, obj) => send(res, status, JSON.stringify(obj));

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

/** Fold the append-only changelog into the cloud's current records (latest, non-tombstoned). */
async function cloudState() {
  const { changes } = await cloud.pull(null, ctx);
  const latest = new Map();
  for (const c of changes) {
    const prev = latest.get(c.uuid);
    if (!prev || c.version > prev.version) latest.set(c.uuid, c);
  }
  return [...latest.values()]
    .filter((c) => c.kind === "saved" && !c.record?._deleted)
    .map((c) => ({ uuid: c.uuid, title: c.record?.title, done: !!c.record?.done, version: c.version }));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // ORM HTTP transport (stats) — delegate the matching paths to the adapter listener.
    if (path === "/api/orm/rpc" || path === "/api/orm/changes") return ormListener(req, res);
    if (path === "/api/orm/info") return json(res, 200, { count: N, backend: DB });

    // Offline-sync JSON API
    if (path === "/api/sync/pull" && req.method === "POST") {
      const { cursor } = await readBody(req);
      return json(res, 200, await cloud.pull(cursor ?? null, ctx));
    }
    if (path === "/api/sync/push" && req.method === "POST") {
      const { changes } = await readBody(req);
      return json(res, 200, await cloud.push(changes ?? [], ctx));
    }
    if (path === "/api/sync/state" && req.method === "GET") {
      return json(res, 200, { records: await cloudState() });
    }
    if (path === "/api/sync/reset" && req.method === "POST") {
      cloud = new InMemorySyncTarget();
      return json(res, 200, { ok: true });
    }

    // Static: /dist/* → the compiled library tree (per-backend subpath entries + shared chunks), so a
    // page pulls only the entry it imports — core from /dist/index.js, transport from
    // /dist/transport/index.js, etc. Everything else → public/.
    const distDir = join(here, "../../dist");
    let file;
    if (path.startsWith("/dist/")) {
      file = join(distDir, path.slice("/dist/".length));
      if (file !== distDir && !file.startsWith(distDir + "/")) return send(res, 403, "Forbidden", "text/plain");
    } else {
      file = join(here, "public", path === "/" ? "index.html" : path);
    }
    const body = await readFile(file);
    return send(res, 200, body, TYPES[extname(file)] ?? "application/octet-stream");
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, "Not found", "text/plain");
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

// Realtime chat over WebSocket, sharing the HTTP server's port.
attachWebSocketServer(new WebSocketServer({ server, path: "/ws/chat" }), new BackendAdapter(chatStore));

server.listen(PORT, () => {
  console.log(`\n  ORM web demos →  http://localhost:${PORT}   (server store: ${DB})\n`);
  console.log("    /            three-demo hub");
  console.log("    /sync.html   offline sync (open in two tabs)");
  console.log(`    /stats.html  live stats over HTTP (${N.toLocaleString()} rows seeded in ${DB})`);
  console.log("    /chat.html   realtime chat over WebSocket (open in two tabs)\n");
  console.log("  swap the store:  --db=sqlite | memory | mongo | mongo-memory | postgres | mysql\n");
});
