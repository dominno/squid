import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",                   // Re-exports only
        "src/core/index.ts",              // Re-exports only
        "src/core/types.ts",              // Type definitions only
        "src/cli/**",                     // CLI integration (needs e2e tests)
        "src/core/openclaw-adapter.ts",   // Requires live OpenClaw API (HTTP + which detection)
        "src/core/adapters/setup.ts",     // Calls all adapter constructors (integration)
        "src/core/adapters/index.ts",     // Re-exports only
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
