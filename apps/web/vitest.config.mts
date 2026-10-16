import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${root}/` },
      // `server-only` throws outside the React server runtime. Route tests run in plain Node.
      {
        find: "server-only",
        replacement: fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
      },
    ],
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
