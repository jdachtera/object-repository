/**
 * High-volume statistics over the wire — why aggregate push-down matters.
 *
 * The server holds a large event table in SQLite. A client ("browser") asks the same analytics
 * questions two ways, and a metering transport counts exactly what crosses the network:
 *
 *   1. push-down  — `groupBy(...sum...)` compiles to a server-side SQL `GROUP BY`; only the handful
 *                   of summary rows travel back.
 *   2. naive      — fetch every row and reduce in the "browser"; the whole table crosses the wire.
 *
 * Same typed query language, same result — but the push-down moves kilobytes where the naive path
 * moves megabytes. That's the §11 "no silent O(n) cliff": the heavy lifting stays next to the data.
 *
 *   npm run build && node examples/stats-aggregation.ts
 *   N=200000 node examples/stats-aggregation.ts      # bigger table, starker contrast
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RepositoryManager,
  text,
  integer,
  date,
  field,
  year,
  type Context,
  type Transport,
  type WireRequest,
  type WireResponse
} from "../dist/index.js";
import { SQLiteBackend } from "../dist/backends/sqlite/index.js";
import { BackendAdapter, createRequestListener, RemoteBackend, HttpTransport } from "../dist/transport/index.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function defineEvents(orm: RepositoryManager) {
  return orm.define({
    name: "Event",
    properties: { country: text({ index: true }), amount: integer(), ts: date() }
  });
}

// A transport decorator that counts bytes and rows flowing back from the server.
class MeteredTransport implements Transport {
  bytes = 0;
  rows = 0;
  requests = 0;
  private readonly inner: Transport;
  constructor(inner: Transport) {
    this.inner = inner;
  }
  async request(op: WireRequest, ctx: Context): Promise<WireResponse> {
    const response = await this.inner.request(op, ctx);
    this.requests++;
    this.bytes += JSON.stringify(response.result ?? null).length;
    if (Array.isArray(response.result)) this.rows += response.result.length;
    return response;
  }
  reset() {
    this.bytes = this.rows = this.requests = 0;
  }
}

const COUNTRIES = ["US", "DE", "FR", "GB", "JP", "BR"];

// Tiny deterministic PRNG so the numbers are stable run to run.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

async function main() {
  const N = Number(process.env.N ?? 50_000);

  // ── Server: a SQLite store, seeded directly (the data already lives server-side) ──────────────
  const serverStore = new SQLiteBackend(new DatabaseSync(":memory:"));
  const serverManager = new RepositoryManager({ backend: serverStore });
  const seedRepo = defineEvents(serverManager);

  const rand = lcg(42);
  for (let i = 0; i < N; i++) {
    const country = COUNTRIES[Math.floor(rand() * COUNTRIES.length)]!;
    const amount = 1 + Math.floor(rand() * 1000);
    const yr = 2022 + Math.floor(rand() * 3);
    seedRepo.save(seedRepo.createInstance({ country, amount, ts: new Date(Date.UTC(yr, Math.floor(rand() * 12), 1)) }));
  }
  await seedRepo.persist();

  const server: Server = createServer(createRequestListener(new BackendAdapter(serverStore)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log(`High-volume stats over HTTP — server holds ${N.toLocaleString()} events in SQLite.\n`);

  try {
    // ── Client: same model, store is remote, every byte metered ─────────────────────────────────
    const meter = new MeteredTransport(new HttpTransport(url));
    const client = new RepositoryManager({ backend: new RemoteBackend(meter, serverStore.capabilities) });
    const events = defineEvents(client);

    // 1) PUSH-DOWN: groupBy → server-side SQL GROUP BY, only summary rows come back
    meter.reset();
    const t1 = Date.now();
    const byCountry = (await events.all().groupBy("country", (a) => ({ n: a.count(), revenue: a.sum("amount") })))
      .sort((a, b) => b.revenue - a.revenue);
    const pushdown = { ms: Date.now() - t1, bytes: meter.bytes, rows: meter.rows };

    // a couple more push-down queries: overall stats, and a computed time-bucket (year of ts)
    const totals = await events.all().aggregate((a) => ({ n: a.count(), revenue: a.sum("amount"), avg: a.avg("amount") }));
    const byYear = (await events.all().groupByExpr(year(field("ts")), (a) => ({ n: a.count(), revenue: a.sum("amount") })))
      .sort((a, b) => Number(a.key) - Number(b.key));

    // 2) NAIVE: fetch every row, reduce in the "browser"
    meter.reset();
    const t2 = Date.now();
    const allRows = await events.all().list();
    const naiveByCountry = new Map<string, { n: number; revenue: number }>();
    for (const e of allRows) {
      const g = naiveByCountry.get(e.country) ?? { n: 0, revenue: 0 };
      g.n++;
      g.revenue += e.amount;
      naiveByCountry.set(e.country, g);
    }
    const naive = { ms: Date.now() - t2, bytes: meter.bytes, rows: meter.rows };

    // Same answer both ways?
    const agree = byCountry.every((g) => naiveByCountry.get(String(g.key))?.revenue === g.revenue);

    console.log("Revenue by country (computed server-side via GROUP BY):");
    for (const g of byCountry) console.log(`  ${g.key}   ${g.n.toString().padStart(7)} events   $${g.revenue.toLocaleString()}`);
    console.log(`\nOverall: ${totals.n.toLocaleString()} events, $${totals.revenue.toLocaleString()} revenue, avg $${totals.avg.toFixed(2)}`);
    console.log(`By year: ${byYear.map((g) => `${g.key}:$${g.revenue.toLocaleString()}`).join("   ")}`);

    console.log("\nWhat actually crossed the network:");
    console.log(`  push-down (groupBy):  ${pushdown.rows.toString().padStart(7)} rows   ${kb(pushdown.bytes).padStart(9)}   ${pushdown.ms} ms`);
    console.log(`  naive (fetch + reduce):${naive.rows.toString().padStart(7)} rows   ${kb(naive.bytes).padStart(9)}   ${naive.ms} ms`);
    console.log(`  → push-down moved ${ratio(naive.bytes, pushdown.bytes)}× less data for the identical result (match: ${agree}).`);
    console.log("\n✓ same typed query, run remotely — the aggregation stays next to the data, not in the client.");
  } finally {
    server.close();
  }
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const ratio = (a: number, b: number) => (b === 0 ? "∞" : Math.round(a / b).toLocaleString());

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
