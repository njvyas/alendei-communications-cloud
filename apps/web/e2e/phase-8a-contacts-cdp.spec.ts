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
const WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-ws000000001';

const mockContacts = [
  {
    id: '01955b0a-7b3b-7411-9a4f-ct000000001',
    workspaceId: WORKSPACE_ID,
    firstName: 'Sarah',
    lastName: 'Connor',
    metadata: {
      tags: ['VIP', 'Customer', 'Beta-Tester'],
      company: 'Cyberdyne Systems',
      accountTier: 'Enterprise',
      lifetimeValue: 45000,
      activeContract: true,
    },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T12:00:00.000Z',
  },
  {
    id: '01955b0a-7b3b-7411-9a4f-ct000000002',
    workspaceId: WORKSPACE_ID,
    firstName: 'John',
    lastName: 'Connor',
    metadata: {
      tags: ['Lead', 'High-Priority'],
      department: 'Resistance Operations',
      clearanceLevel: 5,
    },
    createdAt: '2026-11-03T14:30:00.000Z',
    updatedAt: '2026-11-03T14:30:00.000Z',
  },
  {
    id: '01955b0a-7b3b-7411-9a4f-ct000000003',
    workspaceId: WORKSPACE_ID,
    firstName: 'Kyle',
    lastName: 'Reese',
    metadata: {
      tags: ['Wholesale', 'Partner'],
      partnerTier: 'Tier 1',
    },
    createdAt: '2026-11-04T09:15:00.000Z',
    updatedAt: '2026-11-04T09:15:00.000Z',
  },
];

const mockIdentities = [
  {
    id: '01955b0a-7b3b-7411-9a4f-idnt0000001',
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: 'ch-wa-01',
    rawAddress: '+12025550199',
    normalizedAddress: '+12025550199',
    isPrimary: true,
    status: 'active',
    createdAt: '2026-11-01T10:05:00.000Z',
    updatedAt: '2026-11-01T10:05:00.000Z',
  },
  {
    id: '01955b0a-7b3b-7411-9a4f-idnt0000002',
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: 'ch-sms-01',
    rawAddress: '+12025550198',
    normalizedAddress: '+12025550198',
    isPrimary: false,
    status: 'active',
    createdAt: '2026-11-01T10:06:00.000Z',
    updatedAt: '2026-11-01T10:06:00.000Z',
  },
  {
    id: '01955b0a-7b3b-7411-9a4f-idnt0000003',
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: 'ch-eml-01',
    rawAddress: 'sarah.connor@cyberdyne.example',
    normalizedAddress: 'sarah.connor@cyberdyne.example',
    isPrimary: false,
    status: 'active',
    createdAt: '2026-11-01T10:07:00.000Z',
    updatedAt: '2026-11-01T10:07:00.000Z',
  },
];

const mockConsentEvents = [
  {
    id: 'cns-01',
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: 'ch-wa-01',
    consentType: 'marketing',
    event: 'grant',
    occurredAt: '2026-11-01T10:05:00.000Z',
    source: 'web_form',
    createdAt: '2026-11-01T10:05:00.000Z',
  },
  {
    id: 'cns-02',
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: 'ch-sms-01',
    consentType: 'marketing',
    event: 'grant',
    occurredAt: '2026-11-01T10:06:00.000Z',
    source: 'api',
    createdAt: '2026-11-01T10:06:00.000Z',
  },
];

