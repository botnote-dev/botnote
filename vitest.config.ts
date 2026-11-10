import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests mix UTC-based fixtures with code that uses the server-local clock
// (e.g. recurrence materialization horizon); pin the timezone so runs don't
// flake in the window where the local date lags the UTC date.
process.env.TZ = "UTC";

export default defineConfig({
  resolve: {
    // The daemon imports the CLI package through its built dist. Tests run
    // against the source so they never exercise a stale build.
    alias: {
      "botnote/mcp": path.resolve(import.meta.dirname, "packages/cli/src/mcp/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
