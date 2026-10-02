import { expect, test } from '@playwright/test';
import { assertNoTokensInStorage, loginViaUi, TEST_CREDENTIALS } from './helpers/auth';

test.describe('Tenancy & Route Authorization (E2E-06, E2E-07, E2E-10, E2E-11)', () => {
  test.describe.configure({ mode: 'serial' });

  // ---------------------------------------------------------------------------
  // E2E-06: Multi-organization selection and switching
  // ---------------------------------------------------------------------------
  test('E2E-06: Multi-organization selection and switching', async ({ page }) => {
    // 1. Authenticate as multi-org user who holds grants in both Organization A1 and Organization A2
    await loginViaUi(page, TEST_CREDENTIALS.multiOrg.email, TEST_CREDENTIALS.multiOrg.password);

    // 2. Handle the initial organization-selection view (rendered when multiple orgs exist)
    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    const orgSelect = page.locator('#organization-select');
    await expect(orgSelect).toBeVisible();

    const options = await orgSelect.locator('option').all();
    expect(options.length).toBeGreaterThanOrEqual(2);

    const orgIdA1 = await options[0]!.getAttribute('value');
    const orgIdA2 = await options[1]!.getAttribute('value');
    expect(orgIdA1).toBeTruthy();
    expect(orgIdA2).toBeTruthy();
    expect(orgIdA1).not.toBe(orgIdA2);

    // 3. Select Organization A1 and continue to the console
    await orgSelect.selectOption(orgIdA1!);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // 4. Verify Organization A1 context is established
    await expect(page.locator('#org-select')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#org-select')).toHaveValue(orgIdA1!);

    // Verify A1 workspace data reflects active A1 context
    await page.getByRole('link', { name: 'Workspaces' }).click();
    await expect(page.locator('#org-select')).toHaveValue(orgIdA1!);
    await expect(page.getByText(/default/i).first()).toBeVisible();

    // 5. Switch to Organization A2 via header dropdown
    let headerSentToBackend: string | null = null;
    page.on('request', (req) => {
      const h = req.headers();
      if (h['x-acc-organization']) {
        headerSentToBackend = h['x-acc-organization'];
      }
    });

    await page.locator('#org-select').selectOption(orgIdA2!);

    // 6. Verify the tenant context changes in header and UI
    await expect(page.locator('#org-select')).toHaveValue(orgIdA2!);
    await page.waitForLoadState('networkidle');

    // 7. Verify subsequent requests are pinned to A2 and data reflects A2
    await page.getByRole('link', { name: 'Workspaces' }).click();
    await expect(page.locator('#org-select')).toHaveValue(orgIdA2!);
    expect(headerSentToBackend).toBe(orgIdA2);

    await assertNoTokensInStorage(page);
  });

  // ---------------------------------------------------------------------------
  // E2E-07: Navigation across console routes
  // ---------------------------------------------------------------------------
  test('E2E-07: Navigation across Users / Roles / Workspaces / Teams / API Keys / Audit Logs routes', async ({
    page,
  }) => {
    // 1. Authenticate as Organization A1 administrator (single org: auto-selects A1)
    await loginViaUi(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    // 2. Ensure ZeroOrgView is NOT rendered
    await expect(page.locator('text=No Organization Access')).not.toBeVisible();

    // 3. /users: Real users table with fixture administrator present
    await page.goto('/users');
    expect(page.url()).toContain('/users');
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.getByText(TEST_CREDENTIALS.a1Admin.email)).toBeVisible();

    // 4. /roles: Real roles table displaying system roles
    await page.goto('/roles');
    expect(page.url()).toContain('/roles');
    await expect(page.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible();
    await expect(page.getByText('org_admin')).toBeVisible();

    // 5. /workspaces: Real workspaces table with seeded default workspace
    await page.goto('/workspaces');
    expect(page.url()).toContain('/workspaces');
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
    await expect(page.getByText(/default/i).first()).toBeVisible();

    // 6. /teams: Real teams table containing planted fixture team
    await page.goto('/teams');
    expect(page.url()).toContain('/teams');
    await expect(page.getByRole('heading', { name: 'Teams' })).toBeVisible();
    await expect(page.getByText(/ACC Fixture Team/)).toBeVisible();

    // 7. /api-keys: Real API keys management view
    await page.goto('/api-keys');
    expect(page.url()).toContain('/api-keys');
    await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /\+? Create API Key|Create your first API key/i }).first(),
    ).toBeVisible();

    // 8. /audit-logs: Real audit trail table with planted audit rows
    await page.goto('/audit-logs');
    expect(page.url()).toContain('/audit-logs');
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    // Verify zero client-side crashes or unhandled exceptions across navigation
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('Application error');

    await assertNoTokensInStorage(page);
  });

  // ---------------------------------------------------------------------------
  // E2E-10: Tenant header override protection via network observation
  // ---------------------------------------------------------------------------
  test('E2E-10: Tenant header override protection via network observation', async ({ page }) => {
    // 1. Authenticate as Organization A1 administrator
    await loginViaUi(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    // Get active Organization A1 ID
    const activeOrgId = await page.evaluate(() => {
      const select = document.getElementById('org-select') as HTMLSelectElement | null;
      if (select && select.value) return select.value;
      const orgBadge = document.querySelector('header span.truncate');
      return orgBadge ? orgBadge.textContent : null;
    });
    expect(activeOrgId).toBeTruthy();

    // POSITIVE CONTROL: Observe legitimate client-dispatched requests carrying X-Acc-Organization
    const workspacesResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/api/v1/workspaces') && res.request().method() === 'GET',
    );
    await page.getByRole('link', { name: 'Workspaces' }).click();
    const workspacesRes = await workspacesResponsePromise;
    expect(workspacesRes.request().headers()['x-acc-organization']).toBe(activeOrgId);
    expect(workspacesRes.status()).toBe(200);

    // NEGATIVE CONTROL: Backend refusal of forged organization header
    // When requesting with a forged unheld organization ID (e.g. acc-fixture-b1),
    // backend must enforce strict tenant boundary and refuse with 403 TENANCY_CONTEXT_MISMATCH
    const unheldOrgId = '01a0f4f2-874b-76b9-8a88-70478d2b7b21'; // acc-fixture-b1

    const refreshRes = await page.request.post('http://localhost:3001/api/v1/auth/refresh', {
      headers: { 'X-Acc-Refresh': '1' },
    });
    expect(refreshRes.status()).toBe(200);
    const refreshData = await refreshRes.json();
    const token = refreshData.data.accessToken;

    const forgedRes = await page.request.get('http://localhost:3001/api/v1/workspaces', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Acc-Organization': unheldOrgId,
      },
    });
    expect(forgedRes.status()).toBe(403);
    const forgedBody = await forgedRes.json();
    expect(forgedBody.error.code).toBe('TENANCY_CONTEXT_MISMATCH');

    await assertNoTokensInStorage(page);
  });

  // ---------------------------------------------------------------------------
  // E2E-11: Unauthorized protected route boundary (low-privilege user)
  // ---------------------------------------------------------------------------
  test('E2E-11: Unauthorized protected route boundary (low-privilege user)', async ({ page }) => {
    // 1. Authenticate as low-privilege user (read_only grant at Team T only, lacking audit.read)
    await loginViaUi(page, TEST_CREDENTIALS.teamReader.email, TEST_CREDENTIALS.teamReader.password);

    // LAYER 1: Direct backend contract refusal proof
    // Low-privilege user attempting to read audit logs receives 403 AUTHZ_SCOPE_DENIED
    const refreshRes = await page.request.post('http://localhost:3001/api/v1/auth/refresh', {
      headers: { 'X-Acc-Refresh': '1' },
    });
    expect(refreshRes.status()).toBe(200);
    const {
      data: { accessToken: teamReaderToken },
    } = await refreshRes.json();

    const auditApiRes = await page.request.get('http://localhost:3001/api/v1/audit-logs', {
      headers: {
        Authorization: `Bearer ${teamReaderToken}`,
        'X-Acc-Organization': '01a0f4f2-8563-72b2-8e15-f407008cf912',
      },
    });
    expect(auditApiRes.status()).toBe(403);
    const auditApiBody = await auditApiRes.json();
    expect(auditApiBody.error.code).toBe('AUTHZ_SCOPE_DENIED');

    // LAYER 2: UI defense-in-depth boundary proof
    await page.getByRole('link', { name: 'Audit Logs' }).click();
    await page.waitForLoadState('networkidle');

    // Console renders explicit "Access Forbidden" boundary and names the missing permission
    await expect(page.getByText('Access Forbidden')).toBeVisible();
    await expect(page.getByText(/audit\.read/)).toBeVisible();

    // Table of audit records must NOT be rendered (zero data disclosure)
    await expect(page.locator('table')).not.toBeVisible();

    await assertNoTokensInStorage(page);
  });
});
