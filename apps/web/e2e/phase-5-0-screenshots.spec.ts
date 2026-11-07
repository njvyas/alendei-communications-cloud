import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Portable screenshot output resolver:
 * Uses Playwright's testInfo.outputPath(...) as the canonical portable destination,
 * and additionally mirrors to process.env.ACC_SCREENSHOT_DIR if configured.
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

/**
 * Idempotent login helper for synthetic mock route sessions.
 * Navigates directly to the console shell, handling both auto-refresh session bootstrap
 * and fallback manual login if unauthenticated.
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

  // Ensure the console shell and sidebar have loaded
  await page.waitForSelector('nav[aria-label="Sections"]', { timeout: 10_000 });
}

const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';

const mockMessages = [
  {
    id: 'msg-p50-01',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-1',
    channelId: 'ch-wa-01',
    channelCode: 'whatsapp',
    templateId: 'tmpl-order-update',
    status: 'accepted',
    recipientAddress: '+12025550199',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-11-07T10:14:00.000Z',
    completedAt: '2026-11-07T10:14:02.000Z',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-07T10:14:05.000Z',
    readAt: '2026-11-07T10:15:30.000Z',
  },
  {
    id: 'msg-p50-02',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-2',
    channelId: 'ch-sms-01',
    channelCode: 'sms',
    templateId: null,
    status: 'accepted',
    recipientAddress: '+447911123456',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-11-07T10:12:00.000Z',
    completedAt: '2026-11-07T10:12:02.000Z',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-07T10:12:10.000Z',
    readAt: null,
  },
  {
    id: 'msg-p50-03',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-3',
    channelId: 'ch-wa-01',
    channelCode: 'whatsapp',
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550188',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-11-07T10:10:00.000Z',
    completedAt: '2026-11-07T10:10:02.000Z',
    deliveryStatus: 'pending',
    deliveredAt: null,
    readAt: null,
  },
  {
    id: 'msg-p50-04',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-4',
    channelId: 'ch-sms-01',
    channelCode: 'sms',
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550177',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-11-07T10:08:00.000Z',
    completedAt: '2026-11-07T10:08:02.000Z',
    deliveryStatus: 'undelivered',
    deliveredAt: null,
    readAt: null,
  },
  {
    id: 'msg-p50-05',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-5',
    channelId: 'ch-voice-01',
    channelCode: 'voice',
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550166',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-11-07T10:06:00.000Z',
    completedAt: '2026-11-07T10:06:02.000Z',
    deliveryStatus: 'not_supported',
    deliveredAt: null,
    readAt: null,
  },
  {
    id: 'msg-p50-06',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-6',
    channelId: 'ch-wa-01',
    channelCode: 'whatsapp',
    templateId: null,
    status: 'failed',
    recipientAddress: '+12025550155',
    failureReason: 'PROVIDER_TIMEOUT',
    attemptCount: 2,
    createdAt: '2026-11-07T10:04:00.000Z',
    completedAt: '2026-11-07T10:04:06.000Z',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-07T10:04:12.000Z',
    readAt: null,
  },
  {
    id: 'msg-p50-07',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-7',
    channelId: 'ch-sms-01',
    channelCode: 'sms',
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550144',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-10-20T10:00:00.000Z',
    completedAt: '2026-10-20T10:00:02.000Z',
    deliveryStatus: null,
    deliveredAt: null,
    readAt: null,
  },
];

const mockDetails: Record<string, unknown> = {
  'msg-p50-01': {
    id: 'msg-p50-01',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-1',
    channelId: 'ch-wa-01',
    templateId: 'tmpl-order-update',
    status: 'accepted',
    recipientAddress: '+12025550199',
    payload: {
      templateName: 'order_update',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'ORD-9821' }] }],
    },
    failureReason: null,
    createdAt: '2026-11-07T10:14:00.000Z',
    completedAt: '2026-11-07T10:14:02.000Z',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-07T10:14:05.000Z',
    readAt: '2026-11-07T10:15:30.000Z',
    attempts: [
      {
        id: 'att-p50-01-1',
        attemptNumber: 1,
        providerId: 'prv-meta-wa-01',
        status: 'accepted',
        failureReason: null,
        latencyMs: 138,
        completedAt: '2026-11-07T10:14:02.000Z',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-11-07T10:14:05.000Z',
        readAt: '2026-11-07T10:15:30.000Z',
        providerMessageId: 'wamid.HBgLMTEwMDAwMDAwMBICABEYEjFDNDhGOUU4NDUzM0IwMDYA',
      },
    ],
  },
  'msg-p50-06': {
    id: 'msg-p50-06',
    orgId: ORG_ID,
    workspaceId: 'ws-1',
    contactId: 'ct-6',
    channelId: 'ch-wa-01',
    templateId: null,
    status: 'failed',
    recipientAddress: '+12025550155',
    payload: { text: 'Time-critical alert' },
    failureReason: 'PROVIDER_TIMEOUT',
    createdAt: '2026-11-07T10:04:00.000Z',
    completedAt: '2026-11-07T10:04:06.000Z',
    deliveryStatus: 'delivered',
    deliveredAt: '2026-11-07T10:04:12.000Z',
    readAt: null,
    attempts: [
      {
        id: 'att-p50-06-1',
        attemptNumber: 1,
        providerId: 'prv-meta-wa-01',
        status: 'outcome_unknown',
        failureReason: 'GATEWAY_TIMEOUT',
        latencyMs: 3000,
        completedAt: '2026-11-07T10:04:03.000Z',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-11-07T10:04:12.000Z',
        readAt: null,
        providerMessageId: 'wamid.HBgL5550155META01',
      },
      {
        id: 'att-p50-06-2',
        attemptNumber: 2,
        providerId: 'prv-meta-wa-02',
        status: 'failed',
        failureReason: 'CIRCUIT_OPEN',
        latencyMs: 12,
        completedAt: '2026-11-07T10:04:06.000Z',
        deliveryStatus: 'pending',
        deliveredAt: null,
        readAt: null,
        providerMessageId: null,
      },
    ],
  },
};

async function setupRoutes(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const pathname = url.pathname;

    if (pathname.endsWith('/auth/login') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { accessToken: 'synth-token-p50', tokenType: 'Bearer', expiresIn: 3600 },
        }),
      });
    }

    if (pathname.endsWith('/auth/refresh') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { accessToken: 'synth-token-p50', tokenType: 'Bearer', expiresIn: 3600 },
        }),
      });
    }

    if (pathname.endsWith('/auth/me') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            userId: 'usr-p50-01',
            email: 'admin@alendei.test',
            actorType: 'user',
            authMethod: 'session',
            sessionId: 'sess-p50-1',
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
            userId: 'usr-p50-01',
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
            { id: 'ch-voice-01', code: 'voice', displayName: 'Voice Dispatch', status: 'active' },
          ],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    if (pathname.endsWith('/workspaces') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ id: 'ws-1', name: 'Primary Workspace', orgId: ORG_ID, status: 'active' }],
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
              id: 'tmpl-order-update',
              name: 'order_update',
              channelId: 'ch-wa-01',
              approvalStatus: 'approved',
              category: 'UTILITY',
              language: 'en_US',
              components: [{ type: 'BODY', text: 'Your order {{1}} is confirmed.' }],
            },
          ],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    if (pathname.endsWith('/providers') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 'prv-meta-wa-01', name: 'Meta Cloud API Direct', channelCode: 'whatsapp' },
            { id: 'prv-meta-wa-02', name: 'Meta Cloud API Fallback', channelCode: 'whatsapp' },
          ],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    // Detail route: /messages/:id
    const msgDetailMatch = pathname.match(/\/messages\/([^/?]+)$/);
    if (msgDetailMatch && method === 'GET') {
      const msgId = msgDetailMatch[1];
      const detail = mockDetails[msgId] || {
        ...mockMessages[0],
        attempts: [],
        payload: {},
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: detail }),
      });
    }

    // List route: /messages
    if (pathname.endsWith('/messages') && method === 'GET') {
      const deliveryStatusFilter = url.searchParams.get('deliveryStatus');
      let filtered = mockMessages;
      if (deliveryStatusFilter) {
        filtered = mockMessages.filter((m) => m.deliveryStatus === deliveryStatusFilter);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: filtered,
          page: { hasMore: false, nextCursor: null, limit: 25 },
        }),
      });
    }

    return route.continue();
  });
}

test.describe('ACC Phase 5.0 Visual Showcase & Screenshots', () => {
  test('1. Capture Desktop View of Dispatched Messages Table with Two-Axis Delivery Outcomes', async ({
    page,
  }, testInfo) => {
    await setupRoutes(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await loginToConsole(page);

    // Navigate to /messages via sidebar link
    await page.getByRole('link', { name: 'Messages' }).click();
    await page.waitForURL((url) => url.pathname === '/messages');
    await page.waitForSelector('[data-testid="messages-table"]');
    await page.waitForSelector('[data-testid="message-row-msg-p50-01"]');

    // Screenshot 1: Desktop Messages Table (Two-Axis Model)
    await captureScreenshot(page, testInfo, '01-desktop-messages-table.png', { fullPage: true });

    // Filter by Delivery Status: "delivered"
    const deliveryFilter = page.locator('[data-testid="filter-delivery-status"]');
    await deliveryFilter.selectOption('delivered');
    await page.waitForTimeout(500);

    // Screenshot 2: Delivery Filter Applied (Delivered messages only)
    await captureScreenshot(page, testInfo, '02-desktop-delivery-filter-delivered.png', {
      fullPage: true,
    });

    // Reset filter to all
    await deliveryFilter.selectOption('all');
    await page.waitForTimeout(300);

    // Open Message Details for msg-p50-01 (Delivered + Read Receipt)
    await page.locator('[data-testid="inspect-message-btn-msg-p50-01"]').click();
    await page.waitForSelector('#message-detail-title');
    await page.waitForSelector('[data-testid="detail-header-badges"]');

    // Screenshot 3: Message Detail Dialog (Delivered + Read + Attempt Provider Message ID)
    await captureScreenshot(page, testInfo, '03-desktop-message-detail-delivered-read.png');

    // Close modal
    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(300);

    // Open Message Details for msg-p50-06 (Two-Axis Honesty: Failed Submission with Late Delivery)
    await page.locator('[data-testid="inspect-message-btn-msg-p50-06"]').click();
    await page.waitForSelector('#message-detail-title');
    await page.waitForSelector('[data-testid="detail-header-badges"]');

    // Screenshot 4: Message Detail Dialog (Failed Submission with Late Positive Delivery Outcome)
    await captureScreenshot(page, testInfo, '04-desktop-message-detail-failed-late-delivery.png');

    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(300);

    // Navigate to /whatsapp and inspect msg-p50-01
    await page.getByRole('link', { name: 'WhatsApp', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/whatsapp');
    await page.waitForSelector('#manual-msg-id');
    await page.locator('#manual-msg-id').fill('msg-p50-01');
    await page.getByRole('button', { name: 'Load Message' }).click();
    await page.waitForSelector('[data-testid="attempt-history-card"]');
    await page.waitForTimeout(300);

    // Screenshot 5: Desktop WhatsApp Settlement Monitor Card
    await captureScreenshot(page, testInfo, '05-desktop-whatsapp-settlement-monitor.png', {
      fullPage: true,
    });
  });

  test('2. Capture Tablet and Mobile Responsive Views', async ({ page }, testInfo) => {
    await setupRoutes(page);

    // Tablet Viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await loginToConsole(page);
    await page.getByRole('link', { name: 'Messages' }).click();
    await page.waitForURL((url) => url.pathname === '/messages');
    await page.waitForSelector('[data-testid="messages-table"]');

    // Assert tablet visibility of delivery filter and outcomes
    await expect(page.locator('[data-testid="filter-delivery-status"]')).toBeVisible();
    await expect(page.locator('[data-testid="delivery-cell-msg-p50-01"]')).toBeVisible();

    // Screenshot 6: Tablet Messages Table
    await captureScreenshot(page, testInfo, '06-tablet-messages-table.png', { fullPage: true });

    // Mobile Viewport
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await page.waitForSelector('[data-testid="messages-table"]');

    // Assert mobile layout elements and responsive interactions
    await expect(page.locator('[data-testid="filter-delivery-status"]')).toBeVisible();
    await expect(page.locator('[data-testid="messages-table"]')).toBeVisible();

    // Open detail dialog on mobile to verify responsive modal layout
    await page.locator('[data-testid="inspect-message-btn-msg-p50-01"]').click();
    await page.waitForSelector('#message-detail-title');
    await expect(page.locator('[data-testid="detail-header-badges"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Screenshot 7: Mobile Messages Table
    await captureScreenshot(page, testInfo, '07-mobile-messages-table.png', { fullPage: true });
  });
});
