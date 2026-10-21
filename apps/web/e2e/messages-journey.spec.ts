import { expect, test, type Page } from '@playwright/test';
import { assertNoTokensInStorage, loginViaUi, TEST_CREDENTIALS } from './helpers/auth';

/**
 * FE-3: Dispatched Messages Console Browser Journey (E2E)
 *
 * Verifies:
 * 1. Authentication and organization selection.
 * 2. Navigation to /messages.
 * 3. Default recipient address masking (+1 •••• 0199) and strict absence of reveal controls.
 * 4. Status filter interaction and pagination traversal.
 * 5. Detail inspection modal with attempt history and recipient masking.
 * 6. Organization switching and cross-tenant isolation enforcement.
 *
 * Runs against an isolated test stack using synthetic tenant fixtures.
 */
test.describe('FE-3: Dispatched Messages Console Journey', () => {
  test.describe.configure({ mode: 'serial' });

  const ORG_A1_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_A2_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';

  async function setupSyntheticApiRoutes(
    page: Page,
    options: { orgA1Id: string; orgA2Id: string },
  ) {
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const pathname = url.pathname;
      const headers = request.headers();
      const orgHeader = headers['x-acc-organization'];

      // 1. POST /auth/login
      if (pathname.endsWith('/auth/login') && method === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              accessToken: 'synthetic-jwt-operator-session',
              tokenType: 'Bearer',
              expiresIn: 3600,
            },
          }),
        });
      }

      // POST /auth/refresh
      if (pathname.endsWith('/auth/refresh') && method === 'POST') {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'AUTH_UNAUTHENTICATED', message: 'No active session' },
          }),
        });
      }

      // 2. GET /auth/me
      if (pathname.endsWith('/auth/me') && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              userId: 'usr-synthetic-01',
              email: TEST_CREDENTIALS.multiOrg.email,
              actorType: 'user',
              authMethod: 'session',
              sessionId: 'sess-synth-01',
              authenticatedAt: new Date().toISOString(),
              tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
              authorizedOrganizationIds: [options.orgA1Id, options.orgA2Id],
              roles: [],
              permissions: [],
            },
          }),
        });
      }

      // 3. GET /auth/me/authorization (and /auth/authorization fallback)
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
              userId: 'usr-synthetic-01',
              apiKeyId: null,
              isPlatformAdmin: false,
              organizationIds: [options.orgA1Id, options.orgA2Id],
              grants: [
                {
                  roleId: 'role-org-admin-1',
                  roleKey: 'org_admin',
                  scopeType: 'organization',
                  scopeId: options.orgA1Id,
                  orgId: options.orgA1Id,
                  permissions: [
                    'messages.read',
                    'messages.send',
                    'workspaces.read',
                    'channels.read',
                    'organizations.read',
                  ],
                },
                {
                  roleId: 'role-org-admin-2',
                  roleKey: 'org_admin',
                  scopeType: 'organization',
                  scopeId: options.orgA2Id,
                  orgId: options.orgA2Id,
                  permissions: [
                    'messages.read',
                    'messages.send',
                    'workspaces.read',
                    'channels.read',
                    'organizations.read',
                  ],
                },
              ],
            },
          }),
        });
      }

      // 4. GET /organizations
      if (pathname.endsWith('/organizations') && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [
              {
                id: options.orgA1Id,
                name: 'Acme Corp (Org A1)',
                slug: 'acme-corp',
                status: 'active',
                createdAt: '2026-10-15T10:00:00.000Z',
                updatedAt: '2026-10-15T10:00:00.000Z',
              },
              {
                id: options.orgA2Id,
                name: 'Beta Global (Org A2)',
                slug: 'beta-global',
                status: 'active',
                createdAt: '2026-10-15T10:00:00.000Z',
                updatedAt: '2026-10-15T10:00:00.000Z',
              },
            ],
            page: { hasMore: false, nextCursor: null, limit: 50 },
          }),
        });
      }

      // 5. GET /channels
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
                createdAt: '2026-10-15T10:00:00.000Z',
                updatedAt: '2026-10-15T10:00:00.000Z',
              },
              {
                id: 'ch-sms-01',
                code: 'sms',
                displayName: 'SMS Gateway',
                status: 'active',
                createdAt: '2026-10-15T10:00:00.000Z',
                updatedAt: '2026-10-15T10:00:00.000Z',
              },
            ],
            page: { hasMore: false, nextCursor: null, limit: 50 },
          }),
        });
      }

      // 6. GET /workspaces
      if (pathname.endsWith('/workspaces') && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [
              {
                id: 'ws-prod-01',
                orgId: orgHeader,
                name: 'Production Workspace',
                slug: 'prod',
                isDefault: true,
                status: 'active',
                createdAt: '2026-10-15T10:00:00.000Z',
                updatedAt: '2026-10-15T10:00:00.000Z',
              },
            ],
            page: { hasMore: false, nextCursor: null, limit: 50 },
          }),
        });
      }

      // 7. GET /messages/:id (Detail Inspection)
      const detailMatch = pathname.match(/\/messages\/([^/]+)$/);
      if (detailMatch && method === 'GET') {
        const msgId = detailMatch[1];
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: msgId,
              orgId: orgHeader ?? options.orgA1Id,
              workspaceId: 'ws-prod-01',
              contactId: 'ct-01',
              channelId: 'ch-wa-01',
              templateId: null,
              status: 'accepted',
              recipientAddress: '+12025550199',
              payload: { orderId: 'ORD-9988', customerRef: 'CUST-4421' },
              failureReason: null,
              createdAt: '2026-10-21T12:00:00.000Z',
              completedAt: '2026-10-21T12:00:02.000Z',
              attempts: [
                {
                  id: 'att-wa-01',
                  attemptNumber: 1,
                  providerId: 'prv-meta-wa-prod',
                  status: 'accepted',
                  failureReason: null,
                  latencyMs: 142,
                  completedAt: '2026-10-21T12:00:02.000Z',
                },
              ],
            },
          }),
        });
      }

      // 8. GET /messages (List with status, pagination, and tenant isolation)
      if (pathname.endsWith('/messages') && method === 'GET') {
        if (orgHeader === options.orgA1Id) {
          const statusFilter = url.searchParams.get('status');
          const cursor = url.searchParams.get('cursor');

          // Exercised filter: status === 'failed'
          if (statusFilter === 'failed') {
            return route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                data: [
                  {
                    id: 'msg-a1-02',
                    orgId: options.orgA1Id,
                    workspaceId: 'ws-prod-01',
                    contactId: 'ct-02',
                    channelId: 'ch-sms-01',
                    channelCode: 'sms',
                    templateId: null,
                    status: 'failed',
                    recipientAddress: '+447911123456',
                    failureReason: 'DESTINATION_UNREACHABLE',
                    attemptCount: 2,
                    createdAt: '2026-10-21T11:45:00.000Z',
                    completedAt: '2026-10-21T11:45:05.000Z',
                  },
                ],
                page: { hasMore: false, nextCursor: null, limit: 25 },
              }),
            });
          }

          // Exercised pagination: cursor === 'cur-page-2'
          if (cursor === 'cur-page-2') {
            return route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                data: [
                  {
                    id: 'msg-a1-page2-01',
                    orgId: options.orgA1Id,
                    workspaceId: 'ws-prod-01',
                    contactId: 'ct-03',
                    channelId: 'ch-wa-01',
                    channelCode: 'whatsapp',
                    templateId: null,
                    status: 'accepted',
                    recipientAddress: '+353871234567',
                    failureReason: null,
                    attemptCount: 1,
                    createdAt: '2026-10-21T10:30:00.000Z',
                    completedAt: '2026-10-21T10:30:02.000Z',
                  },
                ],
                page: { hasMore: false, nextCursor: null, limit: 25 },
              }),
            });
          }

          // Default Page 1 for Org A1
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: [
                {
                  id: 'msg-a1-01',
                  orgId: options.orgA1Id,
                  workspaceId: 'ws-prod-01',
                  contactId: 'ct-01',
                  channelId: 'ch-wa-01',
                  channelCode: 'whatsapp',
                  templateId: null,
                  status: 'accepted',
                  recipientAddress: '+12025550199',
                  failureReason: null,
                  attemptCount: 1,
                  createdAt: '2026-10-21T12:00:00.000Z',
                  completedAt: '2026-10-21T12:00:02.000Z',
                },
                {
                  id: 'msg-a1-02',
                  orgId: options.orgA1Id,
                  workspaceId: 'ws-prod-01',
                  contactId: 'ct-02',
                  channelId: 'ch-sms-01',
                  channelCode: 'sms',
                  templateId: null,
                  status: 'failed',
                  recipientAddress: '+447911123456',
                  failureReason: 'DESTINATION_UNREACHABLE',
                  attemptCount: 2,
                  createdAt: '2026-10-21T11:45:00.000Z',
                  completedAt: '2026-10-21T11:45:05.000Z',
                },
                {
                  id: 'msg-a1-03',
                  orgId: options.orgA1Id,
                  workspaceId: 'ws-prod-01',
                  contactId: 'ct-03',
                  channelId: 'ch-wa-01',
                  channelCode: 'whatsapp',
                  templateId: null,
                  status: 'queued',
                  recipientAddress: 'customer@acme-corp.com',
                  failureReason: null,
                  attemptCount: 0,
                  createdAt: '2026-10-21T11:30:00.000Z',
                  completedAt: null,
                },
              ],
              page: { hasMore: true, nextCursor: 'cur-page-2', limit: 25 },
            }),
          });
        }

        if (orgHeader === options.orgA2Id) {
          // Distinct Org A2 message partition
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: [
                {
                  id: 'msg-a2-01',
                  orgId: options.orgA2Id,
                  workspaceId: 'ws-prod-02',
                  contactId: 'ct-beta-01',
                  channelId: 'ch-wa-01',
                  channelCode: 'whatsapp',
                  templateId: null,
                  status: 'accepted',
                  recipientAddress: '+14155550188',
                  failureReason: null,
                  attemptCount: 1,
                  createdAt: '2026-10-21T09:00:00.000Z',
                  completedAt: '2026-10-21T09:00:02.000Z',
                },
              ],
              page: { hasMore: false, nextCursor: null, limit: 25 },
            }),
          });
        }
      }

      // Fallback
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
      });
    });
  }

  test('E2E-MSG-01: Full /messages journey — masking, filters, pagination, inspection, and tenant isolation', async ({
    page,
  }) => {
    // Intercept API layer with synthetic deterministic test fixtures
    await setupSyntheticApiRoutes(page, { orgA1Id: ORG_A1_ID, orgA2Id: ORG_A2_ID });

    // Step 1: Authenticate via login form
    await loginViaUi(page, TEST_CREDENTIALS.multiOrg.email, TEST_CREDENTIALS.multiOrg.password);

    // Step 2: Handle initial organization selection
    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    const initialOrgSelect = page.locator('#organization-select');
    await expect(initialOrgSelect).toBeVisible();
    await initialOrgSelect.selectOption(ORG_A1_ID);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // Verify Org A1 active in header
    await expect(page.locator('#org-select')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#org-select')).toHaveValue(ORG_A1_ID);

    // Step 3: Navigate to /messages via console navigation
    await page.getByRole('link', { name: 'Messages' }).click();
    await page.waitForURL((url) => url.pathname === '/messages');
    await expect(page.getByRole('heading', { name: 'Dispatched Messages' })).toBeVisible();

    // Step 4: Verify messages load with masked recipient addresses
    const table = page.getByTestId('messages-table');
    await expect(table).toBeVisible();

    // Verify row 1: WhatsApp message (+1 •••• 0199)
    const row1 = table.getByTestId('message-row-msg-a1-01');
    await expect(row1).toBeVisible();
    await expect(row1.getByTestId('masked-recipient-msg-a1-01')).toHaveText('+1 •••• 0199');
    await expect(row1.getByTestId('message-status-badge')).toContainText('PROVIDER_ACCEPTED');

    // Verify row 2: SMS message (+44 •••• 3456)
    const row2 = table.getByTestId('message-row-msg-a1-02');
    await expect(row2).toBeVisible();
    await expect(row2.getByTestId('masked-recipient-msg-a1-02')).toHaveText('+44 •••• 3456');
    await expect(row2.getByTestId('message-status-badge')).toContainText('FAILED');
    await expect(row2.getByText('DESTINATION_UNREACHABLE')).toBeVisible();

    // Verify row 3: Email message (c••••r@acme-corp.com)
    const row3 = table.getByTestId('message-row-msg-a1-03');
    await expect(row3).toBeVisible();
    await expect(row3.getByTestId('masked-recipient-msg-a1-03')).toHaveText('c••••r@acme-corp.com');
    await expect(row3.getByTestId('message-status-badge')).toContainText('QUEUED');

    // Privacy Invariant: Verify raw unmasked addresses are NOT present in the page
    const pageText = await page.locator('body').innerText();
    expect(pageText).not.toContain('+12025550199');
    expect(pageText).not.toContain('+447911123456');
    expect(pageText).not.toContain('customer@acme-corp.com');

    // Privacy Invariant: Verify NO reveal toggle controls are present in the table
    await expect(page.getByRole('button', { name: 'Reveal' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hide' })).toHaveCount(0);

    // Step 5: Exercise status filter ('failed')
    const statusSelect = page.locator('#filter-status');
    await expect(statusSelect).toBeVisible();
    await statusSelect.selectOption('failed');

    // Only failed message appears
    await expect(table.getByTestId('message-row-msg-a1-02')).toBeVisible();
    await expect(table.getByTestId('message-row-msg-a1-01')).toHaveCount(0);
    await expect(table.getByTestId('message-row-msg-a1-03')).toHaveCount(0);

    // Reset status filter
    await statusSelect.selectOption('all');
    await expect(table.getByTestId('message-row-msg-a1-01')).toBeVisible();

    // Step 6: Exercise pagination (Next / Previous)
    const nextBtn = page.getByRole('button', { name: 'Next', exact: true });
    const prevBtn = page.getByRole('button', { name: 'Previous', exact: true });

    await expect(nextBtn).toBeEnabled();
    await expect(prevBtn).toBeDisabled();

    // Click Next
    await nextBtn.click();
    await expect(table.getByTestId('message-row-msg-a1-page2-01')).toBeVisible();
    await expect(table.getByTestId('masked-recipient-msg-a1-page2-01')).toHaveText(
      '+353 •••• 4567',
    );
    await expect(table.getByTestId('message-row-msg-a1-01')).toHaveCount(0);
    await expect(prevBtn).toBeEnabled();

    // Click Previous -> back to page 1
    await prevBtn.click();
    await expect(table.getByTestId('message-row-msg-a1-01')).toBeVisible();

    // Step 7: Inspect message details
    await row1.getByTestId('inspect-message-btn-msg-a1-01').click();

    // Modal dialog is open and accessible
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Message Details' })).toBeVisible();

    // Verify recipient address in modal is masked
    const detailRecipient = dialog.getByTestId('detail-masked-recipient');
    await expect(detailRecipient).toBeVisible();
    await expect(detailRecipient).toHaveText('+1 •••• 0199');

    // Privacy Invariant: Unmasked recipient must NOT be displayed in detail view
    const dialogText = await dialog.innerText();
    expect(dialogText).not.toContain('+12025550199');

    // Privacy Invariant: NO reveal buttons in detail dialog
    await expect(dialog.getByRole('button', { name: 'Reveal' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Show' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Hide' })).toHaveCount(0);

    // Verify attempt history in modal
    const attemptsTable = dialog.getByTestId('attempts-table');
    await expect(attemptsTable).toBeVisible();
    await expect(attemptsTable.getByTestId('attempt-row-1')).toBeVisible();
    await expect(attemptsTable.getByText('142 ms')).toBeVisible();

    // Close modal
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible();

    // Step 8: Switch organization and verify cross-tenant data isolation
    let capturedOrgHeader: string | null = null;
    page.on('request', (req) => {
      const h = req.headers()['x-acc-organization'];
      if (h) {
        capturedOrgHeader = h;
      }
    });

    // Switch to Org A2 via header switcher
    await page.locator('#org-select').selectOption(ORG_A2_ID);
    await expect(page.locator('#org-select')).toHaveValue(ORG_A2_ID);

    // Verify requests sent to backend carry new tenant header
    await expect(table.getByTestId('message-row-msg-a2-01')).toBeVisible({ timeout: 5000 });
    expect(capturedOrgHeader).toBe(ORG_A2_ID);

    // Verify Org A1 data is completely absent from Org A2 console view
    await expect(table.getByTestId('message-row-msg-a1-01')).toHaveCount(0);
    await expect(table.getByTestId('message-row-msg-a1-02')).toHaveCount(0);
    await expect(table.getByTestId('message-row-msg-a1-03')).toHaveCount(0);
    await expect(table.getByTestId('masked-recipient-msg-a2-01')).toHaveText('+1 •••• 0188');

    // Final security storage sweep
    await assertNoTokensInStorage(page);
  });
});
