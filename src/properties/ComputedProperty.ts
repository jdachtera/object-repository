/**
 * Computed / virtual properties (roadmap "Computed / virtual fields").
 *
 * A field derived from an instance's other (already-decoded) fields by a pure JS function, computed
 * eagerly on every full read and at `createInstance` — never stored, never validated, never sent to
 * a backend. Because its `kind` is `"computed"` (not `"scalar"`), it is automatically excluded from
 * column/DDL/index derivation, and `Repository.serialize` skips it, so it never crosses the Backend
 * seam. That makes it the safest kind of feature w.r.t. the golden rule: no backend can diverge on a
 * value no backend ever sees.
 *
 * The `R` type parameter (the computed runtime type) appears only covariantly — the compute return
 * and a phantom `__runtime` field — so `ComputedProperty<any>` is a valid upper bound for the
 * `AnyProperty` union and `InferModel` recovers `R` via `infer R`.
 */
export class ComputedProperty<R = unknown> {
  readonly kind = "computed" as const;
  declare readonly __runtime: R;

  constructor(readonly compute: (row: Record<string, unknown>) => R) {}
}
