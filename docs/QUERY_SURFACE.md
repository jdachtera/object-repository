# Query surface — what the ORM covers, and what's still missing

A realism benchmark: a generic e-commerce schema (**6 collections** — products, customers, orders,
usage events, wishlists, sessions) that deliberately packs the awkward shapes a real MongoDB app throws
at an ORM — per-locale translated subdocuments, a discriminated-union payment method, arrays of objects,
scalar-array membership, and TTL / partial / unique / compound / text indexes — transcribed into this
ORM and replayed as tests.

- Models: [`src/fixtures/shop/models.ts`](../src/fixtures/shop/models.ts) — all 6 collections.
- Provisioning: [`provisioning.test.ts`](../src/fixtures/shop/provisioning.test.ts) — define + build tables/indexes on InMemory and SQLite.
- Query battery: [`surface.test.ts`](../src/fixtures/shop/surface.test.ts) — representative query/update/aggregation shapes, each labelled SUPPORTED or GAP. **The GAP tests are green** (they pin the current boundary), so implementing a feature flips its test — the file doubles as a TODO ledger.

## Bugs found and fixed during the port

1. **Index names with non-identifier characters crashed provisioning.** The compound index on
   `wishlistItems` is named `productId-customerId`; both SQL backends fed that straight into a bare SQL
   identifier and threw `Invalid SQL identifier`. Fixed by folding non-`[A-Za-z0-9_]` to `_`
   (`SqlBackend` + `SQLiteBackend`).
2. **`Date` filter comparands stopped matching** (a regression from the null/type-parity work). A
   `date()` field stores epoch-ms, but a filter like `{ createdAt: { $gte: new Date(...) } }` passed a
   `Date` object; the new type-exact comparison treats `number` vs `Date` as unordered → no match.
   Fixed by normalising a `Date` comparand to `.getTime()` at AST construction, so every backend and
   the reference compare the same numeric form. (`Date` was never a valid `JsonValue` in the AST
   anyway.)

## Supported — the app's bread-and-butter runs unchanged

Through the Mongo compat facade (`mongoCollection`) and native builders, verified cross-backend
(InMemory ⇄ SQLite) where it matters:

- **Filters:** equality, `$or`/`$and`/`$nor`, `$in`/`$nin`, `$ne`, `$gt/$gte/$lt/$lte`, `$exists`,
  `$size`, `$all`, `$elemMatch` (with a field sub-filter), `$not`, anchored literal `$regex` →
  prefix/suffix/substring text search, date ranges.
- **Writes:** `$set`, `$unset`, `$inc`, `$mul`, `$push`/`$addToSet` (incl. `$each`) on scalar arrays,
  `$pull` by value, `$pullAll`, `$pull` with `{ $in: [...] }`, `$currentDate` (session TTL keep-alive),
  upsert with `$setOnInsert`, `findOneAndUpdate` before/after semantics.
- **Aggregation:** `$match` → `$group` with `$sum`/`$avg`/`$min`/`$max`/`$count` (facade + native
  `groupBy`, which pushes down to SQL `GROUP BY`), plus `$sort`/`$skip`/`$limit`/`$count` pipeline
  stages — pushed down onto the query builder before a `$group`, applied in-memory over the grouped
  rows after one.
- **Pagination:** keyset/cursor (`page()`), skip/limit.
- **Schema:** unique / compound / TTL / partial / text index declarations; nested dotted index paths
  on SQLite; discriminated-union subdocuments modeled natively via `embedded()`.
- **Distinct counts** (`countDistinct` — the portable `$size` of `$addToSet`): unique-customers-per-
  bucket, the single most-used analytics reducer, now native and push-downable (`COUNT(DISTINCT)` on
  SQL, `$addToSet`+size on Mongo). Verified on live Postgres.
- **Timezone-aware date bucketing:** `dateToString`/`year`/`hour(…, "Europe/Berlin")` — DST-aware on
  the in-memory reference and Postgres/MySQL (which reduce date parts in memory) and pushed down
  natively on Mongo; SQLite rejects a zoned part loudly.
- **Ranking window functions** (`windowed({ partitionBy }, w => ({ r: w.rank() }))` — `rowNumber`/
  `rank`/`denseRank`): the "rank within a partition" / "is this the customer's first purchase" / top-N-
  per-group pattern. Reference + real `ROW_NUMBER()/RANK()/DENSE_RANK() OVER (PARTITION BY … ORDER BY …)`
  push-down (verified on live Postgres).

## Gaps — what's still missing (ranked by how much an analytics-heavy app leans on it)

