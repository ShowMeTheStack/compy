import { defineConfig, devices } from '@playwright/test';

// E2E runs against the production build served by `vite preview` — the same
// bytes that deploy to a static host. `npm run test:e2e` assumes `npm run build`
// ran first (`npm run test:all` sequences this).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  workers: process.env.CI ? 4 : 8,
  timeout: 45_000,
  reporter: process.env.CI ? [['list']] : [['dot'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