async function setupRoutes(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (pathname.endsWith('/auth/login') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { accessToken: 'synth-token-p8a', tokenType: 'Bearer', expiresIn: 3600 },
        }),
      });
    }

    if (pathname.endsWith('/auth/refresh') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { accessToken: 'synth-token-p8a', tokenType: 'Bearer', expiresIn: 3600 },
        }),
      });
    }

    if ((pathname.endsWith('/auth/me') || pathname.endsWith('/auth/user')) && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            userId: 'usr-p8a-01',
            email: 'admin@alendei.test',
            actorType: 'user',
            authMethod: 'session',
            sessionId: 'sess-p8a-1',
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
            userId: 'usr-p8a-01',
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

    if (pathname.endsWith('/workspaces') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ id: WORKSPACE_ID, name: 'Primary Workspace', orgId: ORG_ID, status: 'active' }],
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    // Contacts list: /workspaces/:workspaceId/contacts
    if (pathname.includes('/workspaces/') && pathname.endsWith('/contacts') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: mockContacts,
          page: { hasMore: false, nextCursor: null, limit: 50 },
        }),
      });
    }

    // Contact identities: /contacts/:id/identities
    const identitiesMatch = pathname.match(/\/contacts\/([^/?]+)\/identities$/);
    if (identitiesMatch && method === 'GET') {
      const contactId = identitiesMatch[1];
      const items = mockIdentities.filter((i) => i.contactId === contactId);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: items }),
      });
    }

    // Consent events: /contacts/:id/consent-events
    const consentMatch = pathname.match(/\/contacts\/([^/?]+)\/consent-events$/);
    if (consentMatch && method === 'GET') {
      const contactId = consentMatch[1];
      const items = mockConsentEvents.filter((c) => c.contactId === contactId);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: items }),
      });
    }

    // Consent effective: /contacts/:id/consent-effective
    if (pathname.includes('/consent-effective') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { status: 'opted_in', reason: 'Explicit opt-in received' },
        }),
      });
    }

    // Domain resolution: /domains/resolve
    if (pathname.includes('/domains/resolve') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { resolved: false, domain: null },
        }),
      });
    }

    // Single contact: /contacts/:id
    const contactDetailMatch = pathname.match(/\/contacts\/([^/?]+)$/);
    if (contactDetailMatch && method === 'GET') {
      const contactId = contactDetailMatch[1];
      const contact = mockContacts.find((c) => c.id === contactId) || mockContacts[0];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: contact }),
      });
    }

    if (contactDetailMatch && method === 'PATCH') {
      const contactId = contactDetailMatch[1];
      const body = route.request().postDataJSON();
      const idx = mockContacts.findIndex((c) => c.id === contactId);
      const target = idx !== -1 ? mockContacts[idx]! : mockContacts[0]!;
      const updated = {
        ...target,
        ...body,
        metadata: {
          ...(target.metadata ?? {}),
          ...(body.metadata ?? {}),
        },
        updatedAt: new Date().toISOString(),
      };
      if (idx !== -1) {
        mockContacts[idx] = updated;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: updated }),
      });
    }

    return route.continue();
  });
}

