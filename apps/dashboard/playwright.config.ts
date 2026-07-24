import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3200",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "BUILDLABS_DASHBOARD_FIXTURES=1 BUILDLABS_OPERATOR_TOKEN=fixture-operator-token BUILDLABS_DASHBOARD_ALIAS_SECRET=fixture-alias-secret-at-least-32-characters npm run build && BUILDLABS_DASHBOARD_FIXTURES=1 BUILDLABS_OPERATOR_TOKEN=fixture-operator-token BUILDLABS_DASHBOARD_ALIAS_SECRET=fixture-alias-secret-at-least-32-characters npm run start",
    url: "http://127.0.0.1:3200/healthz",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
});
