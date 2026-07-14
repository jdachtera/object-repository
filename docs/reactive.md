# Reactive queries & framework binding

Any query can be made **live** — it re-runs and pushes fresh results after every committed change to its
model (a local write, or one arriving over the change feed: cascades, remote writes, sync). The core
ships one small, framework-agnostic primitive; the per-framework hooks below are ~5 lines each and stay
**out of the package**, so `object-repository` never depends on `react` / `solid-js`.

## The primitive

```ts
import { liveQuery } from "object-repository";

const live = liveQuery(todos.all().filter(eq("done", false)).sort("createdAt"));

const unsubscribe = live.subscribe(() => {
  const { data, error, loading } = live.getSnapshot();
  render(data ?? []);
});
// later: unsubscribe()
```

- **Lazy + ref-counted:** the query runs (and the change feed is subscribed) on the first `subscribe`,
  and stops on the last unsubscribe.
- **`getSnapshot()`** returns a referentially-stable `{ data, error, loading }` — exactly what React's
  `useSyncExternalStore` needs. `data` is `undefined` until the first load; a background re-run keeps the
  prior `data` (stale-while-revalidate) until it resolves.
- **`run` is pluggable** — `liveQuery(coll)` reads `coll.list()`; pass a runner for anything else:
  `liveQuery(coll, c => c.count())`, `liveQuery(coll, c => c.page({ limit: 20 }))`, a `groupBy`, etc.
- **`refetch()`** forces a run now (pull-to-refresh), independent of the feed.

For quick imperative use there's sugar on the query itself:

```ts
const unsubscribe = todos.all().subscribe(
  (rows) => render(rows),
  (err) => showError(err)
);
```

> Granularity: a live query re-runs only when a change can actually affect it — the changed record is
> tested against the query's own filter (using the in-memory reference `match`), and the query re-runs
> iff the record matches **before or after** the write. So a write to a row outside your filter (a
> different `status`, a different `userId`) never wakes the query, and a row that crosses into or out of
> the filter does. **Relation filters are tracked too**: a query on `orders` filtered by
> `customer.country` also re-runs when a *customer* changes (one relation hop). Remaining coarseness: an
> unfiltered query (`all()`) re-runs on every write to its model; a query with a relation filter re-runs
> on any change to *either* model (the own-model half falls back to conservative because a relation path
> can't be matched against a raw stored row); and only one relation hop is followed
> (`order.customer.region.name` tracks `customer`, not `region`).

## Optimistic writes

There is no separate "optimistic update" API — optimism falls out of **where the write lands**. A live
query reads from a store; if the write hits that same store synchronously, the UI reflects it before any
server round-trip.

**Local-first (optimistic by construction).** With a local backend, or a `SyncBackend` wrapping one, a
write commits locally and fires its change event synchronously, so live queries re-run *immediately* —
then sync reconciles with the server in the background:

```ts
// A local store is the source of truth for the UI; sync catches up in the background.
const backend = new SyncBackend({ local: new IndexedDBBackend(), remote: syncTarget, nodeId: "device-1" });
const orm = new RepositoryManager({ backend });

todos.save(todos.createInstance({ title: "buy milk", done: false }));
await todos.persist();     // lands locally + wakes live queries NOW; the server sees it later
```

If the server later disagrees, reconciliation is **last-write-wins** (per-record, or per-field with
`new SyncBackend({ fieldLevel: true })`): the converged value flows back as another change event and the
live query re-renders. The write isn't "rolled back" so much as *merged* — which is what you want for
ordinary CRUD, where a write rarely fails so much as races another.

**Remote-only (confirmation, not optimism).** A bare `RemoteBackend` has no local store, so `persist()`
round-trips to the server before the change event fires — the UI updates on confirmation. To make it
optimistic, put a local store in front: `SyncBackend`, or `multiWriteBackend({ primary: localStore,
secondaries: [remote] })` so reads/liveness come from the fast local primary.

**What you don't get.** This is not Replicache-style **mutation rebase** — there's no automatic "apply
optimistically, then revert-and-replay if the server rejects the mutation." The model is CRDT-ish LWW
convergence, not rebased mutators. Two consequences worth knowing:

- A failed `persist()` (e.g. a validation or unique-constraint throw) does **not** revert the mutated
  in-memory instance — it stays changed in the identity map. Re-read it (`repo.get(uuid)`) to snap back
  to stored state, or don't mutate the live instance in place until the write succeeds.
- For domains that genuinely need transactional rollback of a speculative change (inventory, balances),
  gate the optimistic display yourself and reconcile on the confirmed change event, rather than relying
  on LWW to "undo" it.

## React — `useQuery`

`useSyncExternalStore` binds directly to the primitive; no extra state, StrictMode- and SSR-safe:

```tsx
import { useMemo, useSyncExternalStore } from "react";
import { liveQuery, type QueryCollection } from "object-repository";

export function useQuery<T>(makeQuery: () => QueryCollection<T>, deps: unknown[] = []) {
  // Rebuild the live query only when deps change; the query builder itself is cheap + immutable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const live = useMemo(() => liveQuery(makeQuery()), deps);
  return useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
}

// usage
function TodoList() {
  const { data, loading } = useQuery(() => todos.all().where({ done: false }).sort("createdAt"), []);
  if (loading && !data) return <Spinner />;
  return <ul>{data!.map((t) => <li key={t.uuid}>{t.title}</li>)}</ul>;
}
```

The third `useSyncExternalStore` arg (`getServerSnapshot`) reuses `getSnapshot`, which returns the
loading state on the server — render a skeleton and hydrate on the client.

## Solid — `createQuery`

Solid's `from` adapts the same `subscribe` into a signal:

```tsx
import { from, type Accessor } from "solid-js";
import { liveQuery, type QueryCollection, type LiveState } from "object-repository";

export function createQuery<T>(collection: QueryCollection<T>): Accessor<LiveState<T[]> | undefined> {
  const live = liveQuery(collection);
  return from((set) => {
    set(live.getSnapshot());
    return live.subscribe(() => set(live.getSnapshot()));
  });
}

// usage
function TodoList() {
  const state = createQuery(todos.all().where({ done: false }).sort("createdAt"));
  return (
    <Show when={state()?.data} fallback={<Spinner />}>
      {(rows) => <For each={rows()}>{(t) => <li>{t.title}</li>}</For>}
    </Show>
  );
}
```

For a query whose filter comes from reactive state, rebuild it inside a `createMemo` keyed on that state
(the same shape as React's `deps`), so a new `liveQuery` is created when the inputs change.

## Vue / Svelte

Both fit the same shape:

- **Vue:** `shallowRef(live.getSnapshot())` + `onScopeDispose(live.subscribe(() => ref.value = live.getSnapshot()))`.
- **Svelte:** a readable store — `readable(live.getSnapshot(), (set) => live.subscribe(() => set(live.getSnapshot())))`.

The rule is always the same: subscribe on mount, read `getSnapshot()`, unsubscribe on teardown.
