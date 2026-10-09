import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "acceptance.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 35000,
  expect: { timeout: 3000 },
  reporter: [["list"]],
  outputDir: "artifacts/acceptance/browser",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3100",
    trace: "on",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node dist/test-server.js",
    url: "http://127.0.0.1:3100/health",
    reuseExistingServer: false,
    timeout: 5000,
    stdout: "pipe",
  },
});
