import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    extraHTTPHeaders: { "x-forwarded-for": "127.0.0.1" },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "pnpm exec tsx e2e/provider.ts",
      reuseExistingServer: false,
      timeout: 30_000,
      url: "http://127.0.0.1:3111/health",
    },
    {
      command: "pnpm e2e:serve",
      env: {
        BETTER_AUTH_SECRET: "fishmem-e2e-secret-at-least-32-bytes",
        BETTER_AUTH_URL: "http://127.0.0.1:3100",
        CRON_SECRET: "fishmem-e2e-cron-secret",
        DATABASE_URL: "file:.data/fishmem-e2e.db",
        FISHMEM_DB: "libsql",
        FISHMEM_RUNTIME: "node",
        FISHMEM_SETUP_TOKEN: "fishmem-e2e-setup-token",
        OPENAI_API_KEY: "fishmem-e2e-provider-key",
        OPENAI_BASE_URL: "http://127.0.0.1:3111/v1",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://127.0.0.1:3100/setup",
    },
  ],
});