### 1. Aggregation beyond `$match`/`$group` (the analytics surface) — biggest gap
The facade's `aggregate()` now handles `$match`, `$group`, and the windowing stages
`$sort`/`$skip`/`$limit`/`$count` (pushed down before a `$group`, applied in-memory after one);
everything else throws `Unsupported aggregate stage`. The reducer/expression gaps (distinct counts,
timezone date parts) are now closed natively — see the Supported list. What remains are the
document-reshaping and relational stages: `$lookup` (incl. `let`+`pipeline`+`$expr` self-joins),
`$facet`, `$unwind`, `$project`/`$addFields` stages, `$merge`, and a few expression operators
(`$toString`/`$toDouble`, `$indexOfArray`). Window functions (`$setWindowFields`+`$rank`) are native via
`windowed()`, though the Mongo *facade's* `aggregate()` doesn't map `$setWindowFields` onto it yet.
**Native path:** the ORM has `groupBy`/`groupByMany`/`select`/relations, but no join/facet/pipeline-
expression surface. This is the largest area a Mongo-heavy analytics app can't port as-is.

### 2. Implicit array-element semantics — CLOSED for equality ✅
Mongo's `{ tags: 'vip' }` matches a document whose `tags` **array contains** `'vip'`. Now handled: a
scalar `eq`/`!=` against a declared `array()` field is schema-rewritten to a membership (`contains`)
check in `preprocessWhere` (benefits native queries and the Mongo facade; scalar fields untouched, so
their equality still pushes down). Still open: `$in`/`$nin` against an array field (match if any element
is in the list) and array-value exact match.

### 3. Nested *filters* into a subdocument — CLOSED via `embedded()` ✅
A field declared `json()` is stored as an opaque string, so a dotted path can't traverse into it. The
`embedded()` property type stores the subdocument *natively* (like `array()`), so
`eq("paymentMethod.customerId", id)` and `eq("paymentMethod.details.status", "active")` traverse — in
memory (`getPath`), pushed down to a `jsonb` extraction on Postgres/MySQL (verified live), a
`json_extract` on SQLite, and a real subdocument on Mongo. `json()` remains for genuinely-opaque blobs.
**Still open:** dotted-path *updates* (`$set` into a nested key) and array-of-subdocs paths — see §4/§5.

### 4. Array-index and array-of-subdocs paths
`'items.0'` (ordinal into an array) and `'items.sku'` (a field across an array of subdocuments) don't
resolve — `getPath` won't index arrays by position or map over them.

### 5. Update operators the facade rejects
`$pullAll`, `$currentDate`, and `$pull` with a `{ $in: [...] }` condition are now supported (see the
Supported list). Still open: positional `$` updates and dot-path `$set` into nested docs. Also: an
upsert's **insert** path seeds only from equality + `$set` + `$setOnInsert`, so `$inc`/`$push` are
dropped on first insert (the stock-counter `{ $inc, $setOnInsert }` pattern).

### 6. `$push`/`$pull` on object-element arrays
The array patch ops only operate on a native `array()` column, which holds **scalars only**. Arrays of
objects (`orders.items`) must be `json()`, which the ops can't touch — attempting a `$push` corrupts the
blob. **Needs:** array patch ops over JSON arrays, or an object-array property type.

### 7. Filter operators not mapped
`$type` (polymorphic field discrimination, mixed `_id` types), `$mod`, non-literal/diacritic `$regex`
(char-class disjunction search), `$where`. These throw loudly (by design — the facade refuses to guess).

### 8. Runtime concerns outside the query language
- **TTL indexes** are declared (`ttlSeconds`) but nothing sweeps expired rows on the non-Mongo
  backends — sessions and any expiring token collection rely on TTL deletion for correctness.
- **Heterogeneous `_id` types** per collection — the ORM keys everything by a single string `uuid`;
  fine, but `_id`→`uuid` isn't mapped by the facade, so `{ _id: x }` filters don't hit the identity
  field (use `uuid`).
- **Transactions** need a transactional backend; the Mongo target isn't one, so interactive
  transactions aren't available there.
- Not chased (rare in this class of app): `distinct` at scale, change streams/`watch`, runtime `$text`,
  geo, collation, `hint()`, `$graphLookup`, `arrayFilters`.

## Takeaway

The **entity/CRUD + simple-aggregate surface ports cleanly** and runs identically across backends. The
distance to "drop-in for a Mongo app" is dominated by **(1) the rich aggregation pipeline** and, for
write-heavy correctness, **(3) queryable nested documents** and **(2) implicit array semantics**. Those
three are where to invest next; the rest are smaller, well-scoped operator additions tracked by the
green GAP tests.
