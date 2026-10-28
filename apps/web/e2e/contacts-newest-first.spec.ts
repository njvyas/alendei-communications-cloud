import { expect, test, type Page } from '@playwright/test';
import { loginViaUi } from './helpers/auth';

/**
 * #30 (QAF-019): the contacts list is newest first, so a contact just created
 * is at the top of the first page.
 *
 * NOTE: API responses are synthetically mocked via `page.route()`. The mock
 * honours the `sort` and `cursor` the console sends (`-createdAt` = newest
 * first), so these tests check the console's request and rendering, not the
 * backend. The backend ordering is covered by `apps/api/test/contacts-list-order.sec-spec.ts`.
 */
test.describe('#30: contacts listed newest first', () => {
  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f96666';
  const NEW_CONTACT_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f9c999';

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  interface MockContact {
    id: string;
    workspaceId: string;
    firstName: string | null;
    lastName: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }

  /** Routes the API; returns every contacts-list query string the console sent. */
  async function setupSyntheticApiRoutes(page: Page): Promise<URLSearchParams[]> {
    // 26 older contacts in creation (= id) order: one more than a page holds.
    const contacts: MockContact[] = Array.from({ length: 26 }, (_, i) => ({
      id: `01955b0a-7b3b-7411-9a4f-9e67d4f9a${String(i).padStart(3, '0')}`,
      workspaceId: WORKSPACE_ID,
      firstName: 'Older',
      lastName: `Contact ${i + 1}`,
      metadata: {},
      createdAt: `2026-10-01T09:${String(i).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-10-01T09:${String(i).padStart(2, '0')}:00.000Z`,
    }));
    const listQueries: URLSearchParams[] = [];

    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const { pathname } = requestUrl;
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
              userId: 'usr-synthetic-01',
              email: 'issue30-admin@example.test',
              actorType: 'user',
              authMethod: 'session',
              sessionId: 'sess-synth-01',
              authenticatedAt: new Date().toISOString(),
              tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
              authorizedOrganizationIds: [ORG_ID],
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
              userId: 'usr-synthetic-01',
              apiKeyId: null,
              isPlatformAdmin: false,
              organizationIds: [ORG_ID],
              grants: [
                {
                  roleId: 'role-org-admin-1',
                  roleKey: 'org_admin',
                  scopeType: 'organization',
                  scopeId: ORG_ID,
                  orgId: ORG_ID,
                  permissions: [
                    'contacts.read',
                    'contacts.manage',
                    'workspaces.read',
                    'organizations.read',
                  ],
                },
              ],
            },
          }),
        );
      }
      if (pathname.endsWith('/workspaces') && method === 'GET') {
        return route.fulfill(
          json({
            data: [
              {
                id: WORKSPACE_ID,
                orgId: ORG_ID,
                name: 'Default',
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
      if (pathname.endsWith('/channels') && method === 'GET') {
        return route.fulfill(
          json({
            data: [
              {
                id: CHANNEL_ID,
                code: 'whatsapp',
                displayName: 'WhatsApp',
                status: 'active',
                createdAt: '2026-10-01T09:00:00.000Z',
                updatedAt: '2026-10-01T09:00:00.000Z',
              },
            ],
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      if (pathname.endsWith(`/workspaces/${WORKSPACE_ID}/contacts`) && method === 'GET') {
        const query = requestUrl.searchParams;
        listQueries.push(query);
        const limit = Number(query.get('limit') ?? '25');
        const ordered =
          query.get('sort') === '-createdAt'
            ? [...contacts].sort((a, b) => (a.id < b.id ? 1 : -1))
            : [...contacts].sort((a, b) => (a.id < b.id ? -1 : 1));
        const start = Number(query.get('cursor')?.replace('offset-', '') ?? '0');
        const slice = ordered.slice(start, start + limit);
        const hasMore = start + limit < ordered.length;
        return route.fulfill(
          json({
            data: slice,
            page: { limit, hasMore, nextCursor: hasMore ? `offset-${start + limit}` : null },
          }),
        );
      }
      if (pathname.endsWith(`/workspaces/${WORKSPACE_ID}/contacts`) && method === 'POST') {
        const body = request.postDataJSON() as { firstName?: string; lastName?: string };
        const now = new Date().toISOString();
        const created: MockContact = {
          id: NEW_CONTACT_ID,
          workspaceId: WORKSPACE_ID,
          firstName: body.firstName ?? null,
          lastName: body.lastName ?? null,
          metadata: {},
          createdAt: now,
          updatedAt: now,
        };
        contacts.push(created);
        return route.fulfill(json({ data: created }, 201));
      }
      if (pathname.endsWith(`/contacts/${NEW_CONTACT_ID}/identities`) && method === 'POST') {
        return route.fulfill(json({ data: { id: 'identity-1' } }, 201));
      }
      if (pathname.endsWith(`/contacts/${NEW_CONTACT_ID}/consent-events`) && method === 'POST') {
        return route.fulfill(json({ data: { id: 'consent-1' } }, 201));
      }
      return route.fulfill(json({ error: { code: 'NOT_FOUND', message: 'Not mocked' } }, 404));
    });
    return listQueries;
  }

  async function openContacts(page: Page) {
    await loginViaUi(page, 'issue30-admin@example.test', 'synthetic-password-not-used');
    // Client-side navigation keeps the in-memory session (a full page load would not).
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/contacts'));
    await expect(page.getByRole('heading', { name: 'Contacts & Consent' })).toBeVisible();
  }

  const rows = (page: Page) => page.getByTestId('contacts-table').locator('tbody tr');

  test('NF-01: the list is requested and shown newest first, on every page', async ({ page }) => {
    const listQueries = await setupSyntheticApiRoutes(page);
    await openContacts(page);

    await expect(rows(page)).toHaveCount(25);
    await expect(rows(page).first()).toContainText('Older Contact 26');
    await expect(rows(page).last()).toContainText('Older Contact 2');
    await expect(page.getByTestId('contacts-created-header')).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await expect(page.getByTestId('contacts-created-header')).toContainText('newest first');

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Older Contact 1');

    expect(listQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of listQueries) {
      expect(query.get('sort')).toBe('-createdAt');
      expect(query.get('limit')).toBe('25');
    }
    expect(listQueries.at(-1)!.get('cursor')).toBe('offset-25');
  });

  test('NF-02: a contact created from a later page is shown first on page 1', async ({ page }) => {
    await setupSyntheticApiRoutes(page);
    await openContacts(page);

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(rows(page)).toHaveCount(1);

    await page.getByTestId('create-contact-btn').click();
    await page.locator('#contact-first-name').fill('Alice');
    await page.locator('#contact-last-name').fill('Tester');
    await page.locator('#contact-phone').fill('+12025550190');
    await page.getByRole('dialog').getByRole('button', { name: 'Create Contact' }).click();

    // Back on page 1, with the new contact at the top.
    await expect(rows(page)).toHaveCount(25);
    await expect(rows(page).first()).toContainText('Alice Tester');
    await expect(rows(page).first()).toContainText(NEW_CONTACT_ID);
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();

    const notice = page.getByTestId('contact-created-notice');
    await expect(notice).toContainText('Alice Tester');
    await expect(notice).toContainText('newest first');
  });
});
