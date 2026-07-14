import type { JsonObject, JsonValue } from "../core/types.ts";

/**
 * Read a (optionally dotted) property path out of a record. Dotted paths let an expression
 * reach into nested JSON; cross-repository relation paths are rewritten earlier by the
 * Repository's preprocessing (ARCHITECTURE.md §6), so here a dotted path is plain object access.
 */
export function getPath(record: JsonObject, path: string): JsonValue | undefined {
  if (!path.includes(".")) {
    return record[path];
  }
  let current: JsonValue | undefined = record;
  for (const key of path.split(".")) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as JsonObject)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
