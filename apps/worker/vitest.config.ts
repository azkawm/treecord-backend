import { configDefaults, defineConfig } from "vitest/config";

// Unit tests only. The end-to-end test runs a live worker that claims any due job in the local database,
// so it is kept out of `pnpm test` (where the web route tests run in parallel) and run on its own with
// `pnpm --filter @treecord/worker test:e2e` (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/test/**"],
    testTimeout: 20_000,
  },
});
