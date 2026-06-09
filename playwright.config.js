import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: {
    timeout: 8000
  },
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.CI ? undefined : "chrome",
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1100 },
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
    }
  },
  webServer: {
    command: "npm run dev:web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30000
  }
});
