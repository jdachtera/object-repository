/**
 * Aggregate push-down across the transport boundary (ARCHITECTURE.md §11). Without it, a remote
 * `groupBy`/`aggregate` would pull the whole table to the client and reduce there. With it, the
 * `aggregate` wire method makes the server reduce — natively when the store compiles `GROUP BY`
 * (SQLite), or with the shared reference reducer when it doesn't (in-memory) — and only the summary
 * rows cross the wire. Both server kinds must produce identical numbers, and the client must send an
 * `aggregate` request, not a full-table `query`.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { SQLiteBackend } from "../backends/sqlite/SQLiteBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { RemoteBackend } from "./RemoteBackend.js";
import { isAggregating } from "../core/Backend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { text, integer } from "../properties/factories.js";
import { gt } from "../expressions/builders.js";
import type { Backend } from "../core/Backend.js";
import type { Context } from "../core/types.js";
import type { Transport, WireRequest, WireResponse } from "../core/Transport.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// Records the wire methods that flow through, so a test can assert push-down vs. full fetch.
class SpyTransport implements Transport {
  readonly methods: string[] = [];
  private readonly inner: Transport;
  constructor(inner: Transport) {
    this.inner = inner;
  }
  request(op: WireRequest, ctx: Context): Promise<WireResponse> {
    this.methods.push(op.method);
    return this.inner.request(op, ctx);
  }
}

function remoteOver(serverStore: Backend): { spy: SpyTransport; remote: RemoteBackend; manager: RepositoryManager } {
  const spy = new SpyTransport(new InProcessTransport(new BackendAdapter(serverStore)));
  const remote = new RemoteBackend(spy, serverStore.capabilities);
  return { spy, remote, manager: new RepositoryManager({ backend: remote }) };
}

const SALES = [
  ["eu", 10],
  ["eu", 30],
  ["us", 100],
  ["us", 25],
  ["eu", 5]
] as const;

function runSuite(name: string, makeServer: () => Backend) {
  describe(`aggregate push-down over the transport (server: ${name})`, () => {
    it("reduces on the server and returns identical numbers to the reference", async () => {
      const { spy, remote, manager } = remoteOver(makeServer());
      const sales = manager.define({ name: "Sale", properties: { region: text(), amount: integer() } });
      for (const [region, amount] of SALES) sales.save(sales.createInstance({ region, amount }));
      await sales.persist();

      // a RemoteBackend is itself an AggregatingBackend, so the repository pushes the aggregate down
      expect(isAggregating(remote)).toBe(true);

      const totals = await sales.all().aggregate((a) => ({ n: a.count(), total: a.sum("amount"), avg: a.avg("amount") }));
      expect(totals).toEqual({ n: 5, total: 170, avg: 34 });

      const byRegion = (await sales.all().groupBy("region", (a) => ({ n: a.count(), total: a.sum("amount") })))
        .sort((x, y) => String(x.key).localeCompare(String(y.key)));
      expect(byRegion).toEqual([
        { key: "eu", n: 3, total: 45 },
        { key: "us", n: 2, total: 125 }
      ]);

      // a filtered aggregate still pushes down (the filter rides in the aggregate plan)
      const big = await sales.all().filter(gt("amount", 20)).aggregate((a) => ({ n: a.count() }));
      expect(big.n).toBe(3);

      // the client sent `aggregate` requests, never a full-table `query`
      expect(spy.methods).toContain("aggregate");
      expect(spy.methods.filter((m) => m === "query")).toHaveLength(0);
    });
  });
}

runSuite("SQLite (native GROUP BY)", () => new SQLiteBackend(new DatabaseSync(":memory:")));
runSuite("in-memory (reference reducer)", () => new InMemoryBackend());
