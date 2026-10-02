import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_PORT, E2E_REDIS_URL } from "./e2e/constants";

const chrome = devices["Desktop Chrome"];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...chrome, viewport: { width: 1280, height: 800 } } },
    { name: "tablet", use: { ...chrome, viewport: { width: 768, height: 1024 } } },
    { name: "mobile", use: { ...chrome, viewport: { width: 375, height: 720 } } },
  ],
  webServer: {
    command: `pnpm exec next dev --hostname 127.0.0.1 --port ${E2E_PORT}`,
    url: `http://127.0.0.1:${E2E_PORT}/playlists`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      REDIS_URL: E2E_REDIS_URL,
      LOG_LEVEL: "silent",
    },
  },
});
