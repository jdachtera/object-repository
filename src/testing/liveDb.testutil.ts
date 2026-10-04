/**
 * The live-database suites skip when no server is reachable, so they stay runnable on a laptop. In CI
 * that same skip would turn "the server never came up" into a green run, so CI sets
 * `REQUIRE_LIVE_DBS=1` and an unreachable server fails the suite instead.
 */
export function requireLiveDb(error: unknown): void {
  if (process.env.REQUIRE_LIVE_DBS) throw error;
}

/**
 * Hold the live databases exclusively for one test file. The live suites share one database per engine
 * and the library's reserved tables (the migration journal, the lease), and vitest runs files in
 * parallel — so one file dropping the journal while another is migrating is a flake, not a finding.
 * Acquired in a fixed order (Postgres, then MySQL), so two files can never deadlock on each other.
 * Returns the release; an engine that isn't reachable is simply not locked.
 */
export async function exclusiveLiveDbs(pgUrl: string, mysqlUrl: string): Promise<() => Promise<void>> {
  const releases: Array<() => Promise<void>> = [];
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 2000 });
    await client.connect();
    await client.query("SELECT pg_advisory_lock(7331)");
    releases.push(async () => {
      await client.query("SELECT pg_advisory_unlock(7331)").catch(() => {});
      await client.end().catch(() => {});
    });
  } catch {
    // unreachable: nothing to share
  }
  try {
    const { createConnection } = await import("mysql2/promise");
    const connection = await createConnection({ uri: mysqlUrl, connectTimeout: 2000 });
    await connection.query("SELECT GET_LOCK('object_repository_tests', 600)");
    releases.push(async () => {
      await connection.query("SELECT RELEASE_LOCK('object_repository_tests')").catch(() => {});
      await connection.end().catch(() => {});
    });
  } catch {
    // unreachable: nothing to share
  }
  return async () => {
    for (const release of releases.reverse()) await release();
  };
}
