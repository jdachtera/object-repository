/**
 * Multi-backend demo — the ORM's headline claim, made runnable.
 *
 * One model. One block of query/write code. Run it against four different stores — an in-memory
 * map, embedded SQLite (`node:sqlite`), browser IndexedDB (`fake-indexeddb` in Node), and (if you
 * point `MONGO_URL` at a mongod) real MongoDB — and get byte-for-byte identical results. Filters,
 * sort/paging, aggregate + groupBy push-down, computed and array patches, upsert, and auto
 * timestamps all behave the same, because every store is the same `Backend` contract underneath.
 *
 *   npm run build        # the demo imports the compiled package, like a real consumer would
 *   node examples/multi-backend.ts
 *   MONGO_URL=mongodb://localhost:27017 node examples/multi-backend.ts   # add a real Mongo pass
 *
 * (Node 22.18+ strips the TypeScript types on the fly, so there is no separate compile step for
 * the example itself.)
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  RepositoryManager,
  InMemoryBackend,
  text,
  integer,
  array,
  date,
  eq,
  gt,
  startsWith,
  size,
  field,
  mul,
  year,
  op,
  type Backend,
  type RepositoryManagerOptions
} from "../dist/index.js";
import { SQLiteBackend } from "../dist/backends/sqlite/index.js";
import { IndexedDBBackend } from "../dist/backends/indexeddb/index.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// ── The model: defined once, reused for every backend ──────────────────────────────────────────
function defineLibrary(options: RepositoryManagerOptions) {
  const orm = new RepositoryManager(options);
  return orm.define({
    name: "Song",
    timestamps: true, // auto createdAt (first save) + updatedAt (every save/patch)
    properties: {
      title: text({ unique: true }),
      artist: text(),
      level: text(), // beginner | intermediate | advanced
      plays: integer(),
      score: integer(), // filled in later by a computed patch
      tags: array<string>(),
      released: date()
    },
    // compound index: per artist, most-played first (built natively where the backend supports it)
    indexes: [{ name: "by_artist_plays", fields: ["artist", { path: "plays", descending: true }] }]
  });
}

const SEED = [
  { title: "Für Elise", artist: "Beethoven", level: "intermediate", plays: 320, tags: ["piano"], year: 2021 },
  { title: "Clair de Lune", artist: "Debussy", level: "advanced", plays: 150, tags: ["piano", "calm"], year: 2021 },
  { title: "Chopsticks", artist: "Trad", level: "beginner", plays: 90, tags: [], year: 2022 },
  { title: "Canon in D", artist: "Pachelbel", level: "intermediate", plays: 210, tags: ["wedding"], year: 2022 },
  { title: "Gymnopédie", artist: "Satie", level: "beginner", plays: 60, tags: [], year: 2023 },
  { title: "Prelude in C", artist: "Bach", level: "advanced", plays: 175, tags: ["classical"], year: 2023 }
];

// ── The scenario: identical code, whatever backend it's handed ──────────────────────────────────
async function runScenario(options: RepositoryManagerOptions) {
  const songs = defineLibrary(options);

  for (const s of SEED) {
    songs.save(songs.createInstance({ ...s, score: 0, released: new Date(Date.UTC(s.year, 0, 1)) }));
  }
  await songs.persist();

  // filter + sort + paging (push down where supported): the two most-played, descending
  const topTwo = (await songs.all().filter(gt("plays", 100)).sort("plays", true).slice(0, 2).list()).map((x) => x.title);

  // portable text search + array-size + the new filter ops
  const titleC = (await songs.all().filter(startsWith("title", "C")).sort("title").list()).map((x) => x.title);
  const untagged = (await songs.all().filter(size("tags", 0)).sort("title").list()).map((x) => x.title);

  // aggregate push-down (SQL GROUP BY / Mongo $group / in-memory reduce)
  const stats = await songs.all().aggregate((a) => ({ n: a.count(), plays: a.sum("plays"), avg: a.avg("plays") }));

  // group by a stored key, and by a computed expression (release year bucket)
  const byLevel = (await songs.all().groupBy("level", (a) => ({ n: a.count(), plays: a.sum("plays") })))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map((g) => ({ level: g.key, n: g.n, plays: g.plays }));
  const byYear = (await songs.all().groupByExpr(year(field("released")), (a) => ({ n: a.count() })))
    .sort((a, b) => Number(a.key) - Number(b.key))
    .map((g) => ({ year: g.key, n: g.n }));

  // computed write, server-side: score = plays * 2, evaluated from the pre-patch row
  const fur = (await songs.all().filter(eq("title", "Für Elise")).list())[0]!;
  await songs.patch(fur.uuid, { score: op.set(mul(field("plays"), 2)) });
  // array write: append a tag (addToSet would skip dupes; push always appends)
  await songs.patch(fur.uuid, { tags: op.push("favorite") });

  // upsert by key: update an existing row, then insert a brand-new one
  await songs.upsert(eq("title", "Canon in D"), { set: { plays: 211 } });
  await songs.upsert(eq("title", "New Arrangement"), {
    set: { plays: 5 },
    setOnInsert: { title: "New Arrangement", artist: "You", level: "beginner", score: 0, tags: ["wip"], released: new Date(Date.UTC(2024, 0, 1)) }
  });

  // final reads: the computed/array writes landed, the upserts took, timestamps are real Dates
  const furFinal = (await songs.all().filter(eq("title", "Für Elise")).list())[0]!;
  const canon = (await songs.all().filter(eq("title", "Canon in D")).list())[0]!;

  return {
    topTwo,
    titleC,
    untagged,
    stats: { n: stats.n, plays: stats.plays, avg: Math.round(stats.avg * 100) / 100 },
    byLevel,
    byYear,
    furScore: furFinal.score,
    furTags: furFinal.tags,
    canonPlays: canon.plays,
    total: await songs.all().count(),
    timestampsAreDates: furFinal.createdAt instanceof Date && furFinal.updatedAt instanceof Date,
    updatedAfterCreated: furFinal.updatedAt!.getTime() >= furFinal.createdAt!.getTime()
  };
}

// ── Drive it across every available backend and check they agree ────────────────────────────────
type Pass = { label: string; make: () => Backend | Promise<Backend>; cleanup?: () => Promise<void> };

async function main() {
  let idb = 0;
  const passes: Pass[] = [
    { label: "in-memory", make: () => new InMemoryBackend() },
    { label: "SQLite (node:sqlite)", make: () => new SQLiteBackend(new DatabaseSync(":memory:")) },
    {
      label: "IndexedDB (fake-indexeddb)",
      make: () => new IndexedDBBackend({ factory: new IDBFactory(), keyRange: IDBKeyRange, name: `demo-${idb++}` })
    }
  ];

  // Optional real-Mongo pass — only if MONGO_URL is set and the driver is installed.
  if (process.env.MONGO_URL) {
    try {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(process.env.MONGO_URL);
      await client.connect();
      const { MongoBackend } = await import("../dist/index.js");
      passes.push({
        label: "MongoDB (live)",
        make: () => new MongoBackend(client.db(`demo_${Date.now()}`) as never),
        cleanup: () => client.close()
      });
    } catch (e) {
      console.log(`(skipping Mongo pass: ${(e as Error).message})\n`);
    }
  }

  const results: Array<{ label: string; result: Awaited<ReturnType<typeof runScenario>> }> = [];
  for (const pass of passes) {
    const result = await runScenario({ backend: await pass.make() });
    await pass.cleanup?.();
    results.push({ label: pass.label, result });
  }

  const ref = results[0]!;
  const refJson = JSON.stringify(ref.result);

  console.log("Same model + query code, run against each backend:\n");
  console.log(render(ref.result));
  console.log("\nDo all backends agree?");
  let allAgree = true;
  for (const { label, result } of results) {
    const agrees = JSON.stringify(result) === refJson;
    allAgree &&= agrees;
    console.log(`  ${agrees ? "✓" : "✗"} ${label}${agrees ? "" : "  ← DIVERGED"}`);
    if (!agrees) console.log(diff(ref.result, result));
  }

  console.log(allAgree ? "\n✓ identical results everywhere — one query language, every store." : "\n✗ backends diverged (see above).");
  if (!allAgree) process.exitCode = 1;
}

function render(r: Awaited<ReturnType<typeof runScenario>>): string {
  return [
    `  top 2 by plays:        ${r.topTwo.join(", ")}`,
    `  titles starting "C":   ${r.titleC.join(", ")}`,
    `  untagged songs:        ${r.untagged.join(", ")}`,
    `  aggregate:             n=${r.stats.n}  plays=${r.stats.plays}  avg=${r.stats.avg}`,
    `  by level:              ${r.byLevel.map((g) => `${g.level}(${g.n}/${g.plays})`).join("  ")}`,
    `  by release year:       ${r.byYear.map((g) => `${g.year}:${g.n}`).join("  ")}`,
    `  computed score (×2):   Für Elise → ${r.furScore}`,
    `  array push:            Für Elise tags → [${r.furTags.join(", ")}]`,
    `  upsert update:         Canon in D plays → ${r.canonPlays}`,
    `  total after upsert:    ${r.total} songs (6 seeded + 1 inserted)`,
    `  timestamps:            dates=${r.timestampsAreDates}  updated≥created=${r.updatedAfterCreated}`
  ].join("\n");
}

function diff(a: object, b: object): string {
  return `      expected ${JSON.stringify(a)}\n      got      ${JSON.stringify(b)}`;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
