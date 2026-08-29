import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  webServer: {
    command: "bun --cwd apps/web dev --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    actionTimeout: 5_000,
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
});
