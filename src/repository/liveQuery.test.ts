/**
 * The reactive query primitive: `liveQuery(collection)` re-runs after every committed change to the
 * model and pushes a fresh snapshot, and `QueryCollection.subscribe` is the imperative sugar over it.
 * Backed by the in-memory reference (the change feed drives it identically on every backend).
 */
import { describe, it, expect, vi } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { liveQuery } from "./liveQuery.js";
import { text, integer, relationToOne } from "../properties/factories.js";
import { gt, eq } from "../expressions/index.js";

const setup = () => {
  const orm = new RepositoryManager({ backend: new InMemoryBackend() });
  const todos = orm.define({ name: "Todo", properties: { title: text(), priority: integer() } });
  return { orm, todos };
};

/** Wait until `predicate()` holds (polls microtasks) — the store updates on an async run resolving. */
const until = async (predicate: () => boolean, tries = 50) => {
  for (let i = 0; i < tries && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
};

describe("liveQuery", () => {
  it("loads once on first subscribe, then re-runs after a write", async () => {
    const { todos } = setup();
    todos.save(todos.createInstance({ title: "a", priority: 1 }));
    await todos.persist();

    const live = liveQuery(todos.all().sort("title"));
    // Lazy: nothing runs until subscribed, and the initial snapshot is the loading state.
    expect(live.getSnapshot()).toEqual({ data: undefined, error: undefined, loading: true });

    const onChange = vi.fn();
    const unsubscribe = live.subscribe(onChange);

    await until(() => live.getSnapshot().data !== undefined);
    expect(live.getSnapshot().loading).toBe(false);
    expect(live.getSnapshot().data!.map((t) => t.title)).toEqual(["a"]);
    const loadedCalls = onChange.mock.calls.length;

    // A write to the model wakes the live query; it re-reads and pushes the new rows.
    todos.save(todos.createInstance({ title: "b", priority: 2 }));
    await todos.persist();
    await until(() => (live.getSnapshot().data?.length ?? 0) === 2);
    expect(live.getSnapshot().data!.map((t) => t.title)).toEqual(["a", "b"]);
    expect(onChange.mock.calls.length).toBeGreaterThan(loadedCalls);

    unsubscribe();
  });

  it("getSnapshot returns a stable reference between changes (useSyncExternalStore contract)", async () => {
    const { todos } = setup();
    const live = liveQuery(todos.all());
    live.subscribe(() => {});
    await until(() => live.getSnapshot().data !== undefined);
    const a = live.getSnapshot();
    const b = live.getSnapshot();
    expect(a).toBe(b); // same object identity when nothing changed
  });

  it("stops re-running after the last unsubscribe", async () => {
    const { todos } = setup();
    const live = liveQuery(todos.all());
    const unsubscribe = live.subscribe(() => {});
    await until(() => live.getSnapshot().data !== undefined);
    unsubscribe();

    const onChange = vi.fn();
    // No active subscribers → a write must not notify anyone.
    todos.save(todos.createInstance({ title: "x", priority: 9 }));
    await todos.persist();
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    // And the store reset to a clean loading state for the next consumer.
    expect(live.getSnapshot()).toEqual({ data: undefined, error: undefined, loading: true });
  });

  it("supports a custom runner (a live count) and reflects writes", async () => {
    const { todos } = setup();
    const live = liveQuery(todos.all().filter(gt("priority", 1)), (c) => c.count());
    live.subscribe(() => {});
    await until(() => live.getSnapshot().data !== undefined);
    expect(live.getSnapshot().data).toBe(0);

    todos.save(todos.createInstance({ title: "hi", priority: 5 }));
    todos.save(todos.createInstance({ title: "lo", priority: 1 })); // filtered out
    await todos.persist();
    await until(() => live.getSnapshot().data === 1);
  });

  it("captures a run error in the snapshot without throwing", async () => {
    const { todos } = setup();
    const boom = new Error("boom");
    const live = liveQuery(todos.all(), () => Promise.reject(boom));
    live.subscribe(() => {});
    await until(() => live.getSnapshot().error !== undefined);
    expect(live.getSnapshot().error).toBe(boom);
    expect(live.getSnapshot().loading).toBe(false);
  });

  it("does NOT re-run on a write to a row outside its filter", async () => {
    const { todos } = setup();
    todos.save(todos.createInstance({ uuid: "hi", title: "hi", priority: 10 }));
    await todos.persist();

    const live = liveQuery(todos.all().filter(gt("priority", 5)).sort("title"));
    const onChange = vi.fn();
    live.subscribe(onChange);
    await until(() => live.getSnapshot().data !== undefined);
    const afterLoad = onChange.mock.calls.length;
    expect(live.getSnapshot().data!.map((t) => t.title)).toEqual(["hi"]);

    // A low-priority row is outside the filter before and after → the query cannot be affected.
    todos.save(todos.createInstance({ uuid: "lo", title: "lo", priority: 1 }));
    await todos.persist();
    for (let i = 0; i < 10; i++) await Promise.resolve(); // let any stray re-run settle
    expect(onChange.mock.calls.length).toBe(afterLoad); // no extra run
    expect(live.getSnapshot().data!.map((t) => t.title)).toEqual(["hi"]); // unchanged
  });

  it("re-runs when a matching row is added", async () => {
    const { todos } = setup();
    const live = liveQuery(todos.all().filter(gt("priority", 5)));
    live.subscribe(() => {});
    await until(() => live.getSnapshot().data !== undefined);
    expect(live.getSnapshot().data!.length).toBe(0);

    todos.save(todos.createInstance({ title: "big", priority: 9 }));
    await todos.persist();
    await until(() => live.getSnapshot().data?.length === 1);
  });

  it("re-runs when a row LEAVES the filter (old state matched)", async () => {
    const { todos } = setup();
    const t = todos.createInstance({ uuid: "x", title: "x", priority: 10 });
    todos.save(t);
    await todos.persist();

    const live = liveQuery(todos.all().filter(gt("priority", 5)));
    live.subscribe(() => {});
    await until(() => live.getSnapshot().data?.length === 1);

    // Drop it below the threshold: new record no longer matches, but the OLD one did → must re-run.
    t.priority = 1;
    todos.save(t);
    await todos.persist();
    await until(() => live.getSnapshot().data?.length === 0);
  });

  it("re-runs when a row ENTERS the filter (new state matches)", async () => {
    const { todos } = setup();
    const t = todos.createInstance({ uuid: "x", title: "x", priority: 1 });
    todos.save(t);
    await todos.persist();

    const live = liveQuery(todos.all().filter(gt("priority", 5)));
    live.subscribe(() => {});
    await until(() => live.getSnapshot().data !== undefined);
    expect(live.getSnapshot().data!.length).toBe(0);

    t.priority = 20;
    todos.save(t);
    await todos.persist();
    await until(() => live.getSnapshot().data?.length === 1);
  });

  it("re-runs when a REFERENCED relation target changes (cross-model)", async () => {
    const orm = new RepositoryManager({ backend: new InMemoryBackend() });
    const customers = orm.define({ name: "Customer", properties: { name: text(), country: text() } });
    const orders = orm.define({
      name: "Order",
      properties: { ref: text(), customer: relationToOne<{ uuid: string; name: string; country: string }>({ model: "Customer" }) }
    });

    const ada = customers.createInstance({ name: "Ada", country: "GB" });
    customers.save(ada);
    await customers.persist();
    orders.save(orders.createInstance({ ref: "o1", customer: ada }));
    await orders.persist();

    // "orders whose customer is in DE" — Ada is GB, so empty to start.
    const live = liveQuery(orders.all().filter(eq("customer.country", "DE")));
    live.subscribe(() => {});
    await until(() => live.getSnapshot().data !== undefined);
    expect(live.getSnapshot().data!.length).toBe(0);

    // Move Ada to DE — a change to the CUSTOMER model must wake the ORDERS live query.
    ada.country = "DE";
    customers.save(ada);
    await customers.persist();
    await until(() => (live.getSnapshot().data?.length ?? 0) === 1);
    expect((live.getSnapshot().data![0] as { ref: string }).ref).toBe("o1");
  });

  it("QueryCollection.subscribe streams rows imperatively", async () => {
    const { todos } = setup();
    const seen: string[][] = [];
    const unsubscribe = todos.all().sort("title").subscribe((rows) => seen.push(rows.map((t) => t.title)));

    await until(() => seen.length >= 1);
    expect(seen[0]).toEqual([]);

    todos.save(todos.createInstance({ title: "z", priority: 1 }));
    await todos.persist();
    await until(() => seen.some((s) => s.includes("z")));
    unsubscribe();
  });
});
