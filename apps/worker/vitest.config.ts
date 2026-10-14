import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite talks to an in-process Postgres and to injected fetchers only.
    setupFiles: ["./test/no-network.ts"],
  },
});
