import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Portable screenshot output resolver:
 * Uses Playwright's testInfo.outputPath(...) as canonical portable destination,
 * and additionally mirrors to process.env.ACC_SCREENSHOT_DIR if explicitly configured.
 */
async function captureScreenshot(
  page: Page,
  testInfo: TestInfo,
  filename: string,
  options?: { fullPage?: boolean },
): Promise<string> {
  const outputPath = testInfo.outputPath(filename);
  await page.screenshot({ path: outputPath, fullPage: options?.fullPage });
  await testInfo.attach(filename, { path: outputPath, contentType: 'image/png' });

  const customDir = process.env.ACC_SCREENSHOT_DIR;
  if (customDir) {
    if (!existsSync(customDir)) {
      mkdirSync(customDir, { recursive: true });
    }
    copyFileSync(outputPath, path.join(customDir, filename));
  }
  return outputPath;
}

const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
const WORKSPACE_ID = 'ws-prod';

/**
 * Idempotent login and console shell preparation.
 */
async function loginToConsole(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => window.location.pathname === '/' || window.location.pathname.startsWith('/login'),
    { timeout: 10_000 },
  );

  if (page.url().includes('/login')) {
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email address').fill('admin@alendei.test');
    await page.getByLabel('Password').fill('any');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
  }

  // Ensure header and console shell are ready
  await page.waitForSelector('header', { timeout: 10_000 });
}

/**
 * Intercept mock auth and workspace routes for reliable offline / isolated E2E runs.
 */
async function setupMockRoutes(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname.endsWith('/auth/login') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { accessToken: 'synth-token-p8b', tokenType: 'Bearer', expiresIn: 3600 },
        }),
      });
    }

    if (pathname.endsWith('/auth/refresh') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { accessToken: 'synth-token-p8b', tokenType: 'Bearer', expiresIn: 3600 },
        }),
      });
    }

    if ((pathname.endsWith('/auth/me') || pathname.endsWith('/auth/user')) && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            userId: 'usr-p8b-01',
            email: 'admin@alendei.test',
            actorType: 'user',
            authMethod: 'session',
            sessionId: 'sess-p8b-1',
            authenticatedAt: new Date().toISOString(),
            tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
            authorizedOrganizationIds: [ORG_ID],
            roles: [],
            permissions: [],
          },
        }),
      });
    }

    if (
      (pathname.endsWith('/auth/me/authorization') || pathname.endsWith('/auth/authorization')) &&
      method === 'GET'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            actorType: 'user',
            userId: 'usr-p8b-01',
            apiKeyId: null,
            isPlatformAdmin: false,
            organizationIds: [ORG_ID],
            grants: [
              {
                roleId: 'role-admin',
                roleKey: 'org_admin',
                scopeType: 'organization',
                scopeId: ORG_ID,
                orgId: ORG_ID,
                permissions: [
                  'contacts.read',
                  'contacts.manage',
                  'messages.read',
                  'messages.send',
                  'templates.read',
                  'templates.manage',
                  'workspaces.read',
                  'channels.read',
                  'organizations.read',
                  'providers.read',
                ],
              },
            ],
          },
        }),
      });
    }

    if (pathname.endsWith('/organizations') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: ORG_ID,
              name: 'Acme Enterprise',
              slug: 'acme-enterprise',
              status: 'active',
              createdAt: '2026-10-15T10:00:00.000Z',
              updatedAt: '2026-10-15T10:00:00.000Z',
            },
          ],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    if (pathname.includes('/workspaces') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: WORKSPACE_ID,
              name: 'Production Workspace',
              slug: 'production-workspace',
              status: 'active',
              createdAt: '2026-10-15T10:00:00.000Z',
              updatedAt: '2026-10-15T10:00:00.000Z',
            },
          ],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    if (pathname.endsWith('/templates') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'tmpl-diwali-01',
              orgId: ORG_ID,
              channelId: 'ch-wa-01',
              name: 'diwali_sale_broadcast',
              body: 'Hello {{1}}, celebrate Diwali with 30% off across our catalog! Use code {{2}} at checkout.',
              variables: ['1', '2'],
              approvalStatus: 'approved',
              createdAt: '2026-11-01T08:00:00.000Z',
              updatedAt: '2026-11-01T08:00:00.000Z',
            },
            {
              id: 'tmpl-sms-flash',
              orgId: ORG_ID,
              channelId: 'ch-sms-01',
              name: 'black_friday_alert',
              body: 'Flash Sale Alert: 50% off select products for the next 6 hours only. Shop now: https://acc.io/s/bf26',
              variables: [],
              approvalStatus: 'approved',
              createdAt: '2026-11-02T10:00:00.000Z',
              updatedAt: '2026-11-02T10:00:00.000Z',
            },
          ],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    if (pathname.endsWith('/channels') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'ch-wa-01',
              code: 'whatsapp',
              displayName: 'WhatsApp Business',
              status: 'active',
            },
            { id: 'ch-sms-01', code: 'sms', displayName: 'SMS Gateway', status: 'active' },
            {
              id: 'ch-eml-01',
              code: 'email',
              displayName: 'Transactional Email',
              status: 'active',
            },
          ],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    // Default passthrough for any other api route
    return route.continue();
  });
}

