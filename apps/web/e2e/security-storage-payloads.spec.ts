import { expect, test } from '@playwright/test';
import {
  assertExactSecretNotInStorage,
  assertNoTokensInStorage,
  loginViaUi,
  TEST_CREDENTIALS,
} from './helpers/auth';

test.describe('Security & Browser Storage Sweep (E2E-08, E2E-09, E2E-12)', () => {
  test.describe.configure({ mode: 'serial' });

  // ---------------------------------------------------------------------------
  // E2E-08: API-key one-time secret browser persistence check
  // ---------------------------------------------------------------------------
  test('E2E-08: API-key one-time secret browser persistence check', async ({ page }) => {
    // 1. Authenticate as Organization A1 administrator
    await loginViaUi(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    // 2. Navigate to API keys administration
    await page.goto('/api-keys');
    await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();

    // 3. Open Create API Key dialog
    await page.getByRole('button', { name: /\+? Create API Key|Create your first API key/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // 4. Fill in key attributes
    const testKeyName = `E2E Secret Test Key ${Date.now()}`;
    await dialog.locator('#api-key-name').fill(testKeyName);

    // Select all held permissions or first available permission
    await dialog.getByRole('button', { name: 'Select All Held' }).click();

    // 5. Submit creation form
    await dialog.getByRole('button', { name: 'Create API Key' }).click();

    // 6. Verify creation succeeds and one-time secret is displayed in read-only input
    await expect(page.getByText('Save Your API Key Secret')).toBeVisible({ timeout: 10_000 });
    const credentialOutput = page.locator('#credential-output');
    await expect(credentialOutput).toBeVisible();

    const fullCredential = await credentialOutput.inputValue();
    expect(fullCredential).toContain('.');
    const [prefix, secret] = fullCredential.split('.');
    expect(prefix).toBeTruthy();
    expect(secret).toBeTruthy();
    expect(secret!.length).toBeGreaterThanOrEqual(32);

    // 7. CRITICAL SECURITY ASSERTION: Verify exact secret is NEVER persisted into any browser storage mechanism
    // Sweeps: localStorage, sessionStorage, document.cookie, IndexedDB, Cache Storage, window.history.state, URL
    await assertExactSecretNotInStorage(page, secret!);
    await assertNoTokensInStorage(page);

    // 8. Confirm save, acknowledge warning, and close dialog
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Done & Close' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // Verify exact secret and general storage remain pristine after closing dialog
    await assertExactSecretNotInStorage(page, secret!);
    await assertNoTokensInStorage(page);
  });

  // ---------------------------------------------------------------------------
  // E2E-09: Audit payload safe text rendering (XSS prevention)
  // ---------------------------------------------------------------------------
  test('E2E-09: Audit payload safe text rendering (XSS prevention)', async ({ page }) => {
    // 1. Authenticate as Organization A1 administrator
    await loginViaUi(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    // 2. Navigate to Audit Logs view
    await page.goto('/audit-logs');
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
    await expect(page.locator('table')).toBeVisible();

    // 3. Locate the real team.created audit row planted by Phase 1C.4a fixture
    // The planted Team T name carries: <img src=x onerror="window.__accFixtureMarkup=1"><script>window.__accFixtureMarkup=1</script>
    // Filter by action 'team.created' to ensure row is retrieved regardless of newer test audit logs
    const actionFilter = page.getByPlaceholder('Action key (e.g. user_role.granted)');
    await actionFilter.fill('team.created');
    await page.getByRole('button', { name: 'Apply Filters' }).click();

    const teamCreatedRow = page.locator('tr', { hasText: 'team.created' }).first();
    await expect(teamCreatedRow).toBeVisible();

    // 4. Open the real AuditLogDetailDialog component
    await teamCreatedRow.getByRole('button', { name: 'Inspect' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // 5. Verify the malicious markup is rendered strictly as preformatted text data in <pre>
    const preBlock = dialog.locator('pre').first();
    await expect(preBlock).toBeVisible();
    const renderedContent = await preBlock.innerText();
    expect(renderedContent).toContain('ACC Fixture Team');
    expect(renderedContent).toContain('<script>window.__accFixtureMarkup=1</script>');

    // 6. Assert no executable <script> or <img> tags are injected into DOM
    const executableScriptCount = await dialog.locator('script').count();
    expect(executableScriptCount).toBe(0);

    // 7. BROWSER-OBSERVABLE XSS PROOF: window.__accFixtureMarkup MUST remain undefined
    const wasExecuted = await page.evaluate(
      () => (window as unknown as { __accFixtureMarkup?: unknown }).__accFixtureMarkup,
    );
    expect(wasExecuted).toBeUndefined();

    // Close dialog
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-12: Browser storage security sweep across all console routes
  // ---------------------------------------------------------------------------
  test('E2E-12: Browser storage security sweep across all console routes', async ({ page }) => {
    // 1. Authenticate as Organization A1 administrator
    await loginViaUi(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    const routes = [
      '/',
      '/users',
      '/roles',
      '/workspaces',
      '/teams',
      '/api-keys',
      '/audit-logs',
      '/organizations',
    ];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      // Comprehensive cryptographic & token storage sweep
      await assertNoTokensInStorage(page);

      // Inspect history state safely
      const historyState = await page.evaluate(() => {
        try {
          return JSON.stringify(window.history.state);
        } catch {
          return null;
        }
      });

      if (historyState) {
        expect(historyState).not.toMatch(/(token|secret|bearer|password)/i);
      }
    }
  });
});
