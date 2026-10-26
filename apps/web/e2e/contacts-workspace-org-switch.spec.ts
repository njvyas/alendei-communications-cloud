import { expect, test, type Page } from '@playwright/test';
import { loginViaUi } from './helpers/auth';

/**
 * Contacts page workspace selection follows the active organization.
 *
 * NOTE: API responses are synthetically mocked via `page.route()`. This
 * validates the console's client-side state handling across organization
 * switches (which workspace and cursor are requested, under which
 * organization header). It is NOT verification against a live backend.
 *
 * Before the fix, the page kept the previous organization's workspace after a
 * switch and requested its contacts under the new organization's header.
 */
test.describe('Contacts: workspace selection across organization switches', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f9a000';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f9b000';
  const ORG_C = '01955b0a-7b3b-7411-9a4f-9e67d4f9c000';
  // Workspaces request fails: HTTP 500 (ORG_D) or a network failure (ORG_E).
  const ORG_D = '01955b0a-7b3b-7411-9a4f-9e67d4f9d000';
  const ORG_E = '01955b0a-7b3b-7411-9a4f-9e67d4f9e000';
  const ALL_ORGS = [ORG_A, ORG_B, ORG_C, ORG_D, ORG_E];
  const WS_A1 = '01955b0a-7b3b-7411-9a4f-9e67d4f9a001';
  const WS_A2 = '01955b0a-7b3b-7411-9a4f-9e67d4f9a002';
  const WS_B1 = '01955b0a-7b3b-7411-9a4f-9e67d4f9b001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f96666';
  const NEW_CONTACT_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f9a999';
  const ORG_A_WORKSPACES = new Set([WS_A1, WS_A2]);

  type ContactsRequest = { org: string | undefined; workspaceId: string; cursor: string | null };
  type CreateRequest = { org: string | undefined; workspaceId: string; firstName?: string };

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  const contactsFor = (workspaceId: string, count: number, label: string) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${workspaceId.slice(0, -3)}${String(100 + i)}`,
      workspaceId,
      firstName: label,
      lastName: `Contact ${i + 1}`,
      metadata: {},
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    }));

  const workspace = (id: string, orgId: string, name: string, isDefault: boolean) => ({
    id,
    orgId,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    status: 'active',
    isDefault,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  });

  const WORKSPACES_BY_ORG: Record<string, ReturnType<typeof workspace>[]> = {
    [ORG_A]: [
      workspace(WS_A1, ORG_A, 'Org A Default', true),
      workspace(WS_A2, ORG_A, 'Org A Second', false),
    ],
    [ORG_B]: [workspace(WS_B1, ORG_B, 'Org B Default', true)],
    [ORG_C]: [],
  };

  async function setupSyntheticApiRoutes(
    page: Page,
    contactsRequests: ContactsRequest[],
    createRequests: CreateRequest[] = [],
  ) {
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const { pathname } = url;
      const method = request.method();
      const org = request.headers()['x-acc-organization'];

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
              email: 'workspace-sync@example.test',
              actorType: 'user',
              authMethod: 'session',
              sessionId: 'sess-synth-01',
              authenticatedAt: new Date().toISOString(),
              tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
              authorizedOrganizationIds: ALL_ORGS,
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
              organizationIds: ALL_ORGS,
              grants: ALL_ORGS.map((orgId, i) => ({
                roleId: `role-org-admin-${i}`,
                roleKey: 'org_admin',
                scopeType: 'organization',
                scopeId: orgId,
                orgId,
                permissions: [
                  'contacts.read',
                  'contacts.manage',
                  'workspaces.read',
                  'organizations.read',
                ],
              })),
            },
          }),
        );
      }
      if (pathname.endsWith('/organizations') && method === 'GET') {
        return route.fulfill(
          json({
            data: [
              [ORG_A, 'Org A'],
              [ORG_B, 'Org B'],
              [ORG_C, 'Org C'],
              [ORG_D, 'Org D'],
              [ORG_E, 'Org E'],
            ].map(([id, name]) => ({
              id,
              name,
              slug: name!.toLowerCase().replace(' ', '-'),
              status: 'active',
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
            })),
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      if (pathname.endsWith('/workspaces') && method === 'GET' && org === ORG_D) {
        return route.fulfill(
          json(
            { error: { code: 'INTERNAL_ERROR', message: 'Simulated failure', retryable: false } },
            500,
          ),
        );
      }
      if (pathname.endsWith('/workspaces') && method === 'GET' && org === ORG_E) {
        return route.abort('failed');
      }
      if (pathname.endsWith('/workspaces') && method === 'GET') {
        return route.fulfill(
          json({
            data: WORKSPACES_BY_ORG[org ?? ''] ?? [],
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
      const listMatch = pathname.match(/\/workspaces\/([^/]+)\/contacts$/);
      if (listMatch && method === 'GET') {
        const workspaceId = listMatch[1]!;
        const cursor = url.searchParams.get('cursor');
        contactsRequests.push({ org, workspaceId, cursor });
        // The backend refuses a workspace outside the organization in context.
        const owner = Object.entries(WORKSPACES_BY_ORG).find(([, list]) =>
          list.some((ws) => ws.id === workspaceId),
        )?.[0];
        if (owner !== org) {
          return route.fulfill(
            json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Workspace not found' } }, 404),
          );
        }
        if (cursor) {
          return route.fulfill(
            json({
              data: contactsFor(workspaceId, 3, 'Page2'),
              page: { limit: 25, hasMore: false, nextCursor: null },
            }),
          );
        }
        const full = workspaceId !== WS_B1;
        return route.fulfill(
          json({
            data: contactsFor(workspaceId, full ? 25 : 2, workspaceId === WS_B1 ? 'OrgB' : 'OrgA'),
            page: { limit: 25, hasMore: full, nextCursor: full ? `${workspaceId}-c2` : null },
          }),
        );
      }
      const createMatch = pathname.match(/\/workspaces\/([^/]+)\/contacts$/);
      if (createMatch && method === 'POST') {
        const workspaceId = createMatch[1]!;
        const body = request.postDataJSON() as { firstName?: string; lastName?: string };
        createRequests.push({ org, workspaceId, firstName: body.firstName });
        return route.fulfill(
          json(
            {
              data: {
                id: NEW_CONTACT_ID,
                workspaceId,
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
      return route.fulfill(json({ error: { code: 'NOT_FOUND', message: 'Not mocked' } }, 404));
    });
  }

  test('CWS-01: switching organization never queries the previous organization’s workspace', async ({
    page,
  }) => {
    const contactsRequests: ContactsRequest[] = [];
    await setupSyntheticApiRoutes(page, contactsRequests);
    await loginViaUi(page, 'workspace-sync@example.test', 'synthetic-password-not-used');

    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    await page.locator('#organization-select').selectOption(ORG_A);
    await page.getByRole('button', { name: 'Enter Console' }).click();
    await expect(page.locator('#org-select')).toHaveValue(ORG_A);

    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/contacts'));
    const table = page.getByTestId('contacts-table');
    const workspaceSelect = page.locator('#select-workspace');
    const previous = page.getByRole('button', { name: 'Previous' });

    // Org A: choose its second workspace, go to page 2, create a contact.
    await expect(workspaceSelect).toHaveValue(WS_A1);
    await workspaceSelect.selectOption(WS_A2);
    await expect(table.locator('tbody tr')).toHaveCount(25);
    // Exact match: under `next dev` the "Open Next.js Dev Tools" button also contains "Next".
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect(previous).toBeEnabled();

    await page.getByTestId('create-contact-btn').click();
    await page.locator('#contact-first-name').fill('Alice');
    await page.locator('#contact-last-name').fill('Tester');
    await page.getByRole('dialog').getByRole('button', { name: 'Create Contact' }).click();
    await expect(page.getByTestId('contact-created-notice')).toBeVisible();

    // Switch to Org B: its own workspace, first page, no Org A notice, no Org A request.
    contactsRequests.length = 0;
    await page.locator('#org-select').selectOption(ORG_B);
    await expect(workspaceSelect).toHaveValue(WS_B1);
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table).toContainText('OrgB Contact 1');
    await expect(page.getByTestId('contact-created-notice')).toHaveCount(0);
    await expect(previous).toBeDisabled();
    await expect(page.getByText('Failed to load contacts')).toHaveCount(0);
    expect(contactsRequests.length).toBeGreaterThanOrEqual(1);
    for (const r of contactsRequests) {
      expect(r).toEqual({ org: ORG_B, workspaceId: WS_B1, cursor: null });
      expect(ORG_A_WORKSPACES.has(r.workspaceId)).toBe(false);
    }

    // Switch to Org C (no workspaces): message shown, no contacts query at all.
    contactsRequests.length = 0;
    await page.locator('#org-select').selectOption(ORG_C);
    await expect(page.getByText('No workspaces exist in this organization.')).toBeVisible();
    await expect(table).toHaveCount(0);
    await expect(page.getByTestId('create-contact-btn')).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(contactsRequests).toEqual([]);

    // Back to Org A: selection, page and notice were reset, not restored.
    contactsRequests.length = 0;
    await page.locator('#org-select').selectOption(ORG_A);
    await expect(workspaceSelect).toHaveValue(WS_A1);
    await expect(table.locator('tbody tr')).toHaveCount(25);
    await expect(previous).toBeDisabled();
    await expect(page.getByTestId('contact-created-notice')).toHaveCount(0);
    for (const r of contactsRequests) {
      expect(r).toEqual({ org: ORG_A, workspaceId: WS_A1, cursor: null });
    }
  });

  async function enterConsoleAt(page: Page, orgId: string) {
    await loginViaUi(page, 'workspace-sync@example.test', 'synthetic-password-not-used');
    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    await page.locator('#organization-select').selectOption(orgId);
    await page.getByRole('button', { name: 'Enter Console' }).click();
    await expect(page.locator('#org-select')).toHaveValue(orgId);
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/contacts'));
  }

  test('CWS-02: a failed workspaces request is reported, not shown as "no workspaces"', async ({
    page,
  }) => {
    const contactsRequests: ContactsRequest[] = [];
    await setupSyntheticApiRoutes(page, contactsRequests);
    await enterConsoleAt(page, ORG_D);

    // HTTP 500
    const loadError = page.getByTestId('workspaces-load-error');
    await expect(loadError).toBeVisible();
    await expect(loadError).toContainText('Failed to load workspaces (INTERNAL_ERROR)');
    await expect(page.getByText('No workspaces exist in this organization.')).toHaveCount(0);
    await expect(page.getByTestId('contacts-table')).toHaveCount(0);
    await expect(page.getByTestId('create-contact-btn')).toHaveCount(0);

    // Network failure
    await page.locator('#org-select').selectOption(ORG_E);
    await expect(loadError).toBeVisible();
    await expect(loadError).toContainText('Failed to load workspaces');
    await expect(page.getByText('No workspaces exist in this organization.')).toHaveCount(0);

    // A successful empty response is still the "no workspaces" message, without an error.
    await page.locator('#org-select').selectOption(ORG_C);
    await expect(page.getByText('No workspaces exist in this organization.')).toBeVisible();
    await expect(loadError).toHaveCount(0);

    await page.waitForTimeout(1000);
    expect(contactsRequests).toEqual([]);
  });

  test('CWS-03: switching organization closes and clears an open create-contact form', async ({
    page,
  }) => {
    const contactsRequests: ContactsRequest[] = [];
    const createRequests: CreateRequest[] = [];
    await setupSyntheticApiRoutes(page, contactsRequests, createRequests);
    await enterConsoleAt(page, ORG_A);

    await page.getByTestId('create-contact-btn').click();
    const dialogHeading = page.getByRole('heading', { name: 'Create Workspace Contact' });
    await expect(dialogHeading).toBeVisible();
    await page.locator('#contact-first-name').fill('Stale');

    // The header switcher stays reachable by keyboard while the form is open.
    await page.locator('#org-select').selectOption(ORG_B, { force: true });
    await expect(page.locator('#org-select')).toHaveValue(ORG_B);
    await expect(dialogHeading).toHaveCount(0);

    // A new form in Org B starts empty and creates in Org B's workspace.
    await expect(page.locator('#select-workspace')).toHaveValue(WS_B1);
    await page.getByTestId('create-contact-btn').click();
    await expect(page.locator('#contact-first-name')).toHaveValue('');
    await page.locator('#contact-first-name').fill('Bravo');
    await page.getByRole('dialog').getByRole('button', { name: 'Create Contact' }).click();
    await expect(page.getByTestId('contact-created-notice')).toContainText('Bravo');

    expect(createRequests).toEqual([{ org: ORG_B, workspaceId: WS_B1, firstName: 'Bravo' }]);
  });
});
