import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * U10 real-browser dialog validation.
 *
 * Same conventions as `apps/web/playwright.config.ts` (single worker, traces and
 * screenshots on failure), with two differences:
 * 1. No `webServer`: the harness is bundled from the production dialog sources and
 *    served through request routing, so no Next.js server, API or database is needed.
 * 2. Runs Chromium and Firefox.
 * 3. Failure traces and screenshots go to U10_PW_OUTPUT_DIR (default: OS temp dir).
 *
 * Run from apps/web: `npx playwright test -c e2e/u10/playwright.u10.config.ts`
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Kept outside the repository (test-results/ is not gitignored).
  outputDir: process.env.U10_PW_OUTPUT_DIR ?? path.join(os.tmpdir(), 'acc-u10-playwright'),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
