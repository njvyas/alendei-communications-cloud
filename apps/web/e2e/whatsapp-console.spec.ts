import { expect, test, type Page } from '@playwright/test';
import { loginViaUi, TEST_CREDENTIALS } from './helpers/auth';

async function loginAsPersona(
  page: Page,
  email: string,
  password = TEST_CREDENTIALS.a1Admin.password,
) {
  await loginViaUi(page, email, password);
  const enterBtn = page.getByRole('button', { name: 'Enter Console' });
  if (await enterBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await enterBtn.click();
  }
}

test.describe('Phase 3.5 — WhatsApp Management Console (Gate E.5)', () => {
  test.describe.configure({ mode: 'serial' });

  // ---------------------------------------------------------------------------
  // E2E-WA-01: Direct route access control for zero-organization user
  // ---------------------------------------------------------------------------
  test('E2E-WA-01: Direct navigation to WhatsApp console routes enforces No Organization Access for zero-org user', async ({
    page,
  }) => {
    // Authenticated persona holding zero authorized organizations
    await loginAsPersona(page, TEST_CREDENTIALS.zeroOrg.email, TEST_CREDENTIALS.zeroOrg.password);

    // 1. Direct navigate to /templates
    await page.goto('/templates');
    await expect(page.getByRole('heading', { name: 'No Organization Access' })).toBeVisible();

    // 2. Direct navigate to /contacts
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: 'No Organization Access' })).toBeVisible();

    // 3. Direct navigate to /whatsapp
    await page.goto('/whatsapp');
    await expect(page.getByRole('heading', { name: 'No Organization Access' })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-WA-02: Tenant administrator navigates and views Templates section
  // ---------------------------------------------------------------------------
  test('E2E-WA-02: Tenant admin can view templates table and filter controls', async ({ page }) => {
    await loginAsPersona(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    // 1. Navigate to Templates via sidebar
    await page.getByRole('link', { name: 'Templates' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/templates'));
    await expect(page.getByRole('heading', { name: 'Message Templates' })).toBeVisible();

    // 2. Filter dropdown is available
    const filterSelect = page.locator('#filter-status');
    await expect(filterSelect).toBeVisible();

    // 3. Create Template button is visible for tenant manager
    await expect(page.getByTestId('create-template-btn')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-WA-03: Create template and execute simulated internal approval
  // ---------------------------------------------------------------------------
  test('E2E-WA-03: Create template and execute simulated approval transition', async ({ page }) => {
    await loginAsPersona(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    await page.getByRole('link', { name: 'Templates' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/templates'));

    // 1. Open create dialog
    await page.getByTestId('create-template-btn').click();
    await expect(page.getByRole('heading', { name: 'Create WhatsApp Template' })).toBeVisible();

    // 2. Fill form
    const templateName = `e2e_tpl_${Date.now()}`;
    await page.locator('#template-name').fill(templateName);
    await page.locator('#template-body').fill('Hello {{1}}, your order {{2}} has been confirmed.');

    // 3. Submit creation
    await page.getByRole('dialog').getByRole('button', { name: 'Create Template' }).click();

    // 4. Verify template row appears in table
    const table = page.getByTestId('templates-table');
    await expect(table.getByText(templateName)).toBeVisible({ timeout: 5000 });

    // 5. Simulate approval transitions: draft -> pending -> approved
    const row = table.locator('tr', { hasText: templateName });
    await row.getByRole('button', { name: 'Simulate Approval' }).click();

    await expect(page.getByRole('heading', { name: 'Simulate Template Approval' })).toBeVisible();
    await page.locator('#target-status').selectOption('pending');
    await page.getByRole('dialog').getByRole('button', { name: 'Apply State Change' }).click();

    // Verify row badge changes to Pending
    await expect(row.getByTestId('template-status-badge')).toContainText('Pending', {
      timeout: 5000,
    });

    // Now transition from pending -> approved
    await row.getByRole('button', { name: 'Simulate Approval' }).click();
    await expect(page.getByRole('heading', { name: 'Simulate Template Approval' })).toBeVisible();
    await page.locator('#target-status').selectOption('approved');
    await page.getByRole('dialog').getByRole('button', { name: 'Apply State Change' }).click();

    // 6. Verify row badge changes to Approved
    await expect(row.getByTestId('template-status-badge')).toContainText('Approved', {
      timeout: 5000,
    });
  });

  // ---------------------------------------------------------------------------
  // E2E-WA-04: Contact management and consent event recording
  // ---------------------------------------------------------------------------
  test('E2E-WA-04: Create contact with phone identity and record consent event', async ({
    page,
  }) => {
    await loginAsPersona(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/contacts'));
    await expect(page.getByRole('heading', { name: 'Contacts & Consent' })).toBeVisible();

    // 1. Open create contact modal
    const createBtn = page.getByTestId('create-contact-btn');
    await expect(createBtn).toBeVisible({ timeout: 5000 });
    await createBtn.click();
    await expect(page.getByRole('heading', { name: 'Create Workspace Contact' })).toBeVisible();

    const uniquePhone = `+1202555${Math.floor(1000 + Math.random() * 9000)}`;
    await page.locator('#contact-first-name').fill('Alice');
    await page.locator('#contact-last-name').fill('Tester');
    await page.locator('#contact-phone').fill(uniquePhone);
    await page.getByRole('dialog').getByRole('button', { name: 'Create Contact' }).click();

    // 2. Verify contact row appears
    const table = page.getByTestId('contacts-table');
    const contactRow = table.locator('tr', { hasText: 'Alice Tester' });
    await expect(contactRow).toBeVisible({ timeout: 5000 });

    // 3. Open consent dialog
    await contactRow.getByRole('button', { name: 'Manage Consent' }).click();
    await expect(page.getByRole('heading', { name: 'Record Consent Event' })).toBeVisible();

    // 4. Record consent event
    await page.getByRole('dialog').getByRole('button', { name: 'Record Consent' }).click();
    await expect(page.getByRole('heading', { name: 'Record Consent Event' })).not.toBeVisible({
      timeout: 5000,
    });
  });

  // ---------------------------------------------------------------------------
  // E2E-WA-05: WhatsApp Send-Test Console and settlement monitoring
  // ---------------------------------------------------------------------------
  test('E2E-WA-05: Dispatch WhatsApp message and inspect settlement timeline', async ({ page }) => {
    await loginAsPersona(page, TEST_CREDENTIALS.a1Admin.email, TEST_CREDENTIALS.a1Admin.password);

    await page.getByRole('link', { name: 'WhatsApp' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/whatsapp'));
    await expect(page.getByRole('heading', { name: 'WhatsApp Management Console' })).toBeVisible();

    // Verify form elements
    await expect(page.getByRole('button', { name: 'Send WhatsApp Message' })).toBeVisible();
    await expect(page.getByText('Idempotency Key:')).toBeVisible();

    // Switch to Custom Payload / Text for deterministic send
    await page.getByRole('button', { name: 'Custom Payload / Text' }).click();
    await page.locator('#send-recipient').fill('+12025550199');

    // Trigger dispatch
    await page.getByTestId('send-message-btn').click();

    // Verify settlement monitor appears with Message ID
    const monitor = page.getByTestId('attempt-history-card');
    await expect(monitor).toBeVisible({ timeout: 5000 });
    await expect(monitor.getByTestId('message-status-badge')).toBeVisible();
    await expect(monitor.getByTestId('attempts-table')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-WA-06: Direct route access control for tenant user lacking permissions
  // ---------------------------------------------------------------------------
  test('E2E-WA-06: Direct navigation to WhatsApp console routes enforces Access Forbidden for unauthorized tenant user', async ({
    page,
  }) => {
    // teamReader has tenant context (Org A1) but only holds read_only at team scope
    // (no templates.*, contacts.*, or messages.* permissions)
    await loginAsPersona(
      page,
      TEST_CREDENTIALS.teamReader.email,
      TEST_CREDENTIALS.teamReader.password,
    );

    // 1. Direct navigate to /templates
    await page.goto('/templates');
    await expect(page.getByRole('heading', { name: 'Access Forbidden' })).toBeVisible();

    // 2. Direct navigate to /contacts
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: 'Access Forbidden' })).toBeVisible();

    // 3. Direct navigate to /whatsapp
    await page.goto('/whatsapp');
    await expect(page.getByRole('heading', { name: 'Access Forbidden' })).toBeVisible();
  });
});
