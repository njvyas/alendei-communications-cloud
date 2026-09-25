import { expect, type Page } from '@playwright/test';

/**
 * Deterministic test credentials resolved strictly from environment variables.
 * Defaults match the development bootstrap platform admin credentials.
 * NEVER hardcode production secrets.
 */
export const TEST_CREDENTIALS = {
  email: process.env.E2E_USER_EMAIL || process.env.AUTH_BOOTSTRAP_EMAIL || 'platform-admin@alendei.test',
  password:
    process.env.E2E_USER_PASSWORD ||
    process.env.AUTH_BOOTSTRAP_PASSWORD ||
    'local-development-only-passphrase-not-a-secret',
  lowPrivEmail: process.env.E2E_LOW_PRIV_EMAIL || null,
  lowPrivPassword: process.env.E2E_LOW_PRIV_PASSWORD || null,
  multiOrgEmail: process.env.E2E_MULTI_ORG_EMAIL || null,
  multiOrgPassword: process.env.E2E_MULTI_ORG_PASSWORD || null,
};

/**
 * Performs browser-level authentication through the actual /login UI.
 * Enforces accessibility selectors: getByLabel and getByRole.
 */
export async function loginViaUi(
  page: Page,
  email = TEST_CREDENTIALS.email,
  password = TEST_CREDENTIALS.password,
): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for post-login navigation to the console shell
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
}

/**
 * Cryptographic & session token storage sweep.
 * Asserts that neither access tokens, refresh tokens, nor plaintext secrets
 * leak into localStorage, sessionStorage, or JavaScript-accessible document.cookie.
 */
export async function assertNoTokensInStorage(page: Page): Promise<void> {
  const url = new URL(page.url());
  expect(url.searchParams.has('token')).toBe(false);
  expect(url.searchParams.has('accessToken')).toBe(false);
  expect(url.searchParams.has('secret')).toBe(false);
  expect(url.hash).toBe('');

  const storageState = await page.evaluate(() => {
    const localKeys = Object.keys(localStorage);
    const sessionKeys = Object.keys(sessionStorage);
    const localEntries = localKeys.map((k) => ({ key: k, val: localStorage.getItem(k) ?? '' }));
    const sessionEntries = sessionKeys.map((k) => ({ key: k, val: sessionStorage.getItem(k) ?? '' }));
    const jsCookie = document.cookie;

    return { localKeys, localEntries, sessionKeys, sessionEntries, jsCookie };
  });

  const sensitivePattern = /^(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9_-]{32,}$/;
  const tokenKeyPattern = /(token|jwt|bearer|secret|credential|auth_token|access_token|refresh_token)/i;

  // 1. Verify localStorage
  for (const { key, val } of storageState.localEntries) {
    expect(key).not.toMatch(tokenKeyPattern);
    if (typeof val === 'string' && val.length > 32) {
      expect(val).not.toMatch(sensitivePattern);
    }
  }

  // 2. Verify sessionStorage
  for (const { key, val } of storageState.sessionEntries) {
    expect(key).not.toMatch(tokenKeyPattern);
    if (typeof val === 'string' && val.length > 32) {
      expect(val).not.toMatch(sensitivePattern);
    }
  }

  // 3. Verify document.cookie: Must NOT expose acc_refresh
  expect(storageState.jsCookie).not.toContain('acc_refresh');
  expect(storageState.jsCookie).not.toContain('Bearer');
}
