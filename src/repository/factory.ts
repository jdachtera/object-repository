import type { Repository } from "./Repository.ts";
import type { InferModel, PropertyMap } from "../properties/infer.ts";

/**
 * Model factories for seeding dev/test data (roadmap "Seeding / fixtures / factories").
 *
 * A thin, dependency-free wrapper over a `Repository`: it assembles a plain overrides object and
 * hands it to the repository's existing public methods (`createInstance` / `save` / `persist`), so
 * factory output is identical to hand-written code by construction — uuid minting, validation,
 * property defaults, timestamps, codecs, and the inverse-relation cascade all run exactly once,
 * in the repository, on every backend. The factory never encodes, validates, or mints ids itself.
 */

/** Context passed to a field producer — `seq` is a 0-based counter, monotonic over the factory's life. */
export interface BuildContext {
  readonly seq: number;
}

/** A factory field value: a literal, or a producer called per build with the `BuildContext`. */
export type FactoryField<T> = T | ((ctx: BuildContext) => T);

/** Per-field overrides/defaults — each field is a literal or a producer. */
export type FactoryInput<M> = { [K in keyof M]?: FactoryField<M[K]> };

export interface FactoryOptions<M> {
  /** Baseline field values, layered under any per-build overrides. */
  defaults?: FactoryInput<M>;
  /** Hook run after `createInstance`, before `save` — for wiring that needs the built instance. */
  onBuild?: (instance: M, ctx: BuildContext) => void;
}

export interface Factory<M> {
  /** Build a validated, uuid-stamped instance without persisting it. */
  build(overrides?: FactoryInput<M>): M;
  /** Build `count` instances (a function override is called per index). */
  buildMany(count: number, overrides?: FactoryInput<M> | ((index: number) => FactoryInput<M>)): M[];
  /** Build and persist one instance (one `persist()` flush). */
  create(overrides?: FactoryInput<M>): Promise<M>;
  /** Build and persist `count` instances in a single `persist()` flush. */
  createMany(count: number, overrides?: FactoryInput<M> | ((index: number) => FactoryInput<M>)): Promise<M[]>;
  /** Restart the `seq` counter at 0. */
  reset(): void;
}

/** True for a per-instance producer function (mirrors `ScalarProperty.makeDefault`'s value-vs-factory rule). */
function isProducer<T>(value: FactoryField<T>): value is (ctx: BuildContext) => T {
  return typeof value === "function";
}

function resolveInput<M>(input: FactoryInput<M> | undefined, ctx: BuildContext): Partial<M> {
  const out: Partial<M> = {};
  if (!input) return out;
  for (const key of Object.keys(input) as Array<keyof M>) {
    const field = input[key] as FactoryField<M[keyof M]> | undefined;
    if (field === undefined) continue;
    out[key] = isProducer(field) ? field(ctx) : field;
  }
  return out;
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Factory count must be a non-negative integer, got ${JSON.stringify(count)}`);
  }
}

/**
 * Bind a factory to a repository — `const users = defineFactory(userRepo, { defaults: { name: sequence(n => `u${n}`) } })`.
 * Producers see a 0-based `seq` and can return related instances (persisted via the repository's own
 * inverse-relation cascade when the relation declares a `remoteProperty`).
 */
export function defineFactory<P extends PropertyMap>(
  repository: Repository<P>,
  options: FactoryOptions<InferModel<P>> = {}
): Factory<InferModel<P>> {
  type M = InferModel<P>;
  let seq = 0;

  const build = (overrides?: FactoryInput<M>): M => {
    const ctx: BuildContext = { seq: seq++ };
    const data = { ...resolveInput(options.defaults, ctx), ...resolveInput(overrides, ctx) };
    const instance = repository.createInstance(data as Partial<M>);
    options.onBuild?.(instance, ctx);
    return instance;
  };

  const overridesAt = (
    overrides: FactoryInput<M> | ((index: number) => FactoryInput<M>) | undefined,
    index: number
  ): FactoryInput<M> | undefined => (typeof overrides === "function" ? overrides(index) : overrides);

  const buildMany: Factory<M>["buildMany"] = (count, overrides) => {
    assertCount(count);
    return Array.from({ length: count }, (_, i) => build(overridesAt(overrides, i)));
  };

  return {
    build,
    buildMany,
    async create(overrides) {
      const instance = build(overrides);
      repository.save(instance);
      await repository.persist();
      return instance;
    },
    async createMany(count, overrides) {
      const instances = buildMany(count, overrides);
      for (const instance of instances) repository.save(instance);
      if (instances.length) await repository.persist();
      return instances;
    },
    reset() {
      seq = 0;
    }
  };
}

/**
 * A monotonic sequence generator, for unique-ish factory values —
 * `email: sequence(n => `user${n}@example.com`)`. Its counter is independent of a factory's `seq`
 * (and of `reset()`), so values stay unique across separate `create()` calls and can be shared
 * between factories. With no mapper it yields the raw incrementing number.
 */
export function sequence<T = number>(fn?: (n: number) => T, start = 1): () => T {
  let n = start;
  return () => (fn ? fn(n++) : (n++ as unknown as T));
}
