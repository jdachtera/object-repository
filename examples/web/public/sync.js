// Frontend of the offline-sync demo. Plain ES modules — the browser imports the compiled ORM from
// its per-subpath entries under /dist/. Each "device" is a separate IndexedDB store wrapped in a
// SyncBackend that reconciles with the server through the HttpSyncTarget below.
import { RepositoryManager, text, boolean, all, SYSTEM_CONTEXT } from "/dist/index.js";
import { IndexedDBBackend } from "/dist/backends/indexeddb/index.js";
import { SyncBackend } from "/dist/sync/index.js";

const ctx = SYSTEM_CONTEXT;

// The remote end of sync, spoken over a tiny JSON API. Flipping `online` simulates losing the network:
// writes still land locally (offline-first), they just can't reconcile until we're back.
class HttpSyncTarget {
  constructor() {
    this.online = true;
  }
  async pull(cursor) {
    if (!this.online) throw new Error("offline");
    return post("/api/sync/pull", { cursor });
  }
  async push(changes) {
    if (!this.online) throw new Error("offline");
    return post("/api/sync/push", { changes });
  }
}
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// ── Wiring: device → local IndexedDB → SyncBackend → server ──────────────────────────────────────
const device = (new URLSearchParams(location.search).get("device") || "A").toUpperCase();
if (device !== "A") document.body.classList.add("device-b");
const dbName = `tasks-${device}`;

const local = new IndexedDBBackend({ name: dbName });
const remote = new HttpSyncTarget();
const sync = new SyncBackend({ local, remote, nodeId: `device-${device}` });
const orm = new RepositoryManager({ backend: sync });
const tasks = orm.define({ name: "Task", timestamps: true, properties: { title: text(), done: boolean() } });

const byId = new Map(); // uuid → live instance, so toggles/edits mutate the tracked object

// ── DOM ──────────────────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
$("deviceChip").textContent = `Device ${device}`;
$("localName").textContent = `(IndexedDB: ${dbName})`;

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("title");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  tasks.save(tasks.createInstance({ title, done: false }));
  await tasks.persist();
  await renderLocal();
  void doSync(false);
});

$("list").addEventListener("change", async (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  const t = byId.get(e.target.closest(".item").dataset.uuid);
  t.done = e.target.checked;
  tasks.save(t);
  await tasks.persist();
  await renderLocal();
  void doSync(false);
});

$("list").addEventListener("click", async (e) => {
  if (!e.target.matches(".x")) return;
  const t = byId.get(e.target.closest(".item").dataset.uuid);
  tasks.remove(t);
  await tasks.persist();
  await renderLocal();
  void doSync(false);
});

$("list").addEventListener("keydown", async (e) => {
  if (!e.target.matches(".text") || e.key !== "Enter") return;
  e.preventDefault();
  e.target.blur();
});
$("list").addEventListener(
  "blur",
  async (e) => {
    if (!e.target.matches(".text")) return;
    const t = byId.get(e.target.closest(".item").dataset.uuid);
    const next = e.target.value.trim();
    if (!next || next === t.title) return;
    t.title = next;
    tasks.save(t);
    await tasks.persist();
    await renderLocal();
    void doSync(false);
  },
  true
);

$("onlineToggle").addEventListener("change", (e) => {
  remote.online = e.target.checked;
  $("onlineLabel").textContent = remote.online ? "Online" : "Offline";
  logLine(remote.online ? "back online" : "went offline", remote.online ? "ok" : "warn");
  if (remote.online) void doSync(true);
});

$("syncBtn").addEventListener("click", () => doSync(true));

$("deviceBBtn").addEventListener("click", () => {
  const other = device === "A" ? "B" : "A";
  $("deviceBBtn").textContent = `Open Device ${other} ↗`;
  window.open(`${location.pathname}?device=${other}`, "_blank");
});

$("resetBtn").addEventListener("click", async () => {
  if (!confirm("Wipe the server changelog and this device's local store?")) return;
  await post("/api/sync/reset", {});
  indexedDB.deleteDatabase(dbName);
  location.reload();
});

// ── Render ─────────────────────────────────────────────────────────────────────────────────────
async function renderLocal() {
  const rows = await tasks.all().sort("createdAt").list();
  byId.clear();
  for (const r of rows) byId.set(r.uuid, r);

  const list = $("list");
  list.innerHTML = rows.length ? "" : '<li class="empty">No tasks yet — add one above.</li>';
  for (const t of rows) {
    const li = document.createElement("li");
    li.className = "item" + (t.done ? " done" : "");
    li.dataset.uuid = t.uuid;
    li.innerHTML = `
      <input type="checkbox" ${t.done ? "checked" : ""} />
      <input class="text" value="${escapeAttr(t.title)}" />
      <button class="x" title="delete">×</button>`;
    list.appendChild(li);
  }

  const outbox = await local.query({ model: "_outbox", where: all().serialize(), order: [], paging: { start: 0 } }, ctx);
  const pill = $("outboxPill");
  pill.textContent = `outbox: ${outbox.length}`;
  pill.classList.toggle("warn", outbox.length > 0);
  return outbox.length;
}

async function renderCloud() {
  try {
    const { records } = await fetch("/api/sync/state").then((r) => r.json());
    const cloud = $("cloud");
    cloud.innerHTML = records.length ? "" : '<li class="empty">Server has no tasks yet.</li>';
    for (const r of records.sort((a, b) => a.title.localeCompare(b.title))) {
      const li = document.createElement("li");
      li.className = "item" + (r.done ? " done" : "");
      li.innerHTML = `<span style="width:18px">${r.done ? "✓" : "•"}</span>
        <span class="text">${escapeHtml(r.title)}</span>
        <span class="ver">v:${String(r.version).slice(-6)}</span>`;
      cloud.appendChild(li);
    }
  } catch {
    /* server briefly unavailable — ignore */
  }
}

async function renderAll() {
  await renderLocal();
  await renderCloud();
}

// ── Sync loop ────────────────────────────────────────────────────────────────────────────────────
let syncing = false;
async function doSync(manual) {
  if (syncing) return;
  if (!remote.online) {
    if (manual) logLine("offline — cannot sync", "warn");
    return;
  }
  syncing = true;
  try {
    const before = await pendingCount();
    await sync.reconcile(ctx);
    const after = await pendingCount();
    $("lastSync").textContent = `synced ${new Date().toLocaleTimeString()}`;
    $("lastSync").classList.remove("muted");
    await renderAll();
    if (before > 0 || manual) logLine(`reconciled — pushed ${before - after >= 0 ? before - after : before}, outbox now ${after}`, "push");
  } catch (e) {
    logLine(`sync failed: ${e.message}`, "warn");
  } finally {
    syncing = false;
  }
}
const pendingCount = async () =>
  (await local.query({ model: "_outbox", where: all().serialize(), order: [], paging: { start: 0 } }, ctx)).length;

function logLine(text, cls = "") {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $("log").prepend(div);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// ── Go ─────────────────────────────────────────────────────────────────────────────────────────
await renderAll();
logLine(`device ${device} ready — local store "${dbName}"`, "ok");
void doSync(false);
setInterval(() => doSync(false), 1500);
