/**
 * Headless-browser verification for the web demos. Boots the demo server on a private port, drives
 * all three flows in a real Chromium, and exits non-zero on any failed assertion.
 *
 *   npm run demo:web:verify
 *
 * Needs `playwright-core` (a devDependency) and a Chromium build. It uses the preinstalled browser
 * (PLAYWRIGHT_BROWSERS_PATH, e.g. /opt/pw-browsers) — set PW_CHROMIUM_PATH to override, or leave it
 * unset to let playwright-core resolve its own. No browser download.
 */
import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 8099);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

function findChromium() {
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith("chromium")) continue;
      for (const exe of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux/headless_shell"]) {
        const p = join(root, dir, exe);
        if (existsSync(p)) return p;
      }
    }
  } catch {
    /* fall through to playwright's own resolution */
  }
  return undefined;
}

async function waitForServer(timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/orm/info`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error("server did not start in time");
    await sleep(150);
  }
}

const server = spawn("node", ["examples/web/server.mjs"], {
  env: { ...process.env, PORT: String(PORT), N: process.env.N ?? "20000" },
  stdio: ["ignore", "ignore", "inherit"]
});

const executablePath = findChromium();
let browser;
try {
  await waitForServer();
  const info = await fetch(`${BASE}/api/orm/info`).then((r) => r.json()).catch(() => ({}));
  console.log(`server store: ${info.backend ?? "?"}  (${(info.count ?? 0).toLocaleString()} events)\n`);
  browser = await chromium.launch(executablePath ? { executablePath } : {});

  // ── Offline sync ───────────────────────────────────────────────────────────────────────────
  console.log("Offline sync (/sync.html)");
  await fetch(`${BASE}/api/sync/reset`, { method: "POST" });
  const tasksOf = (p) =>
    p.$$eval("#list .item", (els) => els.map((e) => ({ title: e.querySelector(".text").value, done: e.querySelector('input[type=checkbox]').checked })));
  const cloudTitles = (p) => p.$$eval("#cloud .item .text", (els) => els.map((e) => e.textContent));
  const outbox = (p) => p.$eval("#outboxPill", (e) => e.textContent);

  const A = await (await browser.newContext()).newPage();
  await A.goto(`${BASE}/sync.html?device=A`);
  await A.evaluate(() => indexedDB.deleteDatabase("tasks-A"));
  await A.reload();
  await sleep(400);

  await A.fill("#title", "Write the docs");
  await A.press("#title", "Enter");
  await sleep(1800);
  check("A: task reached the server", (await cloudTitles(A)).includes("Write the docs"));
  check("A: outbox drained after sync", (await outbox(A)).includes("0"));

  await A.click(".slider"); // offline
  await A.fill("#title", "Offline idea");
  await A.press("#title", "Enter");
  await sleep(300);
  check("A: offline write queued, not on server", !(await outbox(A)).includes("0") && !(await cloudTitles(A)).includes("Offline idea"));
  await A.click(".slider"); // online
  await sleep(1800);
  check("A: outbox flushed on reconnect", (await outbox(A)).includes("0") && (await cloudTitles(A)).includes("Offline idea"));

  const B = await (await browser.newContext()).newPage();
  await B.goto(`${BASE}/sync.html?device=B`);
  await B.evaluate(() => indexedDB.deleteDatabase("tasks-B"));
  await B.reload();
  await sleep(2000);
  check("B: converges to the server's tasks", (await tasksOf(B)).some((t) => t.title === "Write the docs"));

  // conflict: both edit the same task offline; later HLC stamp wins everywhere
  await A.click(".slider");
  await B.click(".slider");
  await sleep(150);
  const edit = async (p, v) => {
    const h = await p.$("#list .item .text");
    await h.fill(v);
    await h.press("Enter");
  };
  await edit(A, "AAA wins?");
  await sleep(60);
  await edit(B, "BBB wins?");
  await sleep(250);
  await A.click(".slider");
  await B.click(".slider");
  await sleep(2600);
  const aFirst = (await tasksOf(A))[0]?.title;
  const bFirst = (await tasksOf(B))[0]?.title;
  check("conflict: both replicas + server agree on one winner", aFirst === bFirst && (await cloudTitles(A)).includes(aFirst), `("${aFirst}")`);

  // ── Live stats ─────────────────────────────────────────────────────────────────────────────
  console.log("Live stats (/stats.html)");
  const s = await (await browser.newContext()).newPage();
  const sErr = [];
  s.on("pageerror", (e) => sErr.push(String(e)));
  await s.goto(`${BASE}/stats.html`);
  await sleep(1500);
  check("stats: one bar per country (6)", (await s.$$eval("#chart .bar-row", (e) => e.length)) === 6);
  check("stats: push-down returned only group rows", (await s.$eval("#pdRows", (e) => e.textContent)).trim().startsWith("6"));
  await s.click("#naiveBtn");
  await sleep(1500);
  check("stats: naive path pulled the whole table", /\d/.test(await s.$eval("#nvRows", (e) => e.textContent)));
  check("stats: ratio shows push-down moved far less data", /×/.test(await s.$eval("#ratio", (e) => e.textContent)), `(${(await s.$eval("#ratio", (e) => e.textContent)).trim()})`);
  await s.selectOption("#dim", "year");
  await sleep(1200);
  check("stats: group-by-year re-queries (3 years)", (await s.$$eval("#chart .bar-row", (e) => e.length)) === 3);
  check("stats: no page errors", sErr.length === 0, sErr[0] ?? "");

  // ── Realtime chat over WebSocket ─────────────────────────────────────────────────────────────
  console.log("Realtime chat (/chat.html)");
  const C1 = await (await browser.newContext()).newPage();
  const C2 = await (await browser.newContext()).newPage();
  const cErr = [];
  C1.on("pageerror", (e) => cErr.push("C1 " + e));
  C2.on("pageerror", (e) => cErr.push("C2 " + e));
  await C1.goto(`${BASE}/chat.html`);
  await C2.goto(`${BASE}/chat.html`);
  await sleep(1200);
  check("chat: client connected over WebSocket", await C1.$eval("#conn", (e) => e.className.includes("ok")));
  await C1.fill("#author", "Alice");
  await C1.fill("#body", "hello over websocket");
  await C1.click("#sendForm button");
  await sleep(900);
  check("chat: other client received it live", (await C2.$$eval(".msg .bubble", (els) => els.map((e) => e.textContent))).includes("hello over websocket"));
  check("chat: no page errors", cErr.length === 0, cErr[0] ?? "");
} catch (e) {
  console.error(e);
  fail++;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(fail ? 1 : 0);
