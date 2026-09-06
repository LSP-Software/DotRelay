import { defineConfig } from "@playwright/test";

const hostname = process.env.CI ? "127.0.0.1" : "localhost";
const origin = `http://${hostname}:3000`;

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  webServer: {
    command: `bun --cwd apps/web dev --hostname ${hostname}`,
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      DOTRELAY_WORKSPACE_FIXTURE: "1",
    },
  },
  use: {
    actionTimeout: 5_000,
    baseURL: origin,
    trace: "on-first-retry",
  },
});
