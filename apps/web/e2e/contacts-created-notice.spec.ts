import { expect, test, type Page } from '@playwright/test';
import { loginViaUi } from './helpers/auth';

/**
 * QAF-019 (#30): a newly created contact must be reachable without paging.
 *
 * NOTE: API responses are synthetically mocked via `page.route()`. This
 * validates the console's create-dialog → page → notice wiring under a
 * deterministic condition that reproduces the defect (the first list page is
 * full of older contacts, so the new one is not on it). It is NOT verification
 * against a live backend.
 */
test.describe('QAF-019: created contact notice', () => {
  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f96666';
  const NEW_CONTACT_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f9c999';

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  async function setupSyntheticApiRoutes(page: Page) {
    const olderContacts = Array.from({ length: 25 }, (_, i) => ({
      id: `01955b0a-7b3b-7411-9a4f-9e67d4f9a${String(i).padStart(3, '0')}`,
      workspaceId: WORKSPACE_ID,
      firstName: 'Older',
      lastName: `Contact ${i + 1}`,
      metadata: {},
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    }));

    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
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
              email: 'qaf019-admin@example.test',
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
        // A full first page that never includes the new contact (this mock ignores sort).
        return route.fulfill(
          json({ data: olderContacts, page: { limit: 25, hasMore: true, nextCursor: 'c2' } }),
        );
      }
      if (pathname.endsWith(`/workspaces/${WORKSPACE_ID}/contacts`) && method === 'POST') {
        const body = request.postDataJSON() as { firstName?: string; lastName?: string };
        return route.fulfill(
          json(
            {
              data: {
                id: NEW_CONTACT_ID,
                workspaceId: WORKSPACE_ID,
                firstName: body.firstName ?? null,
                lastName: body.lastName ?? null,
                metadata: {},
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
            201,
          ),
        );
      }
      if (pathname.endsWith(`/contacts/${NEW_CONTACT_ID}/identities`) && method === 'POST') {
        return route.fulfill(json({ data: { id: 'identity-1' } }, 201));
      }
      if (pathname.endsWith(`/contacts/${NEW_CONTACT_ID}/consent-events`) && method === 'POST') {
        return route.fulfill(json({ data: { id: 'consent-1' } }, 201));
      }
      return route.fulfill(json({ error: { code: 'NOT_FOUND', message: 'Not mocked' } }, 404));
    });
  }

  test('QAF-019-01: the created contact is shown and actionable although not on page 1', async ({
    page,
  }) => {
    await setupSyntheticApiRoutes(page);
    await loginViaUi(page, 'qaf019-admin@example.test', 'synthetic-password-not-used');

    // Client-side navigation keeps the in-memory session (a full page load would not).
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/contacts'));
    await expect(page.getByRole('heading', { name: 'Contacts & Consent' })).toBeVisible();
    await expect(page.getByTestId('contacts-table').locator('tbody tr')).toHaveCount(25);

    await page.getByTestId('create-contact-btn').click();
    await page.locator('#contact-first-name').fill('Alice');
    await page.locator('#contact-last-name').fill('Tester');
    await page.locator('#contact-phone').fill('+12025550190');
    await page.getByRole('dialog').getByRole('button', { name: 'Create Contact' }).click();

    // The defect condition: the new contact is not in the first page of the list.
    await expect(page.getByTestId('contacts-table')).not.toContainText('Alice Tester');

    // The fix: a notice names it, shows its ID and keeps it actionable.
    const notice = page.getByTestId('contact-created-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Alice Tester');
    await expect(notice).toContainText(NEW_CONTACT_ID);

    await notice.getByTestId('created-contact-manage-consent-btn').click();
    await expect(page.getByRole('heading', { name: 'Record Consent Event' })).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Alice Tester');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await notice.getByRole('button', { name: 'Dismiss contact created notice' }).click();
    await expect(page.getByTestId('contact-created-notice')).toHaveCount(0);
  });
});
