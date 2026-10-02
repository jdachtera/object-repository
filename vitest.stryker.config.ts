import { defineConfig } from "vitest/config";

/**
 * The suite Stryker runs per mutant: everything in-process. The live-database suites can't share one
 * server across parallel mutant workers, so `stryker.config.mjs` points them at a closed port and
 * they skip; CI runs them against real engines on every push.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/backends/sqlIntegration.test.ts", "src/backends/mongoIntegration.test.ts"]
  }
});
