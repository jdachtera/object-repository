/**
 * Relation properties (ARCHITECTURE.md §6).
 *
 * Unlike scalars, relations carry no validator — they are ORM metadata: the target model name
 * (resolved via the RepositoryManager registry at load/save time, so mutual relations have no
 * definition-order problem), the inverse property name for back-reference maintenance, and a
 * lazy flag.
 *
 * The `M` type parameter is the related model's instance type, supplied explicitly by the caller
 * (cross-model inference would require a global type registry). A phantom `__model` field keeps
 * `M` structurally present so `InferModel` can recover it via `infer M`.
 */
/**
 * How a relation is physically stored — the aggregate boundary (ARCHITECTURE.md §6):
 *  - `reference` (default): store uuid(s) and resolve the shared entity by lookup/join/stitch.
 *  - `embed`: store the owned child/children inline as nested documents (composition); reads need
 *    no lookup and the child's lifecycle is tied to the parent. Use only for owned data, never for
 *    shared entities (which would create update anomalies).
 */
export type RelationStorage = "embed" | "reference";

export interface RelationConfig {
  /** Target model name, resolved to a repository at load/save time. */
  model: string;
  /** Inverse property on the related model, kept in sync on save (back-reference maintenance). */
  remoteProperty?: string;
  /** Physical storage strategy; defaults to `reference`. */
  storage?: RelationStorage;
  /** Defer loading until explicitly requested (not yet honoured — relations load eagerly). */
  lazy?: boolean;
}

export class RelationToOneProperty<M = unknown> {
  readonly kind = "relationToOne" as const;
  readonly targetModel: string;
  readonly remoteProperty: string | undefined;
  readonly storage: RelationStorage;
  readonly lazy: boolean;
  declare readonly __model: M;

  constructor(config: RelationConfig) {
    this.targetModel = config.model;
    this.remoteProperty = config.remoteProperty;
    this.storage = config.storage ?? "reference";
    this.lazy = config.lazy ?? false;
  }
}

export class RelationToManyProperty<M = unknown> {
  readonly kind = "relationToMany" as const;
  readonly targetModel: string;
  readonly remoteProperty: string | undefined;
  readonly storage: RelationStorage;
  readonly lazy: boolean;
  declare readonly __model: M;

  constructor(config: RelationConfig) {
    this.targetModel = config.model;
    this.remoteProperty = config.remoteProperty;
    this.storage = config.storage ?? "reference";
    this.lazy = config.lazy ?? false;
  }
}
