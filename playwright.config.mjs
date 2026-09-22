import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  workers: 1,
  use: { browserName: 'chromium', channel: process.env.KOROGI_BROWSER_CHANNEL || 'chrome', baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 900 } },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
