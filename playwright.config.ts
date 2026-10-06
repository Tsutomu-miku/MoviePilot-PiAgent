import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: "node_modules/.bin/tsx tests/e2e/server.ts",
    url: "http://127.0.0.1:8788/api/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
