import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests drive a headless browser against local fixture pages.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
