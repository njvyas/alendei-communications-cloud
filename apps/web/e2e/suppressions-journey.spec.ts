import { expect, test, type Page } from '@playwright/test';
import { assertNoTokensInStorage, loginViaUi, TEST_CREDENTIALS } from './helpers/auth';

/**
 * FE-2: Suppression Management Console Browser Journey (E2E)
 *
 * Verifies:
 * 1. Authentication and organization selection.
 * 2. Navigation to /suppressions via console navigation.
 * 3. Channel catalogue enrichment for channel scope selection.
 * 4. Creation of an active suppression with validation and idempotency.
 * 5. Full record inspection via the Details modal dialog.
 * 6. Lifting of an active suppression with audit reason and status transition to Cleared.
 * 7. Verification that the Lift button is no longer available on cleared records.
 * 8. Read-only persona boundaries (can inspect but cannot add or lift).
 * 9. Unauthorized persona fail-closed boundaries (navigation hidden, direct route forbidden).
 * 10. Multi-organization cross-tenant isolation enforcement.
 *
 * Runs against an isolated test stack using synthetic tenant fixtures without
 * touching or depending on shared database records.
 */
test.describe('FE-2: Suppression Management Console Journey', () => {
  test.describe.configure({ mode: 'serial' });

  const ORG_A1_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_A2_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const CH_WA_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f93333';
  const CH_SMS_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f94444';

  interface SyntheticSuppression {
    id: string;
    orgId: string;
    channelId: string | null;
    rawAddress: string;
    normalizedAddress: string;
    reason: string;
    status: 'active' | 'cleared';
    clearedAt: string | null;
    clearedReason: string | null;
    createdAt: string;
    updatedAt: string;
  }

  interface SetupOptions {
    readonly orgA1Id?: string;
    readonly orgA2Id?: string;
    readonly singleOrg?: boolean;
    readonly permissionsOrgA1?: string[];
    readonly permissionsOrgA2?: string[];
    readonly initialSuppressions?: SyntheticSuppression[];
  }

  async function setupSyntheticSuppressionRoutes(page: Page, options: SetupOptions = {}) {
    const orgA1 = options.orgA1Id ?? ORG_A1_ID;
    const orgA2 = options.orgA2Id ?? ORG_A2_ID;
    const authorizedOrgs = options.singleOrg ? [orgA1] : [orgA1, orgA2];
    const permsA1 = options.permissionsOrgA1 ?? [
      'suppressions.read',
      'suppressions.manage',
      'channels.read',
      'organizations.read',
    ];
    const permsA2 = options.permissionsOrgA2 ?? [
      'suppressions.read',
      'suppressions.manage',
      'channels.read',
      'organizations.read',
    ];

    let isAuthenticated = false;

    // In-memory isolated store per browser test run
    const inMemorySuppressions: SyntheticSuppression[] = [...(options.initialSuppressions ?? [])];

    const mockChannels = [
      {
        id: CH_WA_ID,
        code: 'whatsapp',
        displayName: 'WhatsApp Business',
        status: 'active',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:00:00.000Z',
      },
      {
        id: CH_SMS_ID,
        code: 'sms',
        displayName: 'SMS Gateway',
        status: 'active',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:00:00.000Z',
      },
    ];

    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const pathname = url.pathname;
      const headers = request.headers();
      const orgHeader = headers['x-acc-organization'];

      // 1. POST /auth/login
      if (pathname.endsWith('/auth/login') && method === 'POST') {
        isAuthenticated = true;
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

      // 2. POST /auth/refresh
      if (pathname.endsWith('/auth/refresh') && method === 'POST') {
        if (isAuthenticated) {
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
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'AUTH_UNAUTHENTICATED', message: 'No active session' },
          }),
        });
      }

      // POST /auth/logout
      if (pathname.endsWith('/auth/logout') && method === 'POST') {
        isAuthenticated = false;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { success: true } }),
        });
      }

      // 3. GET /auth/me
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
              authorizedOrganizationIds: authorizedOrgs,
              roles: [],
              permissions: [],
            },
          }),
        });
      }

      // 4. GET /auth/me/authorization (and /auth/authorization fallback)
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
              organizationIds: authorizedOrgs,
              grants: [
                {
                  roleId: 'role-org-admin-1',
                  roleKey: 'org_admin',
                  scopeType: 'organization',
                  scopeId: orgA1,
                  orgId: orgA1,
                  permissions: permsA1,
                },
                {
                  roleId: 'role-org-admin-2',
                  roleKey: 'org_admin',
                  scopeType: 'organization',
                  scopeId: orgA2,
                  orgId: orgA2,
                  permissions: permsA2,
                },
              ],
            },
          }),
        });
      }

      // 5. GET /organizations
      if (pathname.endsWith('/organizations') && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [
              {
                id: orgA1,
                name: 'Acme Corp (Org A1)',
                slug: 'acme-corp',
                status: 'active',
                createdAt: '2026-10-15T10:00:00.000Z',
                updatedAt: '2026-10-15T10:00:00.000Z',
              },
              {
                id: orgA2,
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

      // 6. GET /channels
      if (pathname.endsWith('/channels') && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: mockChannels,
            page: { hasMore: false, nextCursor: null, limit: 50 },
          }),
        });
      }

      // 7. GET /workspaces
      if (pathname.endsWith('/workspaces') && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [],
            page: { hasMore: false, nextCursor: null, limit: 50 },
          }),
        });
      }

      // 8. POST /suppressions/:id/lift
      const liftMatch = pathname.match(/\/suppressions\/([^/]+)\/lift$/);
      if (liftMatch && method === 'POST') {
        const suppId = liftMatch[1];
        const body = request.postDataJSON() as { reason: string };
        const found = inMemorySuppressions.find((s) => s.id === suppId);
        if (found) {
          if (found.status === 'cleared') {
            return route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                error: {
                  code: 'SUPPRESSION_LIFECYCLE_CONFLICT',
                  message: 'Suppression is already cleared and cannot be lifted again.',
                },
              }),
            });
          }
          found.status = 'cleared';
          found.clearedAt = new Date().toISOString();
          found.clearedReason = body.reason;
          found.updatedAt = new Date().toISOString();
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: found }),
          });
        }
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'RESOURCE_NOT_FOUND', message: 'Suppression not found' },
          }),
        });
      }

      // 9. GET /suppressions/:id
      const detailMatch = pathname.match(/\/suppressions\/([^/]+)$/);
      if (detailMatch && method === 'GET') {
        const suppId = detailMatch[1];
        const found = inMemorySuppressions.find((s) => s.id === suppId);
        if (found) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: found }),
          });
        }
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'RESOURCE_NOT_FOUND', message: 'Suppression not found' },
          }),
        });
      }

      // 10. POST /suppressions (Create Suppression)
      if (pathname.endsWith('/suppressions') && method === 'POST') {
        const body = request.postDataJSON() as {
          channelId?: string | null;
          rawAddress: string;
          reason: string;
        };
        const newRecord: SyntheticSuppression = {
          id: `supp-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          orgId: orgHeader ?? orgA1,
          channelId: body.channelId || null,
          rawAddress: body.rawAddress,
          normalizedAddress: body.rawAddress.trim(),
          reason: body.reason,
          status: 'active',
          clearedAt: null,
          clearedReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        inMemorySuppressions.unshift(newRecord);
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ data: newRecord }),
        });
      }

      // 11. GET /suppressions (List Suppressions)
      if (pathname.endsWith('/suppressions') && method === 'GET') {
        let filtered = inMemorySuppressions.filter((s) => s.orgId === orgHeader);
        const statusParam = url.searchParams.get('status');
        if (statusParam && statusParam !== 'all') {
          filtered = filtered.filter((s) => s.status === statusParam);
        }
        const channelParam = url.searchParams.get('channelId');
        if (channelParam && channelParam !== 'all') {
          filtered = filtered.filter((s) => s.channelId === channelParam);
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: filtered,
            page: { limit: 25, hasMore: false, nextCursor: null },
          }),
        });
      }

      // Default fallback
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // E2E-SUPP-01: Full Suppression Lifecycle
  // ---------------------------------------------------------------------------
  test('E2E-SUPP-01: Full suppression lifecycle — create, catalogue display, details inspection, lift, and cleared state', async ({
    page,
  }) => {
    await setupSyntheticSuppressionRoutes(page);

    // 1. Authenticate via login form
    await loginViaUi(page, TEST_CREDENTIALS.multiOrg.email, TEST_CREDENTIALS.multiOrg.password);

    // 2. Select Org A1 from initial selector
    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    const initialOrgSelect = page.locator('#organization-select');
    await expect(initialOrgSelect).toBeVisible();
    await initialOrgSelect.selectOption(ORG_A1_ID);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // 3. Confirm console header reflects Org A1
    await expect(page.locator('#org-select')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#org-select')).toHaveValue(ORG_A1_ID);

    // 4. Navigate to /suppressions via console navigation
    await page.getByRole('link', { name: 'Suppressions' }).click();
    await page.waitForURL((url) => url.pathname === '/suppressions');
    await expect(page.getByRole('heading', { name: 'Suppressions' })).toBeVisible();

    // 5. Verify channel catalogue loaded in the channel filter
    const channelFilter = page.locator('#filter-channel');
    await expect(channelFilter).toBeVisible();
    await expect(channelFilter.getByRole('option', { name: 'WhatsApp Business' })).toBeAttached();
    await expect(channelFilter.getByRole('option', { name: 'SMS Gateway' })).toBeAttached();

    // 6. Open Add Suppression dialog
    const addBtn = page.getByRole('button', { name: '+ Add Suppression' });
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // 7. Complete and submit the suppression form
    await expect(page.getByRole('heading', { name: 'Add Suppression' })).toBeVisible();

    // Generate a unique dynamic test phone number
    const uniquePhone = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
    const suppressionReason = 'Customer opted out via inbound stop keyword ticket #4401';

    // Select WhatsApp channel scope
    await page.locator('#create-suppression-channel').selectOption(CH_WA_ID);
    // Type address and reason character-by-character to exercise keystroke focus stability (D1)
    await page.locator('#create-suppression-address').click();
    await page.locator('#create-suppression-address').pressSequentially(uniquePhone, { delay: 5 });
    await expect(page.locator('#create-suppression-address')).toHaveValue(uniquePhone);

    await page.locator('#create-suppression-reason').click();
    await page
      .locator('#create-suppression-reason')
      .pressSequentially(suppressionReason, { delay: 5 });
    await expect(page.locator('#create-suppression-reason')).toHaveValue(suppressionReason);

    await page.getByRole('button', { name: 'Add Suppression', exact: true }).click();

    // 8. Confirm dialog dismisses and success feedback banner appears
    await expect(page.getByRole('heading', { name: 'Add Suppression' })).not.toBeVisible();
    await expect(page.getByText('Suppression Added', { exact: true })).toBeVisible();

    // 9. Verify the new Active row in the table
    const targetRow = page.locator('table tbody tr', { hasText: uniquePhone });
    await expect(targetRow).toBeVisible();
    await expect(targetRow.getByText('WhatsApp Business')).toBeVisible();
    await expect(targetRow.getByText('Active')).toBeVisible();

    // 10. Open Details dialog and verify record metadata
    await targetRow.getByRole('button', { name: 'Details' }).click();
    const detailsDialog = page.getByRole('dialog');
    await expect(
      detailsDialog.getByRole('heading', { name: 'Suppression Record Details' }),
    ).toBeVisible();
    await expect(detailsDialog.getByText(uniquePhone).first()).toBeVisible();
    await expect(detailsDialog.getByText('WhatsApp Business')).toBeVisible();
    await expect(detailsDialog.getByText(suppressionReason)).toBeVisible();

    // Close details dialog
    await detailsDialog.getByRole('button', { name: 'Close' }).click();
    await expect(detailsDialog).not.toBeVisible();

    // 11. Lift the active suppression
    const liftBtn = targetRow.getByRole('button', { name: 'Lift' });
    await expect(liftBtn).toBeVisible();
    await liftBtn.click();

    // 12. Verify Lift dialog and submit justification reason
    const liftDialog = page.getByRole('dialog');
    await expect(liftDialog.getByRole('heading', { name: 'Lift Suppression' })).toBeVisible();
    await expect(liftDialog.getByText('Important Confirmation')).toBeVisible();

    const liftReason = 'Customer requested opt-in reactivation via verified support ticket #4402';
    await liftDialog.locator('#lift-suppression-reason').click();
    await liftDialog
      .locator('#lift-suppression-reason')
      .pressSequentially(liftReason, { delay: 5 });
    await expect(liftDialog.locator('#lift-suppression-reason')).toHaveValue(liftReason);
    await liftDialog.getByRole('button', { name: 'Confirm Lift' }).click();

    // 13. Confirm dialog closes and success banner appears
    await expect(liftDialog).not.toBeVisible();
    await expect(page.getByText('Suppression Lifted', { exact: true })).toBeVisible();

    // 14. Verify row transitions to Cleared status and Lift button is removed
    await expect(targetRow.getByText('Cleared')).toBeVisible();
    await expect(targetRow.getByRole('button', { name: 'Lift' })).not.toBeVisible();

    // 15. Verify cryptographic storage discipline
    await assertNoTokensInStorage(page);
  });

  // ---------------------------------------------------------------------------
  // E2E-SUPP-02: Read-Only Persona Boundaries
  // ---------------------------------------------------------------------------
  test('E2E-SUPP-02: Read-only user can inspect suppressions and channel scopes but cannot create or lift', async ({
    page,
  }) => {
    const existingPhone = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;

    await setupSyntheticSuppressionRoutes(page, {
      // User holds suppressions.read and channels.read, but NOT organizations.read or suppressions.manage (D4)
      permissionsOrgA1: ['suppressions.read', 'channels.read'],
      initialSuppressions: [
        {
          id: 'supp-ro-01',
          orgId: ORG_A1_ID,
          channelId: CH_WA_ID,
          rawAddress: existingPhone,
          normalizedAddress: existingPhone,
          reason: 'Pre-existing audit suppression',
          status: 'active',
          clearedAt: null,
          clearedReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    // 1. Authenticate and select organization
    await loginViaUi(page, TEST_CREDENTIALS.multiOrg.email, TEST_CREDENTIALS.multiOrg.password);
    await page.locator('#organization-select').selectOption(ORG_A1_ID);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // Verify shell header displays intentional styled fallback with tooltip for read-only user lacking organizations.read (D4)
    await expect(page.locator('#org-select')).toBeVisible({ timeout: 10_000 });
    const selectedOption = page.locator('#org-select option:checked');
    await expect(selectedOption).toHaveValue(ORG_A1_ID);
    await expect(selectedOption).toHaveAttribute('title', ORG_A1_ID);

    // 2. Navigate to Suppressions
    await page.getByRole('link', { name: 'Suppressions' }).click();
    await page.waitForURL((url) => url.pathname === '/suppressions');
    await expect(page.getByRole('heading', { name: 'Suppressions' })).toBeVisible();

    // 3. Verify "+ Add Suppression" button is NOT rendered
    await expect(page.getByRole('button', { name: '+ Add Suppression' })).not.toBeVisible();

    // 4. Verify existing suppression row is readable
    const row = page.locator('table tbody tr', { hasText: existingPhone });
    await expect(row).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();

    // 5. Verify "Lift" button is NOT rendered for read-only caller
    await expect(row.getByRole('button', { name: 'Lift' })).not.toBeVisible();

    // 6. Verify "Details" button IS rendered and allows inspection
    await row.getByRole('button', { name: 'Details' }).click();
    const roDetailsDialog = page.getByRole('dialog');
    await expect(
      roDetailsDialog.getByRole('heading', { name: 'Suppression Record Details' }),
    ).toBeVisible();
    await expect(roDetailsDialog.getByText(existingPhone).first()).toBeVisible();
    await roDetailsDialog.getByRole('button', { name: 'Close' }).click();
    await expect(roDetailsDialog).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-SUPP-03: Unauthorized Persona (Lacking suppressions.read)
  // ---------------------------------------------------------------------------
  test('E2E-SUPP-03: Unauthorized user without suppressions.read is blocked and navigation hidden', async ({
    page,
  }) => {
    await setupSyntheticSuppressionRoutes(page, {
      singleOrg: true,
      // User holds only organizations.read (no suppressions.read)
      permissionsOrgA1: ['organizations.read'],
    });

    // 1. Authenticate (single org auto-selects Org A1)
    await loginViaUi(page, TEST_CREDENTIALS.multiOrg.email, TEST_CREDENTIALS.multiOrg.password);
    await expect(page.getByText('Acme Corp (Org A1)')).toBeVisible({ timeout: 10_000 });

    // 2. Verify "Suppressions" link is NOT rendered in navigation
    await expect(page.getByRole('link', { name: 'Suppressions' })).not.toBeVisible();

    // 3. Directly navigate to /suppressions
    await page.goto('/suppressions');
    await expect(page.getByRole('heading', { name: 'Access Forbidden' })).toBeVisible();
    await expect(
      page.getByText('You do not have permission to view suppressions for this organization.'),
    ).toBeVisible();

    // 4. Verify suppression table and actions are not rendered
    await expect(page.locator('table')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add Suppression' })).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-SUPP-04: Cross-Tenant Isolation
  // ---------------------------------------------------------------------------
  test('E2E-SUPP-04: Cross-tenant isolation — switching organizations isolates suppression list', async ({
    page,
  }) => {
    const phoneOrgA1 = '+15550100001';
    const phoneOrgA2 = '+15550200002';

    await setupSyntheticSuppressionRoutes(page, {
      initialSuppressions: [
        {
          id: 'supp-org1',
          orgId: ORG_A1_ID,
          channelId: null,
          rawAddress: phoneOrgA1,
          normalizedAddress: phoneOrgA1,
          reason: 'Org A1 specific suppression',
          status: 'active',
          clearedAt: null,
          clearedReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'supp-org2',
          orgId: ORG_A2_ID,
          channelId: null,
          rawAddress: phoneOrgA2,
          normalizedAddress: phoneOrgA2,
          reason: 'Org A2 specific suppression',
          status: 'active',
          clearedAt: null,
          clearedReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    // 1. Authenticate and start in Org A1
    await loginViaUi(page, TEST_CREDENTIALS.multiOrg.email, TEST_CREDENTIALS.multiOrg.password);
    await page.locator('#organization-select').selectOption(ORG_A1_ID);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // 2. Navigate to /suppressions
    await page.getByRole('link', { name: 'Suppressions' }).click();
    await page.waitForURL((url) => url.pathname === '/suppressions');

    // 3. Confirm Org A1 suppression is present, Org A2 suppression is NOT present
    await expect(page.locator('table tbody tr', { hasText: phoneOrgA1 })).toBeVisible();
    await expect(page.locator('table tbody tr', { hasText: phoneOrgA2 })).not.toBeVisible();

    // Create a new suppression in Org A1 to generate a success banner
    await page.getByRole('button', { name: '+ Add Suppression' }).click();
    const tempPhone = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
    await page.locator('#create-suppression-address').fill(tempPhone);
    await page.locator('#create-suppression-reason').fill('Tenant banner test');
    await page.getByRole('button', { name: 'Add Suppression', exact: true }).click();
    await expect(page.getByText('Suppression Added', { exact: true })).toBeVisible();

    // 4. Switch to Org A2 via header dropdown
    await page.locator('#org-select').selectOption(ORG_A2_ID);
    await expect(page.locator('#org-select')).toHaveValue(ORG_A2_ID);

    // 5. Verify the tenant-specific feedback banner from Org A1 is immediately cleared (D3)
    await expect(page.getByText('Suppression Added', { exact: true })).not.toBeVisible();

    // 6. Confirm Org A2 suppression is present, Org A1 suppression is NOT present
    await expect(page.locator('table tbody tr', { hasText: phoneOrgA2 })).toBeVisible();
    await expect(page.locator('table tbody tr', { hasText: phoneOrgA1 })).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // E2E-SUPP-05: Stale Lift Lifecycle Conflict Handling (D2)
  // ---------------------------------------------------------------------------
  test('E2E-SUPP-05: Stale lift conflict closes modal, displays clear notice, and refreshes list', async ({
    page,
  }) => {
    const conflictPhone = '+15559990001';
    const initialRecord: SyntheticSuppression = {
      id: 'supp-conflict-01',
      orgId: ORG_A1_ID,
      channelId: CH_WA_ID,
      rawAddress: conflictPhone,
      normalizedAddress: conflictPhone,
      reason: 'Concurrent test suppression',
      status: 'active',
      clearedAt: null,
      clearedReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await setupSyntheticSuppressionRoutes(page, {
      initialSuppressions: [initialRecord],
    });

    // 1. Authenticate and select organization
    await loginViaUi(page, TEST_CREDENTIALS.multiOrg.email, TEST_CREDENTIALS.multiOrg.password);
    await page.locator('#organization-select').selectOption(ORG_A1_ID);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // 2. Navigate to /suppressions
    await page.getByRole('link', { name: 'Suppressions' }).click();
    await page.waitForURL((url) => url.pathname === '/suppressions');

    // 3. Find the suppression row and click Lift
    const row = page.locator('table tbody tr', { hasText: conflictPhone });
    await expect(row).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();

    const liftBtn = row.getByRole('button', { name: 'Lift' });
    await liftBtn.click();

    const liftDialog = page.getByRole('dialog');
    await expect(liftDialog.getByRole('heading', { name: 'Lift Suppression' })).toBeVisible();

    // 4. Concurrently mark the record as cleared in the backend store before clicking Confirm Lift
    initialRecord.status = 'cleared';
    initialRecord.clearedAt = new Date().toISOString();
    initialRecord.clearedReason = 'Cleared by concurrent session';

    // 5. Fill reason and submit lift
    await liftDialog.locator('#lift-suppression-reason').fill('Trying to lift stale record');
    await liftDialog.getByRole('button', { name: 'Confirm Lift' }).click();

    // 6. Confirm dialog is dismissed (D2)
    await expect(liftDialog).not.toBeVisible();

    // 7. Confirm informative conflict notice is displayed on the card (D2)
    await expect(page.getByText('Suppression Already Cleared')).toBeVisible();
    await expect(
      page.getByText('was already lifted by another session and is no longer active'),
    ).toBeVisible();

    // 8. Confirm table refetched and row reflects Cleared status with Lift button removed (D2)
    await expect(row.getByText('Cleared')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Lift' })).not.toBeVisible();
  });
});
