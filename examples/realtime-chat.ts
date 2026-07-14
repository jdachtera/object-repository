/**
 * Realtime chat over a WebSocket — the "browser vs server" story, end to end.
 *
 * One server owns the message store. Three independent clients ("browsers") each run the *same* ORM
 * model and the *same* query/write code, but their backend is a `RemoteBackend` over a
 * `WebSocketTransport` — so every read, write, and live update crosses the wire. When one client
 * saves a message, the server's change feed pushes it to every other connected client (§7), and
 * they render it without polling. Swap `RemoteBackend` for a local store and the identical code runs
 * embedded — client/server is a backend swap, not a rewrite.
 *
 *   npm run build && node examples/realtime-chat.ts
 *
 * Uses the `ws` package (a dev dependency) for both the server and the Node-side client sockets; in
 * a browser the client would use the global `WebSocket` and nothing else would change.
 */
import { WebSocketServer, WebSocket as WsClient } from "ws";
import type { AddressInfo } from "node:net";
import {
  RepositoryManager,
  InMemoryBackend,
  text,
  eq,
  SYSTEM_CONTEXT,
  type ChangeEvent
} from "../dist/index.js";
import { BackendAdapter, attachWebSocketServer, RemoteBackend, WebSocketTransport } from "../dist/transport/index.js";

const ctx = SYSTEM_CONTEXT;

// ── The model: defined the same way on every client ─────────────────────────────────────────────
function defineChat(orm: RepositoryManager) {
  return orm.define({
    name: "Message",
    timestamps: true,
    properties: { room: text(), author: text(), body: text() }
  });
}

// ── A client = a "browser": same model, but the store is remote ─────────────────────────────────
function connectClient(name: string, url: string) {
  const transport = new WebSocketTransport(url, { WebSocket: WsClient as unknown as never });
  const backend = new RemoteBackend(transport, new InMemoryBackend().capabilities);
  const orm = new RepositoryManager({ backend });
  const messages = defineChat(orm);
  const inbox: Array<{ author: string; body: string }> = [];

  // Subscribe to the server's change feed: messages saved by anyone show up here, live.
  backend.changes((e: ChangeEvent) => {
    if (e.kind !== "saved" || e.model !== "Message" || !e.record) return;
    inbox.push({ author: String(e.record.author), body: String(e.record.body) });
  }, ctx);

  return { name, transport, backend, messages, inbox };
}

type Client = ReturnType<typeof connectClient>;

async function post(sender: Client, others: Client[], body: string) {
  sender.messages.save(sender.messages.createInstance({ room: "general", author: sender.name, body }));
  await sender.messages.persist(); // travels to the server over the socket
  // wait until the server has pushed this message to every other connected client
  await waitUntil(() => others.every((o) => o.inbox.some((m) => m.author === sender.name && m.body === body)), 2000);
  console.log(`  ${sender.name} posts: "${body}"`);
  for (const o of others) console.log(`    → ${o.name} received live:  ${sender.name}: ${body}`);
}

async function main() {
  // ── Server: an in-memory store behind a WebSocket BackendAdapter ──────────────────────────────
  const serverStore = new InMemoryBackend();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  attachWebSocketServer(wss, new BackendAdapter(serverStore));
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

  console.log("Realtime chat over WebSocket — same ORM model in every client, one server store.\n");
  console.log(`  server:  in-memory store behind a WebSocket BackendAdapter (${url})`);

  try {
    // ── Three browsers connect ──────────────────────────────────────────────────────────────────
    const alice = connectClient("Alice", url);
    const bob = connectClient("Bob", url);
    const carol = connectClient("Carol", url);
    const everyone = [alice, bob, carol];

    // Force each socket open (and the server-side subscription live) before anyone posts.
    await Promise.all(everyone.map((c) => c.messages.all().count()));
    console.log(`  clients: ${everyone.map((c) => c.name).join(", ")}  (each a RemoteBackend over WebSocketTransport)\n`);

    // ── A conversation: every post fans out to the other two, live ──────────────────────────────
    await post(alice, [bob, carol], "hey all 👋");
    await post(bob, [alice, carol], "morning!");
    await post(carol, [alice, bob], "what's the plan today?");
    await post(alice, [bob, carol], "ship the chat demo 🚀");

    // ── The data lives on the server: a brand-new client reads the whole history back ───────────
    const latecomer = connectClient("Dave", url);
    const history = await latecomer.messages.all().sort("createdAt").list();
    console.log(`\n  Dave joins late and reads history from the server (${history.length} messages):`);
    for (const m of history) console.log(`    ${m.author}: ${m.body}`);

    const fromAlice = await latecomer.messages.all().filter(eq("author", "Alice")).count();
    console.log(`\n  Filtered query runs server-side too: Alice sent ${fromAlice} of them.`);
    console.log("\n✓ every message reached every other client live — one model, the store is just remote.");

    for (const c of [...everyone, latecomer]) c.transport.close();
  } finally {
    wss.close();
  }
}

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for live delivery"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
