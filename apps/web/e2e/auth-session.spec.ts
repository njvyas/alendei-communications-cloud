import { expect, test } from '@playwright/test';
import { assertNoTokensInStorage, loginViaUi, TEST_CREDENTIALS } from './helpers/auth';

test.describe('Auth & Session Security (E2E-01 .. E2E-05)', () => {
  test.describe.configure({ mode: 'serial' });

  test('E2E-01: Login establishes authenticated session through UI', async ({ page }) => {
    await page.goto('/login');

    // 1. Verify login form presence and accessible labels
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();

    // 2. Submit valid test credentials
    await page.getByLabel('Email address').fill(TEST_CREDENTIALS.email);
    await page.getByLabel('Password').fill(TEST_CREDENTIALS.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // 3. Reaches root console shell
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
    expect(page.url()).toBe('http://localhost:3000/');

    // 4. Authenticated context is established
    // Current dev DB has 0 tenant organizations, so the application transitions to ZeroOrgView
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).toContain('Alendei Communications Cloud');
    expect(bodyText).toContain('Sign out');
  });

  test('E2E-02: Protected routes redirect unauthenticated visitors to /login', async ({ page }) => {
    // 1. Attempt navigating to /users without a session
    await page.goto('/users');
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 10_000 });
    expect(page.url()).toContain('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // Verify no user list content is leaked
    const usersBody = await page.locator('body').innerText();
    expect(usersBody).not.toContain('Invite User');
    expect(usersBody).not.toContain('Role Assignments');

    // 2. Attempt navigating to /roles without a session
    await page.goto('/roles');
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 10_000 });
    expect(page.url()).toContain('/login');

    // 3. Attempt navigating to /audit-logs without a session
    await page.goto('/audit-logs');
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 10_000 });
    expect(page.url()).toContain('/login');
  });

  test('E2E-03: Authenticated identity does not expose tokens in URL or storage', async ({ page }) => {
    await loginViaUi(page);

    // 1. Authenticated shell renders
    await expect(page.getByText('Alendei Communications Cloud')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // 2. Assert zero access/refresh tokens in URL, hash, localStorage, or sessionStorage
    await assertNoTokensInStorage(page);
  });

  test('E2E-04: Session continuity on reload via HttpOnly cookie isolation', async ({ page }) => {
    await loginViaUi(page);

    // 1. Verify pre-reload authenticated state
    const preReloadText = await page.locator('body').innerText();
    expect(preReloadText).toContain('Alendei Communications Cloud');

    // 2. Perform real page reload
    await page.reload({ waitUntil: 'networkidle' });

    // 3. Verify user remains authenticated after reload via background refresh
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 10_000 });
    const postReloadText = await page.locator('body').innerText();
    expect(postReloadText).toContain('Alendei Communications Cloud');

    // 4. Verify acc_refresh cookie exists in browser context with httpOnly=true
    const cookies = await page.context().cookies();
    const refreshCookie = cookies.find((c) => c.name === 'acc_refresh');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie?.httpOnly).toBe(true);
    expect(refreshCookie?.path).toBe('/api/v1/auth');

    // 5. Verify JavaScript document.cookie CANNOT read the refresh token
    const jsCookie = await page.evaluate(() => document.cookie);
    expect(jsCookie).not.toContain('acc_refresh');
  });

  test('E2E-05: Logout clears session and blocks console access', async ({ page }) => {
    await loginViaUi(page);

    // 1. Sign out through the actual UI
    await page.getByRole('button', { name: 'Sign out' }).click();

    // 2. Verify redirect to /login
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // 3. Attempt direct navigation back to /users
    await page.goto('/users');
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 10_000 });
    expect(page.url()).toContain('/login');

    // 4. Verify browser storage has no tokens
    await assertNoTokensInStorage(page);
  });
});
