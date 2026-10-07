import { defineConfig } from "@playwright/test";

// Starts the real desktop app from dist/ and stage/ (run `pnpm bundle` first) with a
// throwaway data folder. Local only: nothing in it reaches SoundCloud.
export default defineConfig({
  testDir: "./smoke",
  timeout: 180_000,
  workers: 1,
  reporter: "list",
});