test.describe('Phase 8B: Campaigns Module Frontend E2E', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockRoutes(page);
  });

  test('01: renders campaigns directory with KPI metrics, preview banner and table', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginToConsole(page);

    // Navigate to Campaigns via sidebar link
    const campaignsNavLink = page.getByRole('link', { name: 'Campaigns', exact: true });
    await expect(campaignsNavLink).toBeVisible();
    await campaignsNavLink.click();

    await page.waitForURL((url) => url.pathname === '/campaigns', { timeout: 10_000 });

    // Verify Heading and Subtitle
    await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
    await expect(page.getByText('Broadcast messaging orchestration')).toBeVisible();

    // Verify Backend Engine Blocker Banner
    await expect(page.getByText('Phase 8B Frontend Preview Mode')).toBeVisible();
    await expect(
      page.getByText('GET /workspaces/:id/campaigns, POST /workspaces/:id/campaigns'),
    ).toBeVisible();

    // Verify KPI Stat Cards
    await expect(page.getByText('Total Campaigns')).toBeVisible();
    await expect(page.getByText('Active Campaigns')).toBeVisible();
    await expect(page.getByText('Audience Reach')).toBeVisible();
    await expect(page.getByText('Delivered', { exact: true })).toBeVisible();
    await expect(page.getByText('Avg Delivery Rate')).toBeVisible();

    // Verify Sample Campaigns in Directory Table
    await expect(page.getByText('Diwali Festive Sale 2026')).toBeVisible();
    await expect(page.getByText('Black Friday Flash Sale Alert')).toBeVisible();
    await expect(page.getByText('Monthly Product Digest — November')).toBeVisible();

    // Capture Canonical Screenshot: 01-desktop-campaigns-directory.png
    await captureScreenshot(page, testInfo, '01-desktop-campaigns-directory.png');
  });

  test('02: filters campaigns directory by channel (WhatsApp)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginToConsole(page);

    // Navigate to /campaigns via sidebar link
    await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/campaigns');

    await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();

    // Select WhatsApp Channel Filter
    const channelSelect = page.locator('#campaigns-channel-select');
    await expect(channelSelect).toBeVisible();
    await channelSelect.selectOption('whatsapp');

    // Assert only WhatsApp campaigns are visible
    await expect(page.getByText('Diwali Festive Sale 2026')).toBeVisible();
    await expect(page.getByText('Black Friday Flash Sale Alert')).not.toBeVisible();

    // Capture Canonical Screenshot: 02-desktop-campaigns-filtered-whatsapp.png
    await captureScreenshot(page, testInfo, '02-desktop-campaigns-filtered-whatsapp.png');
  });

  test('03: opens campaign create dialog, selects real template and validates preview creation', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginToConsole(page);

    await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/campaigns');

    // Click "+ Create Campaign" button
    const createBtn = page.getByRole('button', { name: '+ Create Campaign' });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // Verify Dialog opened
    const dialogTitle = page.getByRole('heading', { name: 'Create Campaign' });
    await expect(dialogTitle).toBeVisible();
    await expect(page.getByText('⚠️ Phase 8B Frontend Preview')).toBeVisible();

    // Fill Campaign Name
    await page.getByLabel('Campaign Name *').fill('New Year Mega Broadcast 2027');
    await page.getByLabel('Description (Optional)').fill('VIP festive blast broadcast preview.');

    // Select Channel: WhatsApp via id
    await page.locator('#campaign-channel').selectOption('whatsapp');

    // Select Registered Template from real templates API via id
    await page
      .locator('#campaign-template')
      .selectOption({ label: 'diwali_sale_broadcast (approved)' });
    await expect(page.getByText('Template Preview:')).toBeVisible();

    // Select Audience: Segment by Contact Tag
    await page.getByRole('radio', { name: 'Segment by Contact Tag' }).click();
    await page.locator('#campaign-tag-select').selectOption('VIP');

    // Capture Canonical Screenshot: 03-desktop-campaign-create-dialog.png
    await captureScreenshot(page, testInfo, '03-desktop-campaign-create-dialog.png');

    // Submit dialog
    await page.getByRole('button', { name: 'Create Campaign (Preview)' }).click();

    // Verify Dialog closes and new campaign appears in table
    await expect(dialogTitle).not.toBeVisible();
    await expect(page.getByRole('link', { name: 'New Year Mega Broadcast 2027' })).toBeVisible();
  });

  test('04: renders campaign detail view with overview, KPI cards, and blocker notice', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginToConsole(page);

    // Client-side navigation from directory to detail page
    await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/campaigns');

    await page.getByRole('link', { name: 'Diwali Festive Sale 2026' }).click();
    await page.waitForURL((url) => url.pathname.includes('/campaigns/cmp-001'));

    // Verify Detail Page Header
    await expect(page.getByRole('heading', { name: 'Diwali Festive Sale 2026' })).toBeVisible();
    await expect(page.getByText('ID: cmp-001')).toBeVisible();

    // Verify Channel & Status Badges
    await expect(page.getByLabel('Channel: WhatsApp')).toBeVisible();
    await expect(page.getByText('Campaign Status: Completed')).toBeVisible();

    // Verify Backend Blocker Notice Banner
    await expect(page.getByText('Phase 8B Backend Execution Engine Pending')).toBeVisible();
    await expect(page.getByText('campaign_recipients')).toBeVisible();

    // Verify KPI Stat Cards
    await expect(page.getByText('24,500')).toBeVisible(); // Total target
    await expect(page.getByText('24,100')).toBeVisible(); // Dispatched
    await expect(page.getByText('23,650')).toBeVisible(); // Delivered
    await expect(page.getByText('98.1%').first()).toBeVisible(); // Delivery Rate

    // Verify Overview Tab is Active
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Campaign Configuration')).toBeVisible();
    await expect(page.getByText('Execution Progress')).toBeVisible();

    // Capture Canonical Screenshot: 04-desktop-campaign-detail-overview.png
    await captureScreenshot(page, testInfo, '04-desktop-campaign-detail-overview.png');
  });

  test('05: renders campaign detail template and compliance tabs', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginToConsole(page);

    // Navigate to campaign detail via directory link
    await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/campaigns');

    await page.getByRole('link', { name: 'Diwali Festive Sale 2026' }).click();
    await page.waitForURL((url) => url.pathname.includes('/campaigns/cmp-001'));

    // Switch to Template & Content Tab
    const templateTab = page.getByRole('tab', { name: 'Template & Content' });
    await expect(templateTab).toBeVisible();
    await templateTab.click();
    await expect(templateTab).toHaveAttribute('aria-selected', 'true');

    await expect(page.getByText('Raw Template Body')).toBeVisible();
    await expect(page.getByText('Rendered Preview (With Sample Variables)')).toBeVisible();
    await expect(page.getByText('Interpolated Variables')).toBeVisible();

    // Switch to Audience & Compliance Tab
    const audienceTab = page.getByRole('tab', { name: 'Audience & Compliance' });
    await expect(audienceTab).toBeVisible();
    await audienceTab.click();
    await expect(audienceTab).toHaveAttribute('aria-selected', 'true');

    // Verify Compliance Invariants
    await expect(page.getByText('Consent Verification Gate')).toBeVisible();
    await expect(page.getByText('Suppression List Filtering')).toBeVisible();

    // Capture Canonical Screenshot: 05-desktop-campaign-detail-configuration.png
    await captureScreenshot(page, testInfo, '05-desktop-campaign-detail-configuration.png');
  });

  test('06: renders campaigns directory on mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginToConsole(page);

    // Navigate to campaigns on desktop session
    await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/campaigns');

    // Switch viewport to mobile (iPhone SE: 375 x 667)
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(300);

    await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
    await expect(page.getByText('Phase 8B Frontend Preview Mode')).toBeVisible();

    // Capture Canonical Screenshot: 06-mobile-campaigns-directory.png
    await captureScreenshot(page, testInfo, '06-mobile-campaigns-directory.png');
  });
});
