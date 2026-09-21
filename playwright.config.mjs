import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4318', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node bin/symphony.mjs --port 4318 --data-dir .symphony/browser-test --demo', url: 'http://127.0.0.1:4318/api/status', reuseExistingServer: false, timeout: 15000 },
});
