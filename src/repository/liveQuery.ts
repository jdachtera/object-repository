import type { QueryCollection } from "./QueryCollection.ts";

/**
 * A live query's current snapshot. `data` is `undefined` until the first run resolves; a later run
 * keeps the previous `data` in place (stale-while-revalidate) until it resolves. `getSnapshot()`
 * returns a *stable reference* between changes, which is exactly what React's `useSyncExternalStore`
 * needs to avoid render loops.
 */
export interface LiveState<R> {
  /** Latest resolved result, or `undefined` before the first load. */
  readonly data: R | undefined;
  /** Error from the most recent run, or `undefined` if it succeeded. */
  readonly error: unknown;
  /** `true` until the first run resolves (background re-runs keep the prior `data` and stay `false`). */
  readonly loading: boolean;
}

/**
 * A reactive handle over a query: `subscribe`/`getSnapshot` are shaped for framework binding (React's
 * `useSyncExternalStore(lq.subscribe, lq.getSnapshot)`; Solid's `from(set => lq.subscribe(() =>
 * set(lq.getSnapshot())))`). It is *lazy* and *ref-counted* — the query runs (and the change feed is
 * subscribed) on the first `subscribe`, and stops on the last unsubscribe.
 */
export interface LiveQuery<R> {
  /** The current, referentially-stable snapshot (changes identity only when data/error/loading change). */
  getSnapshot(): LiveState<R>;
  /** Register a change listener (called with no args on every snapshot change). Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Force a re-run now (e.g. pull-to-refresh), independent of the change feed. */
  refetch(): void;
}

/**
 * Turn a query into a live, self-refreshing result: it runs `run(collection)` once, then re-runs
 * automatically after every committed change to the query's model (a local write, or one arriving over
 * the change feed — cascades, remote/sync writes), pushing a fresh snapshot each time.
 *
 * Framework-agnostic by construction: the core exposes only this store; per-framework hooks are ~5-line
 * adapters over `subscribe`/`getSnapshot` and stay out of the package (no `react`/`solid-js` dependency).
 * See `docs/reactive.md`.
 *
 * @param collection the query to keep live (`repo.all().filter(...)`, etc.)
 * @param run how to read it — defaults to `c => c.list()`; pass `c => c.count()`, `c => c.page(...)`,
 *   a `groupBy`, or any read to make an aggregate/paged live query.
 *
 * Note: liveness follows the model's change feed, which is model-coarse today (any write to the model
 * re-runs the query). A query filtered to a subset still re-runs on an unrelated write to the same
 * model; it just re-reads and returns the same rows. Relation targets in another model don't trigger a
 * re-run yet.
 */
export function liveQuery<T, R = T[]>(
  collection: QueryCollection<T>,
  run: (c: QueryCollection<T>) => Promise<R> = (c) => c.list() as Promise<R>
): LiveQuery<R> {
  let state: LiveState<R> = { data: undefined, error: undefined, loading: true };
  const listeners = new Set<() => void>();
  let unsubscribeChanges: (() => void) | null = null;
  let runToken = 0; // guards against a slow earlier run resolving after a newer one

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const execute = () => {
    const token = ++runToken;
    run(collection).then(
      (data) => {
        if (token !== runToken) return; // superseded by a newer run
        state = { data, error: undefined, loading: false };
        notify();
      },
      (error) => {
        if (token !== runToken) return;
        state = { data: state.data, error, loading: false };
        notify();
      }
    );
  };

  return {
    getSnapshot: () => state,
    refetch: execute,
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) {
        // First subscriber: wire the change feed and kick off the initial run.
        unsubscribeChanges = collection.subscribeChanges(execute);
        execute();
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          unsubscribeChanges?.();
          unsubscribeChanges = null;
          // Reset so a later re-subscribe starts from a clean loading state and refetches.
          runToken++;
          state = { data: undefined, error: undefined, loading: true };
        }
      };
    }
  };
}
