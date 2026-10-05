import { expect, test, type Page } from '@playwright/test';
import { loginViaUi, TEST_CREDENTIALS } from './helpers/auth';

async function loginAsPersona(page: Page, email: string, password = TEST_CREDENTIALS.password) {
  await loginViaUi(page, email, password);
  const enterBtn = page.getByRole('button', { name: 'Enter Console' });
  if (await enterBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await enterBtn.click();
  }
}

async function loginAsOperator(page: Page) {
  await loginAsPersona(page, TEST_CREDENTIALS.operator.email, TEST_CREDENTIALS.operator.password);
}

test.describe('Phase 2.6 — Providers & Channels Console (Gate D.6)', () => {
  test.describe.configure({ mode: 'serial' });

  // ---------------------------------------------------------------------------
  // E2E-PROV-01: Channel catalogue and detail view
  // ---------------------------------------------------------------------------
  test('E2E-PROV-01: Channel catalogue and detail navigation', async ({ page }) => {
    await loginAsOperator(page);

    // 1. Navigate to Channels via sidebar
    await page.getByRole('link', { name: 'Channels' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/channels'));
    await expect(page.getByRole('heading', { name: 'Communication Channels' })).toBeVisible();

    // 2. Channels table lists seeded channels
    await expect(page.getByText('WhatsApp', { exact: true })).toBeVisible();
    await expect(page.getByText('SMS', { exact: true })).toBeVisible();
    await expect(page.getByText('Email', { exact: true })).toBeVisible();

    // 3. Navigate into SMS channel detail
    await page.getByRole('link', { name: 'View details' }).first().click();
    await page.waitForURL((url) => url.pathname.startsWith('/channels/'));

    // 4. Verify channel information cards
    await expect(page.getByRole('heading', { name: 'Channel Information' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Configured Providers' })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-PROV-02: Provider catalogue list, status badges, and filtering
  // ---------------------------------------------------------------------------
  test('E2E-PROV-02: Provider list, status badges, and filtering', async ({ page }) => {
    await loginAsOperator(page);

    // 1. Navigate to Providers
    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));
    await expect(page.getByRole('heading', { name: 'Communication Providers' })).toBeVisible();

    // 2. Verify table renders the three fixture providers
    const table = page.getByTestId('providers-table');
    await expect(table).toBeVisible();
    await expect(table.getByText('ACC Fixture SMS Primary')).toBeVisible();
    await expect(table.getByText('ACC Fixture SMS Secondary')).toBeVisible();
    await expect(table.getByText('ACC Fixture Email')).toBeVisible();

    // 3. Verify status badges are present on the rows
    const primaryRow = page.getByTestId('provider-row-acc-fixture-sms-primary');
    await expect(primaryRow.getByTestId('provider-lifecycle-badge')).toHaveText(/active/i);
    await expect(primaryRow.getByTestId('provider-health-badge')).toBeVisible();
    await expect(primaryRow.getByTestId('provider-circuit-badge')).toHaveText(/closed/i);

    const secondaryRow = page.getByTestId('provider-row-acc-fixture-sms-secondary');
    await expect(secondaryRow.getByTestId('provider-lifecycle-badge')).toHaveText(/draining/i);

    // 4. Filter by status: draining
    await page.locator('#filter-status').selectOption('draining');
    await expect(table.getByText('ACC Fixture SMS Secondary')).toBeVisible();
    await expect(table.getByText('ACC Fixture SMS Primary')).not.toBeVisible();
    await expect(table.getByText('ACC Fixture Email')).not.toBeVisible();

    // Reset filter
    await page.locator('#filter-status').selectOption('all');
    await expect(table.getByText('ACC Fixture SMS Primary')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-PROV-03: Provider lifecycle transitions (enable, disable, drain)
  // ---------------------------------------------------------------------------
  test('E2E-PROV-03: Provider lifecycle transitions', async ({ page }) => {
    await loginAsOperator(page);

    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));
    // Open ACC Fixture Email (which is initially disabled)
    await page.getByRole('link', { name: 'ACC Fixture Email' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers/'));

    // Verify initial disabled state
    await expect(page.getByTestId('provider-lifecycle-badge').first()).toHaveText(/disabled/i);
    const enableBtn = page.getByTestId('enable-provider-btn');
    await expect(enableBtn).toBeVisible();

    // 1. Enable provider
    await enableBtn.click();
    await expect(page.getByRole('heading', { name: 'Enable Provider' })).toBeVisible();
    await page.getByRole('button', { name: 'Enable Provider' }).click();

    // Status moves to active
    await expect(page.getByTestId('provider-lifecycle-badge').first()).toHaveText(/active/i, {
      timeout: 10_000,
    });
    const drainBtn = page.getByTestId('drain-provider-btn');
    await expect(drainBtn).toBeVisible();

    // 2. Drain provider
    await drainBtn.click();
    await expect(page.getByRole('heading', { name: 'Drain Provider' })).toBeVisible();
    await page.getByRole('button', { name: 'Drain Provider' }).click();

    // Status moves to draining
    await expect(page.getByTestId('provider-lifecycle-badge').first()).toHaveText(/draining/i, {
      timeout: 10_000,
    });

    // 3. Disable provider (restore initial fixture status)
    const disableBtn = page.getByTestId('disable-provider-btn');
    await expect(disableBtn).toBeVisible();
    await disableBtn.click();
    await expect(page.getByRole('heading', { name: 'Disable Provider' })).toBeVisible();
    await page.getByRole('button', { name: 'Disable Provider' }).click();

    await expect(page.getByTestId('provider-lifecycle-badge').first()).toHaveText(/disabled/i, {
      timeout: 10_000,
    });
  });

  // ---------------------------------------------------------------------------
  // E2E-PROV-04: Provider capabilities replacement
  // ---------------------------------------------------------------------------
  test('E2E-PROV-04: Provider capabilities replacement', async ({ page }) => {
    await loginAsOperator(page);

    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));
    await page.getByRole('link', { name: 'ACC Fixture SMS Primary' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers/'));

    // 1. Check existing capability
    await expect(page.getByText('max_segments')).toBeVisible();

    // 2. Open edit dialog
    await page.getByTestId('edit-capabilities-btn').click();
    await expect(page.getByRole('heading', { name: /Edit Capabilities/i })).toBeVisible();

    // 3. Add capability
    await page.getByRole('button', { name: '+ Add Capability' }).click();
    const keyInputs = await page.locator('input[placeholder="e.g. max_segments"]').all();
    const newKeyInput = keyInputs[keyInputs.length - 1]!;
    const testCapKey = `cap_${Date.now()}`;
    await newKeyInput.fill(testCapKey);

    const valueInputs = await page.locator('textarea[placeholder*="supports_templates"]').all();
    const newValueInput = valueInputs[valueInputs.length - 1]!;
    await newValueInput.fill('true');

    // 4. Save
    await page.getByRole('button', { name: 'Save Capabilities' }).click();
    await expect(page.getByRole('heading', { name: /Edit Capabilities/i })).not.toBeVisible({
      timeout: 5_000,
    });

    // 5. Verify updated capability in list
    await expect(page.getByText(testCapKey, { exact: true })).toBeVisible({ timeout: 10_000 });

    // 6. Clean up: remove the added capability to preserve fixture state
    await page.getByTestId('edit-capabilities-btn').click();
    await expect(page.getByRole('heading', { name: /Edit Capabilities/i })).toBeVisible();
    await page
      .getByTestId(`capability-row-${testCapKey}`)
      .getByRole('button', { name: 'Delete' })
      .click();
    await page.getByRole('button', { name: 'Save Capabilities' }).click();
    await expect(page.getByRole('heading', { name: /Edit Capabilities/i })).not.toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText(testCapKey, { exact: true })).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('max_segments')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-PROV-05: Circuit policy viewing and update
  // ---------------------------------------------------------------------------
  test('E2E-PROV-05: Circuit policy administration and concurrency conflict', async ({ page }) => {
    await loginAsOperator(page);

    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));
    const policyBtn = page.getByTestId('circuit-policy-btn');
    await expect(policyBtn).toBeVisible();
    await policyBtn.click();

    await expect(
      page.getByRole('heading', { name: 'Platform Circuit Breaker Policy' }),
    ).toBeVisible();

    // 1. Read existing value and update
    const cooldownInput = page.locator('#circuit-cooldown-ms');
    await expect(cooldownInput).toBeVisible();
    const val = await cooldownInput.inputValue();
    const newCooldown = Number(val) === 30000 ? '35000' : '30000';
    await cooldownInput.fill(newCooldown);

    await page.getByRole('button', { name: 'Save Policy' }).click();
    await expect(page.getByText(/Circuit policy updated to version/i)).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole('button', { name: 'Close' }).click();
  });

  // ---------------------------------------------------------------------------
  // E2E-PROV-06: Health probe and manual override
  // ---------------------------------------------------------------------------
  test('E2E-PROV-06: Health probe and manual override', async ({ page }) => {
    await loginAsOperator(page);

    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));
    await page.getByRole('link', { name: 'ACC Fixture SMS Primary' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers/'));

    // 1. Run probe
    await page.getByTestId('run-probe-btn').click();
    await expect(page.getByRole('heading', { name: /Run Health Probe/i })).toBeVisible();
    await page.locator('#health-probe-behavior').selectOption('HEALTHY');
    await page.getByRole('button', { name: 'Execute Probe' }).click();

    await expect(page.getByTestId('health-probe-result')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('health-probe-outcome')).toHaveText(/healthy/i);
    await page.getByRole('button', { name: 'Close' }).click();

    // 2. Set manual health override
    await page.getByTestId('health-override-btn').click();
    await expect(page.getByRole('heading', { name: /Manual Health Override/i })).toBeVisible();
    await page.locator('#health-override-state').selectOption('degraded');
    await page.locator('#health-override-reason').fill('Scheduled maintenance');
    await page.getByRole('button', { name: 'Apply Override' }).click();

    // Verify pin badge appears
    await expect(page.getByTestId('provider-health-pin').first()).toBeVisible({ timeout: 10_000 });

    // 3. Clear manual health override
    await page.getByTestId('health-override-btn').click();
    await page.locator('#health-override-state').selectOption('clear');
    await page.getByRole('button', { name: 'Apply Override' }).click();

    await expect(page.getByTestId('provider-health-pin')).toHaveCount(0);
    await expect(page.getByText('Automatic (no pin)')).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // E2E-PROV-07: Simulator test-send outcomes
  // ---------------------------------------------------------------------------
  test('E2E-PROV-07: Simulator test-send accepted and rejected outcomes', async ({ page }) => {
    await loginAsOperator(page);

    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));
    await page.getByRole('link', { name: 'ACC Fixture SMS Primary' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers/'));

    const testSendSection = page.getByRole('heading', { name: 'Simulator Test-Send' });
    await expect(testSendSection).toBeVisible();

    // 1. Successful test-send
    await page.locator('#test-send-behavior').selectOption('SUCCESS');
    await page.getByRole('button', { name: 'Execute Test Send' }).click();

    const resultCard = page.getByTestId('test-send-result');
    await expect(resultCard).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('test-send-outcome')).toHaveText(/accepted/i);
    await expect(page.getByText(/sim-/i).first()).toBeVisible();

    // 2. Rate-limited test-send (rejected)
    await page.locator('#test-send-behavior').selectOption('429');
    await page.getByRole('button', { name: 'Execute Test Send' }).click();

    await expect(page.getByTestId('test-send-outcome')).toHaveText(/rejected/i, {
      timeout: 10_000,
    });
    await expect(resultCard.getByText(/RATE_LIMITED/i)).toBeVisible();
    await expect(resultCard.getByText(/RETRYABLE/i)).toBeVisible();

    // 3. Restore healthy state with SUCCESS test-send
    await page.locator('#test-send-behavior').selectOption('SUCCESS');
    await page.getByRole('button', { name: 'Execute Test Send' }).click();
    await expect(page.getByTestId('test-send-outcome')).toHaveText(/accepted/i, {
      timeout: 10_000,
    });
  });

  // ---------------------------------------------------------------------------
  // E2E-PROV-08: Low-privilege persona authorization boundaries
  // ---------------------------------------------------------------------------
  test('E2E-PROV-08: Low-privilege persona authorization boundaries', async ({ page, context }) => {
    // 1. Reader persona (providers.read only)
    await context.clearCookies();
    await loginAsPersona(
      page,
      TEST_CREDENTIALS.providersReader.email,
      TEST_CREDENTIALS.providersReader.password,
    );

    // Reader navigates to /providers via sidebar
    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));

    // Reader can view providers table
    await expect(page.getByRole('heading', { name: 'Communication Providers' })).toBeVisible();
    await expect(page.getByText('ACC Fixture SMS Primary')).toBeVisible();

    // Admin buttons must NOT be visible
    await expect(page.getByTestId('create-provider-btn')).not.toBeVisible();
    await expect(page.getByTestId('circuit-policy-btn')).not.toBeVisible();

    // Detail view restrictions
    await page.getByRole('link', { name: 'ACC Fixture SMS Primary' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers/'));

    await expect(page.getByTestId('enable-provider-btn')).not.toBeVisible();
    await expect(page.getByTestId('drain-provider-btn')).not.toBeVisible();
    await expect(page.getByTestId('disable-provider-btn')).not.toBeVisible();
    await expect(page.getByTestId('edit-capabilities-btn')).not.toBeVisible();
    await expect(page.getByTestId('health-override-btn')).not.toBeVisible();
    await expect(page.getByTestId('run-probe-btn')).not.toBeVisible();
    // Test send panel shows permission required notice
    await expect(page.getByText(/providers\.test_send/)).toBeVisible();

    // 2. Denied persona (platformSupport - no providers.* permissions)
    await context.clearCookies();
    await loginAsPersona(
      page,
      TEST_CREDENTIALS.platformSupport.email,
      TEST_CREDENTIALS.platformSupport.password,
    );

    // Navigation to /providers must show Access Forbidden boundary
    await page.getByRole('link', { name: 'Providers' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/providers'));
    await expect(page.getByRole('heading', { name: 'Access Forbidden' })).toBeVisible();
    // Zero provider names disclosed
    await expect(page.getByText('ACC Fixture SMS Primary')).not.toBeVisible();

    // Navigation to /channels must show Access Forbidden boundary
    await page.getByRole('link', { name: 'Channels' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/channels'));
    await expect(page.getByRole('heading', { name: 'Access Forbidden' })).toBeVisible();
    await expect(page.getByText('WhatsApp', { exact: true })).not.toBeVisible();
  });
});
