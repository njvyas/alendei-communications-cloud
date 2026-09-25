import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E and browser security configuration for @acc/web.
 *
 * Invariants:
 * 1. Base URL defaults to http://localhost:3000 (configurable via PLAYWRIGHT_BASE_URL).
 * 2. Runs single-worker (workers: 1) to prevent authentication rate-limit collisions (AUTH_WINDOW max 10/min)
 *    and ensure deterministic session lifecycle verification.
 * 3. Reuses existing development server if already running on port 3000.
 * 4. Captures trace and screenshots on failure for security forensics without exposing secrets in logs.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
