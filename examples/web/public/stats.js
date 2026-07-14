// Live-stats demo. The browser talks to a server-side SQLite store through a RemoteBackend over
// HttpTransport. `groupBy` pushes down to a server `GROUP BY` (one `aggregate` request, summary rows
// back); a metering transport shows exactly how much that saves over fetching the whole table.
import { RepositoryManager, text, integer, date, gt, field, year } from "/dist/index.js";
import { RemoteBackend, HttpTransport } from "/dist/transport/index.js";

// SQLite-ish capabilities (the server applies the plan regardless; push-down for aggregate/count is
// chosen by method presence on RemoteBackend, not these flags).
const CAPS = { indexes: true, ranges: true, sortPushdown: true, joins: false, transactions: true, changeFeed: true };

// Count bytes/rows coming back from the server.
class Meter {
  constructor(inner) {
    this.inner = inner;
    this.reset();
  }
  reset() {
    this.bytes = 0;
    this.rows = 0;
  }
  async request(op, ctx) {
    const res = await this.inner.request(op, ctx);
    this.bytes += JSON.stringify(res.result ?? null).length;
    if (Array.isArray(res.result)) this.rows += res.result.length;
    return res;
  }
}

const meter = new Meter(new HttpTransport(location.origin, { rpcPath: "/api/orm/rpc", changesPath: "/api/orm/changes" }));
const orm = new RepositoryManager({ backend: new RemoteBackend(meter, CAPS) });
const events = orm.define({ name: "Event", properties: { country: text({ index: true }), amount: integer(), ts: date() } });

const $ = (id) => document.getElementById(id);
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;

let lastQuery = null; // re-used by the naive comparison so it filters the same set

async function refresh() {
  const dim = $("dim").value;
  const min = Number($("minAmount").value);
  $("minLabel").textContent = `$${min}`;
  lastQuery = { dim, min };

  const scope = events.all().filter(gt("amount", min - 1)); // >= min
  meter.reset();
  const t = performance.now();
  const groups =
    dim === "country"
      ? (await scope.groupBy("country", (a) => ({ n: a.count(), revenue: a.sum("amount") }))).map((g) => ({ key: g.key, ...g }))
      : await scope.groupByExpr(year(field("ts")), (a) => ({ n: a.count(), revenue: a.sum("amount") }));
  const ms = Math.round(performance.now() - t);

  groups.sort((a, b) => (dim === "year" ? Number(a.key) - Number(b.key) : b.revenue - a.revenue));
  $("chartTitle").textContent = dim === "country" ? "Revenue by country" : "Revenue by release year";
  drawChart(groups);

  $("pdRows").textContent = `${meter.rows} rows`;
  $("pdBytes").textContent = kb(meter.bytes);
  $("pdMs").textContent = `${ms} ms`;

  meter.reset();
  const totals = await scope.aggregate((a) => ({ n: a.count(), revenue: a.sum("amount"), avg: a.avg("amount") }));
  $("totals").innerHTML =
    `<b>${totals.n.toLocaleString()}</b> events · <b>$${Math.round(totals.revenue).toLocaleString()}</b> revenue · ` +
    `avg <b>$${totals.avg.toFixed(2)}</b>`;
}

function drawChart(groups) {
  const max = Math.max(1, ...groups.map((g) => g.revenue));
  $("chart").innerHTML = groups
    .map((g) => {
      const pct = (g.revenue / max) * 100;
      return `<div class="bar-row">
        <span class="bar-label">${g.key}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-val">$${Math.round(g.revenue).toLocaleString()}<small> · ${g.n.toLocaleString()}</small></span>
      </div>`;
    })
    .join("");
}

async function runNaive() {
  if (!lastQuery) return;
  meter.reset();
  const t = performance.now();
  const rows = await events.all().filter(gt("amount", lastQuery.min - 1)).list(); // the whole filtered table
  const ms = Math.round(performance.now() - t);

  $("nvRows").textContent = `${rows.length.toLocaleString()} rows`;
  $("nvBytes").textContent = kb(meter.bytes);
  $("nvMs").textContent = `${ms} ms`;

  const pdBytes = Number($("pdBytes").textContent.replace(/[^\d.]/g, "")) * 1024 || 1;
  const ratio = Math.round(meter.bytes / pdBytes).toLocaleString();
  $("ratio").innerHTML = `push-down moved <b>${ratio}×</b> less data for the identical result.`;
}

$("dim").addEventListener("change", refresh);
$("minAmount").addEventListener("input", refresh);
$("naiveBtn").addEventListener("click", runNaive);

try {
  const { count, backend } = await fetch("/api/orm/info").then((r) => r.json());
  const name =
    { sqlite: "SQLite", memory: "in-memory", mongo: "MongoDB", "mongo-memory": "MongoDB (ephemeral)", postgres: "PostgreSQL", mysql: "MySQL" }[
      backend
    ] ?? backend;
  $("datasetSub").textContent = `querying ${count.toLocaleString()} events in a server-side ${name} store through a RemoteBackend`;
} catch {
  /* ignore */
}
await refresh();
