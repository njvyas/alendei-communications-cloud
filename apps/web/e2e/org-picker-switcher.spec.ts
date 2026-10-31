import { expect, test, type Page } from '@playwright/test';
import { loginViaUi } from './helpers/auth';

/**
 * Organization Picker & Switcher End-to-End Validation (U1).
 *
 * Validates:
 * 1. Resolved organization names (`${name} (${slug})`) in selection view and header switcher.
 * 2. Fallback organization labels (`Organization ${id.slice(0, 8)}…`) when unresolved,
 *    preserving full UUID in values and tooltips/titles.
 * 3. Non-blocking selection and switching under both resolved and fallback states.
 * 4. Single-organization badge display and tooltip behavior.
 *
 * Synthetic API mocking via `page.route()` isolates client-side presentation
 * and routing behavior deterministically without requiring a persistent database.
 */
test.describe('U1 — Organization Picker and Switcher Improvements', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f9a000';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f9b000';
  const SINGLE_ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f9c000';

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  async function setupMockApi(
    page: Page,
    options: {
      authorizedOrgs: string[];
      canReadOrganizations: boolean;
      organizationsList?: { id: string; name: string; slug: string }[];
    },
  ) {
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const { pathname } = url;
      const method = request.method();

      if (pathname.endsWith('/auth/login') && method === 'POST') {
        return route.fulfill(
          json({ data: { accessToken: 'synthetic-jwt', tokenType: 'Bearer', expiresIn: 3600 } }),
        );
      }
      if (pathname.endsWith('/auth/refresh') && method === 'POST') {
        return route.fulfill(
          json({ error: { code: 'AUTH_UNAUTHENTICATED', message: 'No active session' } }, 401),
        );
      }
      if (pathname.endsWith('/auth/me') && method === 'GET') {
        return route.fulfill(
          json({
            data: {
              userId: 'usr-u1-test',
              email: 'u1-tester@example.test',
              actorType: 'user',
              authMethod: 'session',
              sessionId: 'sess-u1-01',
              authenticatedAt: new Date().toISOString(),
              tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
              authorizedOrganizationIds: options.authorizedOrgs,
              roles: [],
              permissions: [],
            },
          }),
        );
      }
      if (
        (pathname.endsWith('/auth/me/authorization') || pathname.endsWith('/auth/authorization')) &&
        method === 'GET'
      ) {
        return route.fulfill(
          json({
            data: {
              actorType: 'user',
              userId: 'usr-u1-test',
              apiKeyId: null,
              isPlatformAdmin: false,
              organizationIds: options.authorizedOrgs,
              grants: options.authorizedOrgs.map((orgId, i) => ({
                roleId: `role-${i}`,
                roleKey: options.canReadOrganizations ? 'org_admin' : 'agent',
                scopeType: 'organization',
                scopeId: orgId,
                orgId,
                permissions: options.canReadOrganizations
                  ? ['workspaces.read', 'organizations.read']
                  : ['workspaces.read'],
              })),
            },
          }),
        );
      }
      if (pathname.endsWith('/organizations') && method === 'GET') {
        if (!options.canReadOrganizations) {
          return route.fulfill(
            json({ error: { code: 'AUTHZ_PERMISSION_DENIED', message: 'Forbidden' } }, 403),
          );
        }
        return route.fulfill(
          json({
            data: (options.organizationsList ?? []).map((org) => ({
              id: org.id,
              name: org.name,
              slug: org.slug,
              status: 'active',
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
            })),
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      if (pathname.endsWith('/workspaces') && method === 'GET') {
        return route.fulfill(
          json({
            data: [
              {
                id: 'ws-default-1',
                orgId: options.authorizedOrgs[0],
                name: 'Default Workspace',
                slug: 'default',
                status: 'active',
                isDefault: true,
                createdAt: '2026-10-01T09:00:00.000Z',
                updatedAt: '2026-10-01T09:00:00.000Z',
              },
            ],
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      return route.fulfill(json({ error: { code: 'NOT_FOUND', message: 'Not mocked' } }, 404));
    });
  }

  test('U1-01: Multi-org user sees resolved organization names in picker and switcher', async ({
    page,
  }) => {
    await setupMockApi(page, {
      authorizedOrgs: [ORG_A, ORG_B],
      canReadOrganizations: true,
      organizationsList: [
        { id: ORG_A, name: 'Acme International', slug: 'acme' },
        { id: ORG_B, name: 'Beta Systems', slug: 'beta' },
      ],
    });

    await loginViaUi(page, 'u1-tester@example.test', 'synthetic-password');

    // 1. Organization Selection Screen displays resolved names
    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    const select = page.locator('#organization-select');
    await expect(select).toBeVisible();

    const optA = select.locator(`option[value="${ORG_A}"]`);
    const optB = select.locator(`option[value="${ORG_B}"]`);
    await expect(optA).toHaveText('Acme International (acme)');
    await expect(optB).toHaveText('Beta Systems (beta)');
    await expect(optA).toHaveAttribute('title', 'Acme International (acme)');
    await expect(optB).toHaveAttribute('title', 'Beta Systems (beta)');

    // 2. Select Acme International and enter console
    await select.selectOption(ORG_A);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // 3. Header switcher renders resolved name in dropdown
    const switcher = page.locator('#org-select');
    await expect(switcher).toBeVisible();
    await expect(switcher).toHaveValue(ORG_A);
    await expect(switcher.locator(`option[value="${ORG_A}"]`)).toHaveText('Acme International (acme)');
    await expect(switcher.locator(`option[value="${ORG_B}"]`)).toHaveText('Beta Systems (beta)');

    // 4. Switch to Beta Systems
    await switcher.selectOption(ORG_B);
    await expect(switcher).toHaveValue(ORG_B);
  });

  test('U1-02: Multi-org user sees formatted fallback Organization ${id.slice(0, 8)}… when lookup is unavailable', async ({
    page,
  }) => {
    // User lacks organizations.read, triggering fallback behavior (SEC-D4)
    await setupMockApi(page, {
      authorizedOrgs: [ORG_A, ORG_B],
      canReadOrganizations: false,
    });

    await loginViaUi(page, 'u1-tester@example.test', 'synthetic-password');

    // 1. Organization Selection Screen displays formatted fallback labels
    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    const select = page.locator('#organization-select');
    await expect(select).toBeVisible();

    const fallbackA = `Organization ${ORG_A.slice(0, 8)}…`;
    const fallbackB = `Organization ${ORG_B.slice(0, 8)}…`;
    const optA = select.locator(`option[value="${ORG_A}"]`);
    const optB = select.locator(`option[value="${ORG_B}"]`);

    await expect(optA).toHaveText(fallbackA);
    await expect(optB).toHaveText(fallbackB);
    // Complete UUID is preserved in title/tooltip
    await expect(optA).toHaveAttribute('title', `Organization ID: ${ORG_A}`);
    await expect(optB).toHaveAttribute('title', `Organization ID: ${ORG_B}`);

    // 2. Selection remains non-blocking: choose Org A and enter console
    await select.selectOption(ORG_A);
    await page.getByRole('button', { name: 'Enter Console' }).click();

    // 3. Header switcher displays formatted fallback label with full UUID in tooltip
    const switcher = page.locator('#org-select');
    await expect(switcher).toBeVisible();
    await expect(switcher).toHaveValue(ORG_A);
    await expect(switcher.locator(`option[value="${ORG_A}"]`)).toHaveText(fallbackA);
    await expect(switcher.locator(`option[value="${ORG_B}"]`)).toHaveText(fallbackB);
    await expect(switcher.locator(`option[value="${ORG_A}"]`)).toHaveAttribute(
      'title',
      `Organization ID: ${ORG_A}`,
    );

    // 4. User can switch to Org B non-blockingly
    await switcher.selectOption(ORG_B);
    await expect(switcher).toHaveValue(ORG_B);
  });

  test('U1-03: Single-org user sees resolved name in badge and tooltip', async ({ page }) => {
    await setupMockApi(page, {
      authorizedOrgs: [SINGLE_ORG],
      canReadOrganizations: true,
      organizationsList: [{ id: SINGLE_ORG, name: 'Solo Enterprises', slug: 'solo' }],
    });

    await loginViaUi(page, 'u1-tester@example.test', 'synthetic-password');

    // Single-org user bypasses selection screen straight into console shell
    await expect(page.locator('#org-select')).toHaveCount(0); // No select dropdown for single org
    const badge = page.locator('div[title="Solo Enterprises (solo)"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('Org:');
    await expect(badge).toContainText('Solo Enterprises (solo)');
  });

  test('U1-04: Single-org user sees formatted fallback label and tooltip when lookup is unavailable', async ({
    page,
  }) => {
    await setupMockApi(page, {
      authorizedOrgs: [SINGLE_ORG],
      canReadOrganizations: false,
    });

    await loginViaUi(page, 'u1-tester@example.test', 'synthetic-password');

    await expect(page.locator('#org-select')).toHaveCount(0);
    const fallbackLabel = `Organization ${SINGLE_ORG.slice(0, 8)}…`;
    const fallbackTooltip = `Organization ID: ${SINGLE_ORG}`;
    const badge = page.locator(`div[title="${fallbackTooltip}"]`);
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('Org:');
    await expect(badge).toContainText(fallbackLabel);
  });
});

