import type { JsonObject, Uuid } from "../core/types.ts";

/**
 * Per-repository cache (ARCHITECTURE.md §7).
 *
 * Three roles:
 *  - **identity map** (`uuid → instance`) so the same record always hydrates to the same object
 *    reference — query results are stable and mutations are shared.
 *  - **query-result cache** (`plan hash → instances`) to skip re-querying unchanged plans.
 *  - **write baseline** (`uuid → last-known-persisted encoded record`) so `save()` can diff a
 *    mutated instance against the backend's last-confirmed state and pass only the changed fields
 *    through (dirty / field-level change tracking — ARCHITECTURE.md §12).
 *
 * Invalidation is coarse and correct: the owning repository clears results when the backend's
 * change feed reports a write to its model. Incremental result patching is a later optimization.
 */
export class QueryCache<T> {
  private readonly instances = new Map<Uuid, T>();
  private readonly results = new Map<string, T[]>();
  private readonly baseline = new Map<Uuid, JsonObject>();

  getInstance(uuid: Uuid): T | undefined {
    return this.instances.get(uuid);
  }
  setInstance(uuid: Uuid, instance: T): void {
    this.instances.set(uuid, instance);
  }
  deleteInstance(uuid: Uuid): void {
    this.instances.delete(uuid);
  }

  getResult(hash: string): T[] | undefined {
    const cached = this.results.get(hash);
    return cached ? cached.slice() : undefined;
  }
  setResult(hash: string, items: T[]): void {
    this.results.set(hash, items.slice());
  }
  invalidateResults(): void {
    this.results.clear();
  }

  getBaseline(uuid: Uuid): JsonObject | undefined {
    return this.baseline.get(uuid);
  }
  setBaseline(uuid: Uuid, record: JsonObject): void {
    this.baseline.set(uuid, { ...record });
  }
  deleteBaseline(uuid: Uuid): void {
    this.baseline.delete(uuid);
  }
}
