import type { AnyProperty, PropertyMap } from "./infer.ts";

/**
 * Schema fingerprinting (the transport type-safety mitigation, ARCHITECTURE.md §4, §10).
 *
 * The wire is intentionally untyped — the server is a generic AST executor — so the contract between
 * client and server is the *model definitions*. A fingerprint is a short, stable hash of the
 * wire-relevant shape of those definitions; comparing the two ends' fingerprints at connect time
 * turns silent schema drift into a clear error instead of mysterious runtime validation failures.
 */

/** The wire-relevant shape of one property (the parts that affect stored/serialized data). */
function propertyShape(property: AnyProperty): unknown {
  if (property.kind === "scalar") {
    return { kind: "scalar", type: property.type, unique: property.unique, index: property.index, length: property.length ?? null };
  }
  // Computed fields never cross the wire (not stored, not queryable), so they carry no wire-relevant
  // shape beyond their presence — a bare marker keeps drift detection stable without touching storage.
  if (property.kind === "computed") return { kind: "computed" };
  return { kind: property.kind, target: property.targetModel, storage: property.storage, remote: property.remoteProperty ?? null };
}

/**
 * A canonical, order-independent description of a set of models — stable across definition order and
 * property declaration order, so equal schemas always produce equal descriptors.
 */
export function schemaDescriptor(models: Record<string, PropertyMap>): Record<string, Record<string, unknown>> {
  const descriptor: Record<string, Record<string, unknown>> = {};
  for (const model of Object.keys(models).sort()) {
    const properties = models[model]!;
    const shape: Record<string, unknown> = {};
    for (const name of Object.keys(properties).sort()) shape[name] = propertyShape(properties[name] as AnyProperty);
    descriptor[model] = shape;
  }
  return descriptor;
}

/** A short hex fingerprint of a set of model definitions — equal iff their wire-relevant shapes match. */
export function schemaFingerprint(models: Record<string, PropertyMap>): string {
  return fnv1a(JSON.stringify(schemaDescriptor(models)));
}

/** Two FNV-1a passes (different seeds) → 16 hex chars; no crypto dependency, ample for drift detection. */
function fnv1a(input: string): string {
  const pass = (seed: number): number => {
    let hash = seed;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  };
  return pass(0x811c9dc5).toString(16).padStart(8, "0") + pass(0x01000193).toString(16).padStart(8, "0");
}
