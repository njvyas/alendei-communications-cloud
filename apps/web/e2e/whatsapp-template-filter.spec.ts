import { expect, test, type Page } from '@playwright/test';
import { loginViaUi } from './helpers/auth';

/**
 * QAF-018 (#28): the WhatsApp send form offers only approved WhatsApp templates,
 * and its workspace, template and variables follow the active organization.
 *
 * NOTE: API responses are synthetically mocked via `page.route()`. The mocked
 * template lists deliberately ignore the `channelId` filter and return mixed
 * channels and statuses, to prove the console never offers anything else. This
 * is NOT verification against a live backend; the server's own wrong-channel
 * refusal is covered by `apps/api/test/phase4_1-data-foundation.sec-spec.ts`.
 */
test.describe('QAF-018: WhatsApp template filtering', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f9a000';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f9b000';
  const ORG_C = '01955b0a-7b3b-7411-9a4f-9e67d4f9c000'; // channel request fails (HTTP 500)
  const ORG_D = '01955b0a-7b3b-7411-9a4f-9e67d4f9d000'; // channel list has no WhatsApp entry
  const ALL_ORGS = [ORG_A, ORG_B, ORG_C, ORG_D];
  const WS = {
    [ORG_A]: '01955b0a-7b3b-7411-9a4f-9e67d4f9a001',
    [ORG_B]: '01955b0a-7b3b-7411-9a4f-9e67d4f9b001',
    [ORG_C]: '01955b0a-7b3b-7411-9a4f-9e67d4f9c001',
    [ORG_D]: '01955b0a-7b3b-7411-9a4f-9e67d4f9d001',
  } as Record<string, string>;
  const CH_WHATSAPP = '01955b0a-7b3b-7411-9a4f-9e67d4f9f001';
  const CH_SMS = '01955b0a-7b3b-7411-9a4f-9e67d4f9f002';
  const CH_RCS = '01955b0a-7b3b-7411-9a4f-9e67d4f9f003';
  const CH_OTHER = '01955b0a-7b3b-7411-9a4f-9e67d4f9f0ff';
  const MESSAGE_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f9e999';

  const T = {
    aWelcome: '01955b0a-7b3b-7411-9a4f-9e67d4f9a101',
    aOffer: '01955b0a-7b3b-7411-9a4f-9e67d4f9a102',
    aSms: '01955b0a-7b3b-7411-9a4f-9e67d4f9a103',
    aRcs: '01955b0a-7b3b-7411-9a4f-9e67d4f9a104',
    aDraft: '01955b0a-7b3b-7411-9a4f-9e67d4f9a105',
    aRejected: '01955b0a-7b3b-7411-9a4f-9e67d4f9a106',
    aOther: '01955b0a-7b3b-7411-9a4f-9e67d4f9a107',
    bWelcome: '01955b0a-7b3b-7411-9a4f-9e67d4f9b101',
    bSms: '01955b0a-7b3b-7411-9a4f-9e67d4f9b102',
  };

  type TemplatesRequest = {
    org: string | undefined;
    channelId: string | null;
    approval: string | null;
  };
  type SendRequest = { org: string | undefined; body: Record<string, unknown> };

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const stamp = { createdAt: '2026-10-26T09:00:00.000Z', updatedAt: '2026-10-26T09:00:00.000Z' };
  const template = (
    id: string,
    orgId: string,
    channelId: string,
    name: string,
    status: string,
  ) => ({
    id,
    orgId,
    channelId,
    name,
    body: `${name} {{1}}`,
    variables: ['1'],
    approvalStatus: status,
    ...stamp,
  });

  const TEMPLATES_BY_ORG: Record<string, ReturnType<typeof template>[]> = {
    [ORG_A]: [
      template(T.aWelcome, ORG_A, CH_WHATSAPP, 'qa_welcome_a', 'approved'),
      template(T.aSms, ORG_A, CH_SMS, 'qa_sms_a', 'approved'),
      template(T.aRcs, ORG_A, CH_RCS, 'qa_rcs_a', 'approved'),
      template(T.aDraft, ORG_A, CH_WHATSAPP, 'qa_draft_a', 'draft'),
      template(T.aRejected, ORG_A, CH_WHATSAPP, 'qa_rejected_a', 'rejected'),
      template(T.aOther, ORG_A, CH_OTHER, 'qa_other_channel_a', 'approved'),
      template(T.aOffer, ORG_A, CH_WHATSAPP, 'qa_offer_a', 'approved'),
    ],
    [ORG_B]: [
      template(T.bSms, ORG_B, CH_SMS, 'qa_sms_b', 'approved'),
      template(T.bWelcome, ORG_B, CH_WHATSAPP, 'qa_welcome_b', 'approved'),
    ],
  };

  const channel = (id: string, code: string) => ({
    id,
    code,
    displayName: code,
    status: 'active',
    ...stamp,
  });

  async function setupSyntheticApiRoutes(
    page: Page,
    templatesRequests: TemplatesRequest[],
    sendRequests: SendRequest[],
    delaysMs: { channels?: number; templates?: number } = {},
  ) {
    const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
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
              email: 'wa-templates@example.test',
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
                  'messages.read',
                  'messages.send',
                  'templates.read',
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
            data: ALL_ORGS.map((id, i) => ({
              id,
              name: `Org ${'ABCD'[i]}`,
              slug: `org-${'abcd'[i]}`,
              status: 'active',
              ...stamp,
            })),
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      if (pathname.endsWith('/workspaces') && method === 'GET') {
        const id = WS[org ?? ''];
        return route.fulfill(
          json({
            data: id
              ? [
                  {
                    id,
                    orgId: org,
                    name: 'Default',
                    slug: 'default',
                    status: 'active',
                    isDefault: true,
                    ...stamp,
                  },
                ]
              : [],
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      if (pathname.endsWith('/channels') && method === 'GET') {
        await pause(delaysMs.channels);
        if (org === ORG_C) {
          return route.fulfill(
            json(
              { error: { code: 'INTERNAL_ERROR', message: 'Simulated failure', retryable: false } },
              500,
            ),
          );
        }
        const all = [
          channel(CH_SMS, 'sms'),
          channel(CH_WHATSAPP, 'whatsapp'),
          channel(CH_RCS, 'rcs'),
        ];
        return route.fulfill(
          json({
            data: org === ORG_D ? all.filter((c) => c.code !== 'whatsapp') : all,
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      if (pathname.endsWith('/templates') && method === 'GET') {
        templatesRequests.push({
          org,
          channelId: url.searchParams.get('channelId'),
          approval: url.searchParams.get('approvalStatus'),
        });
        // Recorded before the delay, so a test can observe the request while it is in flight.
        await pause(delaysMs.templates);
        // Deliberately unfiltered: the console must not rely on the server filter alone.
        return route.fulfill(
          json({
            data: TEMPLATES_BY_ORG[org ?? ''] ?? [],
            page: { limit: 50, hasMore: false, nextCursor: null },
          }),
        );
      }
      if (pathname.endsWith('/messages') && method === 'POST') {
        sendRequests.push({ org, body: request.postDataJSON() as Record<string, unknown> });
        return route.fulfill(json({ data: { id: MESSAGE_ID, status: 'queued' } }, 202));
      }
      if (pathname.endsWith(`/messages/${MESSAGE_ID}`) && method === 'GET') {
        return route.fulfill(
          json({
            data: {
              id: MESSAGE_ID,
              orgId: org,
              workspaceId: WS[org ?? ''] ?? null,
              channelId: CH_WHATSAPP,
              contactId: null,
              templateId: null,
              recipientAddress: '+1 •••• 0199',
              status: 'accepted',
              failureReason: null,
              payload: {},
              attempts: [],
              createdAt: stamp.createdAt,
              completedAt: stamp.createdAt,
            },
          }),
        );
      }
      return route.fulfill(json({ error: { code: 'NOT_FOUND', message: 'Not mocked' } }, 404));
    });
  }

  async function enterWhatsAppAt(page: Page, orgId: string) {
    await loginViaUi(page, 'wa-templates@example.test', 'synthetic-password-not-used');
    await expect(page.getByText('Select Organization')).toBeVisible({ timeout: 10_000 });
    await page.locator('#organization-select').selectOption(orgId);
    await page.getByRole('button', { name: 'Enter Console' }).click();
    await expect(page.locator('#org-select')).toHaveValue(orgId);
    await page.getByRole('link', { name: 'WhatsApp' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/whatsapp'));
  }

  const optionTexts = (page: Page) =>
    page.locator('#send-template option').evaluateAll((os) => os.map((o) => o.textContent ?? ''));

  test('WTF-01: only approved WhatsApp templates are offered, requested by channel, and sent by ID', async ({
    page,
  }) => {
    const templatesRequests: TemplatesRequest[] = [];
    const sendRequests: SendRequest[] = [];
    await setupSyntheticApiRoutes(page, templatesRequests, sendRequests);
    await enterWhatsAppAt(page, ORG_A);

    await expect(page.locator('#send-template')).toBeVisible();
    const options = await optionTexts(page);
    expect(options.map((t) => t.split(' (ID')[0])).toEqual(['qa_welcome_a', 'qa_offer_a']);

    expect(templatesRequests.length).toBeGreaterThanOrEqual(1);
    for (const r of templatesRequests) {
      expect(r).toEqual({ org: ORG_A, channelId: CH_WHATSAPP, approval: 'approved' });
    }

    await page.locator('#send-template').selectOption(T.aOffer);
    await page.locator('#var-1').fill('Alpha');
    await page.getByTestId('send-message-btn').click();
    await expect.poll(() => sendRequests.length).toBe(1);
    const sent = sendRequests[0]!;
    expect(sent.org).toBe(ORG_A);
    expect(sent.body).toMatchObject({
      channelCode: 'whatsapp',
      templateId: T.aOffer,
      workspaceId: WS[ORG_A],
      payload: { templateId: T.aOffer, templateName: 'qa_offer_a', variables: { '1': 'Alpha' } },
    });
  });

  test('WTF-02: without a WhatsApp channel no template request is made and custom text still sends', async ({
    page,
  }) => {
    const templatesRequests: TemplatesRequest[] = [];
    const sendRequests: SendRequest[] = [];
    await setupSyntheticApiRoutes(page, templatesRequests, sendRequests);

    // Channel request fails (HTTP 500)
    await enterWhatsAppAt(page, ORG_C);
    await expect(page.getByTestId('whatsapp-channel-unavailable')).toBeVisible();
    await expect(page.locator('#send-template')).toHaveCount(0);

    await page.getByRole('button', { name: 'Custom Payload / Text' }).click();
    await page.locator('#send-custom-text').fill('QA custom text without templates');
    await page.getByTestId('send-message-btn').click();
    await expect.poll(() => sendRequests.length).toBe(1);
    expect(sendRequests[0]!.org).toBe(ORG_C);
    expect(sendRequests[0]!.body).toMatchObject({
      channelCode: 'whatsapp',
      payload: { text: 'QA custom text without templates' },
    });
    expect(sendRequests[0]!.body.templateId).toBeUndefined();

    // Channel list without WhatsApp
    await page.getByRole('button', { name: 'Approved Template Message' }).click();
    await page.locator('#org-select').selectOption(ORG_D);
    await expect(page.getByTestId('whatsapp-channel-unavailable')).toBeVisible();
    await expect(page.locator('#send-template')).toHaveCount(0);

    await page.waitForTimeout(1000);
    expect(templatesRequests).toEqual([]);
  });

  test('WTF-03: switching organization resets the template, variables and workspace', async ({
    page,
  }) => {
    const templatesRequests: TemplatesRequest[] = [];
    const sendRequests: SendRequest[] = [];
    await setupSyntheticApiRoutes(page, templatesRequests, sendRequests);
    await enterWhatsAppAt(page, ORG_A);

    await page.locator('#send-template').selectOption(T.aOffer);
    await page.locator('#var-1').fill('Alpha-secret');
    await expect(page.locator('#send-workspace')).toHaveValue(WS[ORG_A]!);

    templatesRequests.length = 0;
    await page.locator('#org-select').selectOption(ORG_B);
    await expect(page.locator('#org-select')).toHaveValue(ORG_B);

    await expect(page.locator('#send-template')).toHaveValue(T.bWelcome);
    expect((await optionTexts(page)).map((t) => t.split(' (ID')[0])).toEqual(['qa_welcome_b']);
    await expect(page.locator('#var-1')).toHaveValue('');
    await expect(page.locator('#send-workspace')).toHaveValue(WS[ORG_B]!);

    expect(templatesRequests.length).toBeGreaterThanOrEqual(1);
    for (const r of templatesRequests) {
      expect(r).toEqual({ org: ORG_B, channelId: CH_WHATSAPP, approval: 'approved' });
    }

    await page.getByTestId('send-message-btn').click();
    await expect.poll(() => sendRequests.length).toBe(1);
    const sent = sendRequests[0]!;
    expect(sent.org).toBe(ORG_B);
    expect(sent.body).toMatchObject({
      channelCode: 'whatsapp',
      templateId: T.bWelcome,
      workspaceId: WS[ORG_B],
      payload: { templateId: T.bWelcome, variables: {} },
    });
    expect(JSON.stringify(sent.body)).not.toContain('Alpha-secret');
    expect(JSON.stringify(sent.body)).not.toContain(T.aOffer);
  });

  test('WTF-04: a loading message is shown while the channel or templates are loading', async ({
    page,
  }) => {
    const templatesRequests: TemplatesRequest[] = [];
    const sendRequests: SendRequest[] = [];
    await setupSyntheticApiRoutes(page, templatesRequests, sendRequests, {
      channels: 1500,
      templates: 1500,
    });
    await enterWhatsAppAt(page, ORG_A);

    const loading = page.getByTestId('whatsapp-templates-loading');
    const unavailable = page.getByTestId('whatsapp-channel-unavailable');
    const empty = page.getByText('No approved templates found.');

    // Channel discovery in flight: loading only, no empty or unavailable state, no template request.
    await expect(loading).toHaveText('Loading approved templates…');
    await expect(unavailable).toHaveCount(0);
    await expect(empty).toHaveCount(0);
    await expect(page.locator('#send-template')).toHaveCount(0);
    expect(templatesRequests).toEqual([]);

    // Channel known, template request in flight: still loading, request carries the channel.
    await expect.poll(() => templatesRequests.length).toBe(1);
    expect(templatesRequests[0]).toEqual({
      org: ORG_A,
      channelId: CH_WHATSAPP,
      approval: 'approved',
    });
    await expect(loading).toBeVisible();
    await expect(empty).toHaveCount(0);

    // Loaded: the selector replaces the loading message.
    await expect(page.locator('#send-template')).toHaveValue(T.aWelcome);
    await expect(loading).toHaveCount(0);
  });
});
