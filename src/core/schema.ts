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
  | { compatible: false; code: "SCHEMA_TOO_OLD" | "SCHEMA_TOO_NEW" | "SCHEMA_MISMATCH"; message: string };

/**
 * Can a client running `client` talk to a server running `server`?
 *
 * The version rule is the mirror of the local gate: the server serves any client from its declared
 * floor up to its own version. Below the floor the client is asking for a shape the server has already
 * destroyed; above it, the client expects fields the server has not deployed yet — which means the
 * rollout ran in the wrong order, since the server must lead.
 */
export function checkSchemaCompatibility(client: SchemaAdvertisement, server: SchemaAdvertisement): SchemaCompatibility {
  const clientVersion = client.schemaVersion;
  const serverVersion = server.schemaVersion;

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
    // Deliberately not comparing fingerprints here: differing shapes are the *point* of a window.
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
