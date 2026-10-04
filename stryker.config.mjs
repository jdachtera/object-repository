// @ts-check
/**
 * Mutation testing for the migration core: Stryker changes the code one small way at a time and
 * re-runs the tests; a mutant the tests don't notice marks code nothing actually checks.
 *
 *   pnpm run test:mutation
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
const unreachable = "127.0.0.1:1";
process.env.PG_URL = `postgres://x:x@${unreachable}/x`;
process.env.MYSQL_URL = `mysql://x:x@${unreachable}/x`;
process.env.MONGO_URL = `mongodb://${unreachable}`;
process.env.PROPERTY_RUNS ??= "10";

export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/migrations/run.ts",
    "src/migrations/execute.ts",
    "src/migrations/coerce.ts",
    "src/migrations/ops.ts",
    "src/migrations/evaluate.ts",
    "src/migrations/journal.ts",
    "src/migrations/plan.ts",
    "src/backends/sql/lower.ts"
  ],
  coverageAnalysis: "perTest",
  concurrency: 4,
  timeoutMS: 60000,
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 85, low: 70, break: null }
};
