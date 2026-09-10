/**
 * Schema compatibility between two ends of a connection.
 *
 * The case that matters: an expand/contract window is *defined by* the two ends' model definitions
 * differing, so a fingerprint-equality check would refuse precisely the deploy the version gate exists
 * to make safe. Versions, when both sides declare them, are what let that difference be judged rather
 * than merely detected.
 */
import { describe, it, expect } from "vitest";
import { checkSchemaCompatibility } from "./schema.js";

describe("with versions on both ends", () => {
  const server = { schemaVersion: 7, minSupportedSchemaVersion: 5, fingerprint: "server-shape" };

  it("serves any client from the floor up to the server's own version", () => {
    for (const clientVersion of [5, 6, 7]) {
      expect(checkSchemaCompatibility({ schemaVersion: clientVersion }, server)).toEqual({
        compatible: true,
        basis: "version"
      });
    }
  });

  it("ignores a differing fingerprint, because that is the whole point of a window", () => {
    const verdict = checkSchemaCompatibility(
      { schemaVersion: 6, fingerprint: "client-shape-which-differs" },
      server
    );
    expect(verdict).toEqual({ compatible: true, basis: "version" });
  });

  it("refuses a client below the floor, telling it to upgrade", () => {
    const verdict = checkSchemaCompatibility({ schemaVersion: 4 }, server);
    expect(verdict).toMatchObject({ compatible: false, code: "SCHEMA_TOO_OLD" });
    expect((verdict as { message: string }).message).toContain("Upgrade the client");
  });

  it("refuses a client ahead of the server, naming the rollout order", () => {
    const verdict = checkSchemaCompatibility({ schemaVersion: 8 }, server);
    expect(verdict).toMatchObject({ compatible: false, code: "SCHEMA_TOO_NEW" });
    expect((verdict as { message: string }).message).toContain("Deploy the server before the client");
  });

  it("derives a floor of one version back when the server declares none", () => {
    const lenient = { schemaVersion: 7 };
    expect(checkSchemaCompatibility({ schemaVersion: 6 }, lenient)).toMatchObject({ compatible: true });
    expect(checkSchemaCompatibility({ schemaVersion: 5 }, lenient)).toMatchObject({ code: "SCHEMA_TOO_OLD" });
  });
});

describe("without versions, the fingerprint still rules", () => {
  it("accepts equal shapes", () => {
    expect(checkSchemaCompatibility({ fingerprint: "abc" }, { fingerprint: "abc" })).toEqual({
      compatible: true,
      basis: "fingerprint"
    });
  });

  it("refuses differing shapes, and points at the way to allow a window", () => {
    const verdict = checkSchemaCompatibility({ fingerprint: "abc" }, { fingerprint: "xyz" });
    expect(verdict).toMatchObject({ compatible: false, code: "SCHEMA_MISMATCH" });
    expect((verdict as { message: string }).message).toContain("Declare `schema` on both ends");
  });

  it("falls back to the fingerprint when only one end declares a version", () => {
    // One-sided versions can't be compared as a range, so this stays as strict as it was before.
    expect(checkSchemaCompatibility({ fingerprint: "abc", schemaVersion: 7 }, { fingerprint: "xyz" })).toMatchObject({
      code: "SCHEMA_MISMATCH"
    });
  });

  it("checks nothing when one end advertises nothing", () => {
    expect(checkSchemaCompatibility({ fingerprint: "abc" }, {})).toEqual({ compatible: true, basis: "unchecked" });
  });
});
