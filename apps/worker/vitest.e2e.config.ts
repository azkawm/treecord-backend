import { defineConfig } from "vitest/config";

// End-to-end test: anvil + contracts + local Supabase + the worker. See docs/worker.md.
export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    testTimeout: 150_000,
    hookTimeout: 60_000,
  },
});
