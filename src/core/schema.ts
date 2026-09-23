/**
 * Deciding whether two ends of a connection can talk to each other (ARCHITECTURE.md §4, §10, §13).
 *
 * The wire is intentionally untyped, so the contract between client and server is the model
 * definitions. Comparing a fingerprint of those definitions catches drift — but *equality* is the
 * wrong test once schema versions exist, because an expand/contract window is **defined by** the two
 * ends differing. Refusing every difference would refuse precisely the deploys the version gate exists
 * to make safe.
 *
 * So: when both ends advertise a schema version, compatibility is judged by range and the fingerprint
 * becomes advisory. When either end doesn't, the fingerprint is all there is and equality still rules.
 * That keeps the check exactly as strict as it was for anyone not using versions.
 */
import type { SchemaVersioning } from "./types.ts";

/** What one end of a connection says about its schema. */
export interface SchemaAdvertisement extends Partial<SchemaVersioning> {
  /** Hash of the wire-relevant model shapes (`RepositoryManager.fingerprint()`). */
  fingerprint?: string;
}

export type SchemaCompatibility =
  | { compatible: true; basis: "version" | "fingerprint" | "unchecked" }
  | { compatible: false; code: SchemaRefusalCode; message: string };

export type SchemaRefusalCode = "SCHEMA_TOO_OLD" | "SCHEMA_TOO_NEW" | "SCHEMA_MISMATCH" | "SCHEMA_INVALID";

/** Is `code` one of the handshake's refusals (as opposed to a transport or authorization error)? */
export function isSchemaRefusal(code: unknown): code is SchemaRefusalCode {
  return code === "SCHEMA_TOO_OLD" || code === "SCHEMA_TOO_NEW" || code === "SCHEMA_MISMATCH" || code === "SCHEMA_INVALID";
}

/**
 * Can a client running `client` talk to a server running `server`?
 *
 * The version rule is the mirror of the local gate: the server serves any client from its declared
 * floor up to its own version. Below the floor the client is asking for a shape the server has already
 * destroyed; above it, the client expects fields the server has not deployed yet — which means the
 * rollout ran in the wrong order, since the server must lead.
 */
export function checkSchemaCompatibility(client: SchemaAdvertisement, server: SchemaAdvertisement): SchemaCompatibility {
  // A version that isn't a whole number — an unset environment variable read through `Number()` is
  // NaN — would compare false against everything and so pass every range check. Refuse it instead.
  for (const [side, advertisement] of [["server", server], ["client", client]] as const) {
    for (const key of ["schemaVersion", "minSupportedSchemaVersion"] as const) {
      const value = advertisement[key];
      if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
        return {
          compatible: false,
          code: "SCHEMA_INVALID",
          message: `The ${side} advertises ${key} ${JSON.stringify(value)}, which is not a non-negative integer.`
        };
      }
    }
  }

  const serverVersion = server.schemaVersion;
  // Once the server is versioned, a client that states no version predates versioning: version 0.
  // Served while the floor allows it, and refused — not waved through — once the floor rises.
  const clientVersion = serverVersion === undefined ? client.schemaVersion : (client.schemaVersion ?? 0);

  if (clientVersion !== undefined && serverVersion !== undefined) {
    const floor = server.minSupportedSchemaVersion ?? Math.max(0, serverVersion - 1);
    if (clientVersion < floor) {
      return {
        compatible: false,
        code: "SCHEMA_TOO_OLD",
        message: `This client speaks schema version ${clientVersion}, but the server no longer supports anything below ${floor}. Upgrade the client.`
      };
    }
    if (clientVersion > serverVersion) {
      return {
        compatible: false,
        code: "SCHEMA_TOO_NEW",
        message: `This client speaks schema version ${clientVersion}, but the server is only at ${serverVersion}. Deploy the server before the client.`
      };
    }
    // Across versions, differing shapes are the *point* of a window. At the same version they are
    // drift: someone changed the models without bumping the version.
    if (clientVersion === serverVersion && client.fingerprint !== undefined && server.fingerprint !== undefined && client.fingerprint !== server.fingerprint) {
      return {
        compatible: false,
        code: "SCHEMA_MISMATCH",
        message: `Client and server both declare schema version ${serverVersion} but their models differ (${client.fingerprint} vs ${server.fingerprint}). Bump the version with the change.`
      };
    }
    return { compatible: true, basis: "version" };
  }

  if (client.fingerprint !== undefined && server.fingerprint !== undefined) {
    if (client.fingerprint !== server.fingerprint) {
      return {
        compatible: false,
        code: "SCHEMA_MISMATCH",
        message: `Client schema ${client.fingerprint} does not match server schema ${server.fingerprint}. Declare \`schema\` on both ends to allow a compatibility window instead.`
      };
    }
    return { compatible: true, basis: "fingerprint" };
  }

  // One side advertises nothing at all — there is nothing to compare, which is the pre-existing
  // behaviour for a server constructed without a fingerprint.
  return { compatible: true, basis: "unchecked" };
}

/**
 * The per-request gate a server applies once it declares a schema version: the handshake is a courtesy
 * that lets a client fail early, but it is this that actually protects the server. Every request
 * carries the client's advertisement, so a redeploy that raises the floor refuses a stale client on its
 * very next request, and a client that never shook hands is judged all the same.
 */
export function enforceSchema(client: SchemaAdvertisement | undefined, server: SchemaAdvertisement): SchemaCompatibility | null {
  if (server.schemaVersion === undefined) return null; // an unversioned server keeps the advisory check
  const verdict = checkSchemaCompatibility(client ?? {}, server);
  return verdict.compatible ? null : verdict;
}