test.describe('Phase 8A — Contacts & CDP Frontend Vertical Slice', () => {
  test('1. Capture Desktop Contacts Directory & Tag Filter', async ({ page }, testInfo) => {
    await setupRoutes(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await loginToConsole(page);

    // Navigate to /contacts via sidebar link
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.waitForURL((url) => url.pathname === '/contacts');
    await page.waitForSelector('[data-testid="contacts-table"]');
    await page.waitForSelector('[data-testid="contact-row-01955b0a-7b3b-7411-9a4f-ct000000001"]');

    // Screenshot 1: Desktop Contacts Directory with CDP Tags and Profile Links
    await captureScreenshot(page, testInfo, '01-desktop-contacts-list-cdp.png', { fullPage: true });

    // Filter by CDP Tag: "VIP"
    const tagFilter = page.locator('[data-testid="filter-contact-tag"]');
    await tagFilter.selectOption('VIP');
    await page.waitForTimeout(300);

    // Screenshot 2: Contacts Directory filtered by CDP Tag
    await captureScreenshot(page, testInfo, '02-desktop-contacts-tag-filtered.png', {
      fullPage: true,
    });
  });

  test('2. Capture Contact Profile Overview, Timeline, and Mobile Views', async ({
    page,
  }, testInfo) => {
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message, err.stack));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
    });
    await setupRoutes(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    await loginToConsole(page);

    // Navigate to /contacts via sidebar link, then open profile via client-side routing
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.waitForURL((url) => url.pathname === '/contacts');
    await page.waitForSelector('[data-testid="contact-row-01955b0a-7b3b-7411-9a4f-ct000000001"]');

    await page
      .locator('[data-testid="profile-contact-btn-01955b0a-7b3b-7411-9a4f-ct000000001"]')
      .click();
    await page.waitForURL((url) =>
      url.pathname.includes('/contacts/01955b0a-7b3b-7411-9a4f-ct000000001'),
    );
    await page.waitForSelector('[data-testid="contact-profile-view"]');
    await page.waitForSelector('[data-testid="contact-identities-card"]');
    await page.waitForSelector('[data-testid="contact-tags-card"]');
    await page.waitForSelector('[data-testid="contact-custom-fields-card"]');

    // Screenshot 3: Full CDP Profile Overview (Hero, Metric Bar, Channel Identities, Tags, Custom Fields)
    await captureScreenshot(page, testInfo, '03-desktop-contact-profile-overview.png', {
      fullPage: true,
    });

    // Switch to Activity Timeline tab
    await page.getByRole('tab', { name: 'Activity Timeline' }).click();
    await page.waitForSelector('[data-testid="activity-timeline"]');

    // 1. Verify Message category filter has 0 count and shows honest empty state
    const msgFilter = page.locator('[data-testid="filter-timeline-message"]');
    await expect(msgFilter).toContainText('(0)');
    await msgFilter.click();
    await page.waitForSelector('[data-testid="timeline-empty-messages"]');
    await expect(page.locator('[data-testid="timeline-empty-messages"]')).toContainText(
      'Historical message activity not yet available',
    );
    await captureScreenshot(
      page,
      testInfo,
      '04b-desktop-contact-profile-timeline-empty-messages.png',
    );

    // Return to All Activities tab
    await page.locator('[data-testid="filter-timeline-all"]').click();
    await page.waitForSelector('[data-testid="activity-timeline"]');
    await page.waitForTimeout(300);

    // Screenshot 4: Contact Activity & Engagement Timeline with authentic touchpoints
    await captureScreenshot(page, testInfo, '04-desktop-contact-profile-timeline.png', {
      fullPage: true,
    });

    // 2. Validate frontend PATCH request handling and simulated reload persistence
    // Note: The Playwright test intercepts API calls and updates an in-memory mock fixture.
    // This validates client mutation dispatch, query cache invalidation, and frontend state
    // reconstruction across page reloads, rather than live backend/database persistence.
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.waitForSelector('[data-testid="contact-tags-card"]');
    await page.waitForSelector('[data-testid="contact-custom-fields-card"]');

    // Add a new tag: Wholesale-Partner
    await page.locator('[data-testid="add-tag-input"]').fill('Wholesale-Partner');
    await page.locator('[data-testid="add-tag-btn"]').click();
    await expect(page.locator('[data-testid="contact-tag-wholesale-partner"]')).toBeVisible();

    // Add a new custom field: securityClearance = Tier-4
    await page.locator('[data-testid="add-custom-field-btn"]').click();
    await page.locator('#cf-key-input').fill('securityClearance');
    await page.locator('#cf-val-input').fill('Tier-4');
    await page.locator('[data-testid="save-custom-field-btn"]').click();
    const customFieldsCard = page.locator('[data-testid="contact-custom-fields-card"]');
    await expect(customFieldsCard.getByText('securityClearance', { exact: true })).toBeVisible();
    await expect(customFieldsCard.getByText('Tier-4', { exact: true })).toBeVisible();

    // Reload the page and assert frontend state reconstruction from simulated persistence
    await page.reload();
    await page.waitForSelector('[data-testid="contact-profile-view"]');
    await expect(page.locator('[data-testid="contact-tag-wholesale-partner"]')).toBeVisible();
    const customFieldsCardAfterReload = page.locator('[data-testid="contact-custom-fields-card"]');
    await expect(
      customFieldsCardAfterReload.getByText('securityClearance', { exact: true }),
    ).toBeVisible();
    await expect(customFieldsCardAfterReload.getByText('Tier-4', { exact: true })).toBeVisible();

    // Mobile Viewport: 375x812
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);

    // Screenshot 5: Responsive Mobile Contact Profile
    await captureScreenshot(page, testInfo, '05-mobile-contact-profile.png', {
      fullPage: true,
    });
  });
});
