// Realtime-chat demo. The browser uses the native WebSocket via WebSocketTransport — same ORM model
// and RemoteBackend as everywhere else. Messages saved by any client are pushed to all the others
// through the server's change feed (server→client), so the UI never polls.
import { RepositoryManager, text, SYSTEM_CONTEXT } from "/dist/index.js";
import { RemoteBackend, WebSocketTransport } from "/dist/transport/index.js";

const ctx = SYSTEM_CONTEXT;
const CAPS = { indexes: false, ranges: false, sortPushdown: false, joins: false, transactions: true, changeFeed: true };

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/chat`;
const transport = new WebSocketTransport(wsUrl); // browser's global WebSocket — nothing to inject
const backend = new RemoteBackend(transport, CAPS);
const orm = new RepositoryManager({ backend });
const messages = orm.define({ name: "Message", timestamps: true, properties: { room: text(), author: text(), body: text() } });

const $ = (id) => document.getElementById(id);
const me = randomName();
$("author").value = me;

const seen = new Set();
const myUuids = new Set();

function append(m) {
  if (seen.has(m.uuid)) return;
  seen.add(m.uuid);
  const el = document.createElement("div");
  el.className = "msg" + (myUuids.has(m.uuid) || m.author === $("author").value ? " mine" : "");
  el.innerHTML = `<span class="who">${esc(m.author)}</span><span class="bubble">${esc(m.body)}</span>`;
  const box = $("messages");
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// Live feed: every saved Message (from anyone) arrives here.
backend.changes((e) => {
  if (e.kind === "saved" && e.model === "Message" && e.record) {
    append({ uuid: e.record.uuid, author: e.record.author, body: e.record.body });
    setConn(true);
  }
}, ctx);

$("sendForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("body").value.trim();
  if (!body) return;
  $("body").value = "";
  const msg = messages.createInstance({ room: "general", author: $("author").value || me, body });
  myUuids.add(msg.uuid);
  messages.save(msg);
  await messages.persist(); // the echo from the change feed renders it
});

// Initial history (subscribe first, then load, so nothing is missed; `seen` dedupes any overlap).
try {
  const history = await messages.all().sort("createdAt").list();
  for (const m of history) append(m);
  setConn(true);
} catch {
  setConn(false);
}

function setConn(ok) {
  const c = $("conn");
  c.classList.toggle("ok", ok);
  c.innerHTML = `<span class="dot"></span> ${ok ? "live over WebSocket" : "disconnected"}`;
}

function randomName() {
  const a = ["Swift", "Calm", "Bright", "Bold", "Lucky", "Quiet", "Brave", "Wise"];
  const n = ["Otter", "Finch", "Maple", "Comet", "Willow", "Fox", "Heron", "Pebble"];
  return `${pick(a)} ${pick(n)}`;
}
function pick(xs) {
  return xs[Math.floor(Math.random() * xs.length)];
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
