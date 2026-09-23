/**
 * The live-database suites skip when no server is reachable, so they stay runnable on a laptop. In CI
 * that same skip would turn "the server never came up" into a green run, so CI sets
 * `REQUIRE_LIVE_DBS=1` and an unreachable server fails the suite instead.
 */
export function requireLiveDb(error: unknown): void {
  if (process.env.REQUIRE_LIVE_DBS) throw error;
}
