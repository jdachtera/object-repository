import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Cover the library source only — not tests, barrels, or type-only files (interfaces/type
      // aliases compile to nothing, so v8 reports them as 0% and skews the totals).
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts",
        "src/**/types.ts",
        "src/core/QueryPlan.ts",
        "src/core/SyncTarget.ts",
        "src/core/Transport.ts",
        "src/expressions/visitor.ts",
        "src/expressions/Expression.ts",
        "src/properties/infer.ts",
        "src/properties/infer.types.ts"
      ],
      // A regression ratchet just below the current numbers (~96.8 / 91.7 / 95.4 / ~96.8 in the
      // offline pre-commit run). The pre-commit hook enforces these, so coverage can't silently drop.
      // Raise them as coverage climbs; bypass a commit with `git commit --no-verify` when necessary.
      thresholds: { statements: 96, branches: 91, functions: 95, lines: 96 }
    }
  }
});
