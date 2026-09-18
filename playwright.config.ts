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
      // The device approval page targets this same origin in tests so specs
      // can intercept its auth requests without cross-origin handling.
      NEXT_PUBLIC_DOTRELAY_API_ORIGIN: origin,
      NEXT_PUBLIC_DOTRELAY_WORKSPACE_REFRESH_MS: "1500",
      // Specs that exercise the self-hosted flow preview it explicitly;
      // plain URLs behave like DotRelay's own hosted deployments.
      NEXT_PUBLIC_DOTRELAY_WEB_PROFILE: "hosted",
    },
  },
  use: {
    actionTimeout: 5_000,
    baseURL: origin,
    trace: "on-first-retry",
  },
});
