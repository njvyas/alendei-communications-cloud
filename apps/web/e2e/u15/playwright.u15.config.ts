import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * U15.1 real-browser validation.
 *
 * - `components-*`: the isolated harness (harness.tsx, bundled from production
 *   sources with esbuild, styled by the compiled globals.css) served through request
 *   routing — no Next.js server, API or database.
 * - `theme-*`: the real Next.js app (root layout, proxy, pre-paint script) for the
 *   cold-start, preference, dynamic-switch, hydration and CSP checks. By default a
 *   development server is started on port 3156 (hydration warnings are reported
 *   only in development); set U15_BASE_URL to test another server, for example a
 *   production build (`next start`).
 *
 * Run from apps/web: `npx playwright test -c e2e/u15/playwright.u15.config.ts`
 */
const baseURL = process.env.U15_BASE_URL ?? 'http://localhost:3156';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: {
    timeout: 7_500,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' },
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.U15_PW_OUTPUT_DIR ?? path.join(os.tmpdir(), 'acc-u15-playwright'),
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{projectName}{ext}',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off', headless: true },
  projects: [
    {
      name: 'components-chromium',
      testMatch: /u15-components\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'components-firefox',
      testMatch: /u15-components\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'shell-chromium',
      testMatch: /u15-shell\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'shell-firefox',
      testMatch: /u15-shell\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'theme-chromium',
      testMatch: /u15-theme\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL },
    },
    {
      name: 'theme-firefox',
      testMatch: /u15-theme\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'], baseURL },
    },
  ],
  webServer: process.env.U15_BASE_URL
    ? undefined
    : {
        command: 'npx next dev --port 3156',
        cwd: path.resolve(__dirname, '../..'),
        url: `${baseURL}/login`,
        reuseExistingServer: true,
        timeout: 180_000,
        env: { NEXT_PUBLIC_API_BASE_URL: 'http://api.u15.test/api/v1' },
      },
});
