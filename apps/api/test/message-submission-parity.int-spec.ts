/**
 * Phase 7 PR 7-3: characterisation of `POST /messages` (handover §11.1).
 *
 * Written and committed against the **unmodified** send path, before the shared
 * submission core is extracted, and kept unchanged afterwards. Every assertion is
 * the observable behaviour of the pre-refactor code, so the refactor is accepted
 * only if all of it still holds:
 *   1. success per channel and workspace route: response, message row, queue row,
 *      `message.queued` event, contact and identity;
 *   2. every refusal: status, code, message, and no row in any table the path
 *      writes (messages, queue, events, contacts, identities, idempotency keys);
 *   3. error precedence when two checks would refuse;
 *   4. idempotency: replay, payload mismatch, concurrency, the stored request
 *      fingerprint (so keys stored before the refactor replay after it) and the
 *      unkeyed-duplicate behaviour (pinned for D-4, unchanged by 7-3);
 *   5. the concurrent first-send contact race;
 *   6. principals: user session, API key, and a principal without `messages.send`.
 *
 * Simulator providers only; nothing is dispatched. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, type SmsDltMetadata } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { fingerprint } from '../src/idempotency/request-fingerprint';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

const DLT: SmsDltMetadata = {
  entityId: '1201159123456789012',
  templateId: '1207161234567890123',
  headerId: 'ALENDE',
};
const SMS_BODY = 'Your verification code is {{1}}.';

type Body = Record<string, unknown>;

interface Sender {
  readonly tenant: TenantFixture;
  readonly token: string;
}

describe('Phase 7-3 characterisation: POST /messages', () => {
  let h: Harness;
  let credentials: CredentialService;
  const channel: Record<string, string> = {};
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const roles: string[] = [];
  const apiKeyIds: string[] = [];
  let a: Sender; // sms, rcs and whatsapp assigned
  let b: Sender; // another organization (foreign workspace probe)
  let none: Sender; // messages.send but no provider assignment
  let denied: Sender; // no messages.send
  let secondWorkspaceId: string;
  let smsTemplateId: string;
  let smsLongTemplateId: string;
  let smsNoDltTemplateId: string;
  let waTemplateId: string;
  let waDraftTemplateId: string;
  let apiKey: string;
  let seq = 0;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    for (const row of await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['sms', 'rcs', 'whatsapp']))) {
      channel[row.code] = row.id;
    }

    a = await sender('p73-a', true);
    b = await sender('p73-b', true);
    none = await sender('p73-none', true);
    denied = await sender('p73-denied', false);
    for (const code of ['sms', 'rcs', 'whatsapp']) await assign(a.tenant.orgId, code);
    await assign(b.tenant.orgId, 'whatsapp');

    const [ws] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: a.tenant.orgId, name: 'Second', slug: `ws2-${hex(4)}`, isDefault: false })
      .returning({ id: schema.workspaces.id });
    secondWorkspaceId = ws!.id;

    smsTemplateId = await template(a, 'sms', SMS_BODY, { names: ['1'], dlt: DLT });
    smsLongTemplateId = await template(a, 'sms', `${'A'.repeat(200)} {{1}}`, {
      names: ['1'],
      dlt: DLT,
    });
    smsNoDltTemplateId = await template(a, 'sms', SMS_BODY, { names: ['1'] });
    waTemplateId = await template(a, 'whatsapp', 'Hello {{1}}', ['name']);
    waDraftTemplateId = await template(a, 'whatsapp', 'Hello {{1}}', ['name'], 'draft');

    const perm = await h.admin
      .select({ key: schema.permissions.key })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.MESSAGES_SEND));
    const prefix = `ak_test_${hex(8)}`;
    const secret = `s${hex(16)}`;
    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: a.tenant.orgId,
        name: `p73-${hex(3)}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: perm.map((p) => p.key),
        createdBy: a.tenant.userId,
      })
      .returning({ id: schema.apiKeys.id });
    apiKey = `${prefix}.${secret}`;
    apiKeyIds.push(key!.id);
  }, 120_000);

  afterAll(async () => {
    try {
      const orgIds = tenants.map((t) => t.orgId);
      if (orgIds.length > 0) {
        await h.admin
          .delete(schema.messageDispatchQueue)
          .where(inArray(schema.messageDispatchQueue.orgId, orgIds))
          .catch(() => {});
        await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, orgIds)).catch(
          () => {},
        );
        await h.admin
          .delete(schema.messages)
          .where(inArray(schema.messages.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.consentEvents)
          .where(inArray(schema.consentEvents.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.contactIdentities)
          .where(inArray(schema.contactIdentities.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.contacts)
          .where(inArray(schema.contacts.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.suppressions)
          .where(inArray(schema.suppressions.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.templates)
          .where(inArray(schema.templates.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(inArray(schema.organizationProviderAssignments.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.idempotencyKeys)
          .where(inArray(schema.idempotencyKeys.orgId, orgIds))
          .catch(() => {});
      }
      for (const id of apiKeyIds) {
        await purgeAudit(h.admin, sql`actor_api_key_id = ${id}`).catch(() => {});
        await h.admin.execute(sql`DELETE FROM api_keys WHERE id = ${id}`).catch(() => {});
      }
      if (roles.length > 0) {
        await h.admin
          .delete(schema.userRoles)
          .where(inArray(schema.userRoles.roleId, roles))
          .catch(() => {});
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roles))
          .catch(() => {});
        await h.admin
          .delete(schema.roles)
          .where(inArray(schema.roles.id, roles))
          .catch(() => {});
      }
      if (secondWorkspaceId) {
        await h.admin
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.id, secondWorkspaceId))
          .catch(() => {});
      }
      for (const t of tenants) await destroyTenant(h.admin, t).catch(() => {});
      if (providers.length > 0) {
        await h.admin
          .delete(schema.providers)
          .where(inArray(schema.providers.id, providers))
          .catch(() => {});
      }
    } finally {
      await h.close();
    }
  });

  // --- fixtures ---------------------------------------------------------------

  function hex(n: number): string {
    return randomBytes(n).toString('hex');
  }

  async function sender(label: string, canSend: boolean): Promise<Sender> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);
    if (canSend) {
      const perms = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(
          inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
        );
      const roleId = uuidv7();
      roles.push(roleId);
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: tenant.orgId,
        key: `p73_${hex(4)}`,
        name: 'Phase 7-3 sender',
        description: 'Sends and reads messages',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });
      for (const p of perms) {
        await h.admin
          .insert(schema.rolePermissions)
          .values({ roleId, permissionId: p.id, orgId: tenant.orgId });
      }
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.insert(schema.userRoles).values({
          userId: tenant.userId,
          roleId,
          scopeType: 'organization',
          scopeId: tenant.orgId,
        });
      });
    }
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: login.body.data.accessToken as string };
  }

  async function assign(orgId: string, code: string): Promise<void> {
    const slug = `p73-${code}-${hex(4)}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channel[code]!,
        name: `Phase 7-3 ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId,
      channelId: channel[code]!,
      providerId: p!.id,
      priority: 1,
      status: 'active',
    });
  }

  async function template(
    s: Sender,
    code: string,
    body: string,
    variables: unknown,
    approvalStatus: 'approved' | 'draft' = 'approved',
  ): Promise<string> {
    const [t] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: s.tenant.orgId,
        channelId: channel[code]!,
        name: `p73_${code}_${hex(3)}`,
        body,
        variables,
        approvalStatus,
      })
      .returning();
    return t!.id;
  }

  function recipient(): string {
    seq += 1;
    return `+1202557${String(1000 + seq).padStart(4, '0')}`;
  }

  function post(s: Sender | string, body: Body, key?: string, orgId?: string) {
    const token = typeof s === 'string' ? s : s.token;
    const org = orgId ?? (typeof s === 'string' ? a.tenant.orgId : s.tenant.orgId);
    const req = request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acc-Organization', org);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  }

  const sms = (to: string, extra: Body = {}) => ({
    channelCode: 'sms',
    recipient: to,
    templateId: smsTemplateId,
    payload: { variables: { '1': '123456' }, ...extra },
  });
  const wa = (to: string, extra: Body = {}) => ({
    channelCode: 'whatsapp',
    recipient: to,
    payload: { text: 'Hello from 7-3' },
    ...extra,
  });

  async function counts(orgId: string) {
    const n = async (table: string) => {
      const { rows } = await h.admin.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)} WHERE org_id = ${orgId}`,
      );
      return Number(rows[0]!.n);
    };
    return {
      messages: await n('messages'),
      queue: await n('message_dispatch_queue'),
      events: await n('message_events'),
      contacts: await n('contacts'),
      identities: await n('contact_identities'),
      idempotency: await n('idempotency_keys'),
    };
  }

  async function stored(messageId: string) {
    const [message] = await h.admin
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    const queue = await h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, messageId));
    const events = await h.admin
      .select()
      .from(schema.messageEvents)
      .where(eq(schema.messageEvents.messageId, messageId));
    return { message: message!, queue, events };
  }

  async function identityOf(orgId: string, code: string, address: string) {
    return h.admin
      .select()
      .from(schema.contactIdentities)
      .where(
        and(
          eq(schema.contactIdentities.orgId, orgId),
          eq(schema.contactIdentities.channelId, channel[code]!),
          eq(schema.contactIdentities.normalizedAddress, address),
        ),
      );
  }

  /** The complete success contract of the pre-refactor path for one message. */
  async function expectQueued(
    res: request.Response,
    expected: {
      orgId: string;
      workspaceId: string;
      code: string;
      address: string;
      templateId: string | null;
      payload: unknown;
    },
  ) {
    expect(res.status).toBe(202);
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'correlationId',
      'createdAt',
      'id',
      'status',
    ]);
    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.correlationId).toBe(res.headers['x-correlation-id']);

    const { message, queue, events } = await stored(res.body.data.id);
    expect(res.body.data.createdAt).toBe(message.createdAt.toISOString());
    expect(message).toMatchObject({
      orgId: expected.orgId,
      workspaceId: expected.workspaceId,
      channelId: channel[expected.code],
      templateId: expected.templateId,
      status: 'queued',
      recipientAddress: expected.address,
      currentAttemptId: null,
      failureReason: null,
      correlationId: res.body.data.correlationId,
      completedAt: null,
      campaignId: null,
      deliveryStatus: null,
      deliveredAt: null,
      readAt: null,
      deliveredAttemptId: null,
    });
    expect(message.payload).toStrictEqual(expected.payload);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ orgId: expected.orgId, dispatchEpoch: 0 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orgId: expected.orgId, eventType: 'message.queued' });
    expect(events[0]!.payload).toStrictEqual({
      channelCode: expected.code,
      recipient: expected.address,
    });

    const [identity] = await identityOf(expected.orgId, expected.code, expected.address);
    expect(identity).toMatchObject({
      workspaceId: expected.workspaceId,
      contactId: message.contactId,
      status: 'active',
    });
    return message;
  }

  /** A refusal: exact status, code and message, and nothing written anywhere. */
  async function expectRefused(
    send: () => Promise<request.Response>,
    status: number,
    code: string,
    message: string,
    orgId = a.tenant.orgId,
  ) {
    const before = await counts(orgId);
    const res = await send();
    expect({
      status: res.status,
      code: res.body.error?.code,
      message: res.body.error?.message,
    }).toEqual({ status, code, message });
    expect(await counts(orgId)).toEqual(before);
    return res;
  }

  // --- 1. success -----------------------------------------------------------------

  describe('1. success', () => {
    it('WhatsApp, default workspace, first send: normalised address, new contact and identity', async () => {
      const to = recipient();
      const raw = `${to.slice(0, 2)} ${to.slice(2, 5)}-${to.slice(5, 8)} (${to.slice(8)})`;
      const before = await counts(a.tenant.orgId);
      const res = await post(a, wa(raw), randomUUID());
      await expectQueued(res, {
        orgId: a.tenant.orgId,
        workspaceId: a.tenant.workspaceId,
        code: 'whatsapp',
        address: to,
        templateId: null,
        payload: { text: 'Hello from 7-3' },
      });
      const [identity] = await identityOf(a.tenant.orgId, 'whatsapp', to);
      expect(identity).toMatchObject({ rawAddress: raw, isPrimary: true });
      expect(await counts(a.tenant.orgId)).toEqual({
        messages: before.messages + 1,
        queue: before.queue + 1,
        events: before.events + 1,
        contacts: before.contacts + 1,
        identities: before.identities + 1,
        idempotency: before.idempotency + 1,
      });
    });

    it('WhatsApp, existing contact: the contact is reused and no contact or identity is added', async () => {
      const to = recipient();
      const first = await post(a, wa(to)).expect(202);
      const before = await counts(a.tenant.orgId);
      const second = await post(a, wa(to)).expect(202);
      const m1 = (await stored(first.body.data.id)).message;
      const m2 = (await stored(second.body.data.id)).message;
      expect(m2.contactId).toBe(m1.contactId);
      const after = await counts(a.tenant.orgId);
      expect(after.contacts).toBe(before.contacts);
      expect(after.identities).toBe(before.identities);
      expect(after.messages).toBe(before.messages + 1);
    });

    it('WhatsApp with an approved template and an explicit second workspace', async () => {
      const to = recipient();
      const res = await post(
        a,
        wa(to, { templateId: waTemplateId, workspaceId: secondWorkspaceId }),
      );
      await expectQueued(res, {
        orgId: a.tenant.orgId,
        workspaceId: secondWorkspaceId,
        code: 'whatsapp',
        address: to,
        templateId: waTemplateId,
        payload: { text: 'Hello from 7-3' },
      });
    });

    it('SMS: the persisted payload is the server-rendered text and the template DLT only', async () => {
      const to = recipient();
      const res = await post(a, sms(to, { dlt: DLT }));
      await expectQueued(res, {
        orgId: a.tenant.orgId,
        workspaceId: a.tenant.workspaceId,
        code: 'sms',
        address: to,
        templateId: smsTemplateId,
        payload: {
          text: 'Your verification code is 123456.',
          dlt: DLT,
          variables: { '1': '123456' },
        },
      });
    });

    it('SMS: a client maxSegments is persisted as the effective, server-capped value', async () => {
      const to = recipient();
      const res = await post(
        a,
        sms(to, { maxSegments: 99, text: 'Your verification code is 123456.' }),
      );
      const message = await expectQueued(res, {
        orgId: a.tenant.orgId,
        workspaceId: a.tenant.workspaceId,
        code: 'sms',
        address: to,
        templateId: smsTemplateId,
        payload: expect.anything(),
      });
      expect(message.payload).toStrictEqual({
        text: 'Your verification code is 123456.',
        dlt: DLT,
        variables: { '1': '123456' },
        maxSegments: 10,
      });
    });

    it('RCS: the payload is persisted exactly as sent', async () => {
      const to = recipient();
      const payload = { messageType: 'text', text: 'Your table is ready' };
      const res = await post(a, { channelCode: 'rcs', recipient: to, payload });
      await expectQueued(res, {
        orgId: a.tenant.orgId,
        workspaceId: a.tenant.workspaceId,
        code: 'rcs',
        address: to,
        templateId: null,
        payload,
      });
    });
  });

  // --- 2. refusals ----------------------------------------------------------------

  describe('2. refusals: exact error and nothing written', () => {
    it('unknown channel: 404 RESOURCE_NOT_FOUND', async () => {
      await expectRefused(
        () => post(a, { channelCode: 'pigeon', recipient: recipient(), payload: {} }, randomUUID()),
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        "Channel 'pigeon' not found",
      );
    });

    it('catalogued but not dispatchable channel: 422 CHANNEL_NOT_SUPPORTED', async () => {
      await expectRefused(
        () =>
          post(
            a,
            { channelCode: 'voice', recipient: recipient(), payload: { text: 'x' } },
            randomUUID(),
          ),
        422,
        ERROR_CODES.CHANNEL_NOT_SUPPORTED,
        "Channel 'voice' does not support sending messages",
      );
    });

    it("another organization's workspace: 404 RESOURCE_NOT_FOUND", async () => {
      await expectRefused(
        () => post(a, wa(recipient(), { workspaceId: b.tenant.workspaceId }), randomUUID()),
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        'Workspace not found',
      );
    });

    it('phone without a country code: 400 PHONE_MISSING_COUNTRY_CODE', async () => {
      await expectRefused(
        () => post(a, wa('2025550100'), randomUUID()),
        400,
        ERROR_CODES.PHONE_MISSING_COUNTRY_CODE,
        'Phone number must start with a + and include country code',
      );
    });

    it('invalid phone number: 400 INVALID_PHONE_NUMBER', async () => {
      await expectRefused(
        () => post(a, wa('+0123'), randomUUID()),
        400,
        ERROR_CODES.INVALID_PHONE_NUMBER,
        'Phone number is invalid (must be E.164: + followed by 7-15 digits)',
      );
    });

    it.each([
      ['channel-specific', 'whatsapp'],
      ['organization-wide', null],
    ] as const)('%s active suppression: 422 RECIPIENT_SUPPRESSED', async (_label, code) => {
      const to = recipient();
      await h.admin.insert(schema.suppressions).values({
        orgId: a.tenant.orgId,
        channelId: code ? channel[code]! : null,
        rawAddress: to,
        normalizedAddress: to,
        reason: 'opt-out',
        status: 'active',
      });
      await expectRefused(
        () => post(a, wa(to), randomUUID()),
        422,
        ERROR_CODES.RECIPIENT_SUPPRESSED,
        'Recipient is actively suppressed for this channel',
      );
    });

    it('revoked consent: 422 CONSENT_REVOKED', async () => {
      const to = recipient();
      await post(a, wa(to)).expect(202);
      const [identity] = await identityOf(a.tenant.orgId, 'whatsapp', to);
      await h.admin.insert(schema.consentEvents).values({
        orgId: a.tenant.orgId,
        workspaceId: a.tenant.workspaceId,
        contactId: identity!.contactId,
        channelId: channel.whatsapp!,
        consentType: 'marketing',
        event: 'revoke',
        occurredAt: new Date(),
        source: 'user_optout',
      });
      await expectRefused(
        () => post(a, wa(to), randomUUID()),
        422,
        ERROR_CODES.CONSENT_REVOKED,
        'Recipient has revoked consent for this channel',
      );
    });

    it('unknown template: 404, and the first-send contact is rolled back', async () => {
      await expectRefused(
        () => post(a, wa(recipient(), { templateId: uuidv7() }), randomUUID()),
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        'Template not found',
      );
    });

    it("another channel's template: 422 VALIDATION_FAILED", async () => {
      await expectRefused(
        () => post(a, wa(recipient(), { templateId: smsTemplateId }), randomUUID()),
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'Template does not match requested channel',
      );
    });

    it('unapproved template: 422 TEMPLATE_NOT_APPROVED', async () => {
      await expectRefused(
        () => post(a, wa(recipient(), { templateId: waDraftTemplateId }), randomUUID()),
        422,
        ERROR_CODES.TEMPLATE_NOT_APPROVED,
        'Template is not approved',
      );
    });

    it('SMS payload with an unknown field: 422 SMS_PAYLOAD_INVALID', async () => {
      await expectRefused(
        () => post(a, sms(recipient(), { colour: 'red' }), randomUUID()),
        422,
        ERROR_CODES.SMS_PAYLOAD_INVALID,
        "Invalid SMS payload: SMS payload contains unknown field 'colour'",
      );
    });

    it('SMS without a template: 422 SMS_DLT_METADATA_REQUIRED', async () => {
      await expectRefused(
        () =>
          post(
            a,
            { channelCode: 'sms', recipient: recipient(), payload: { text: 'hi' } },
            randomUUID(),
          ),
        422,
        ERROR_CODES.SMS_DLT_METADATA_REQUIRED,
        'SMS dispatch requires an approved registered template with bound DLT metadata',
      );
    });

    it('SMS template without DLT metadata: 422 SMS_DLT_METADATA_REQUIRED', async () => {
      await expectRefused(
        () => post(a, { ...sms(recipient()), templateId: smsNoDltTemplateId }, randomUUID()),
        422,
        ERROR_CODES.SMS_DLT_METADATA_REQUIRED,
        'SMS template dispatch requires DLT metadata bound to the approved template',
      );
    });

    it('SMS payload DLT that differs from the template: 422 SMS_DLT_TEMPLATE_MISMATCH', async () => {
      await expectRefused(
        () =>
          post(
            a,
            sms(recipient(), { dlt: { ...DLT, templateId: '1207161234567890999' } }),
            randomUUID(),
          ),
        422,
        ERROR_CODES.SMS_DLT_TEMPLATE_MISMATCH,
        'Payload DLT metadata does not match approved template DLT metadata',
      );
    });

    it('SMS missing template variable: 422 SMS_TEMPLATE_VARIABLE_INVALID', async () => {
      await expectRefused(
        () =>
          post(
            a,
            { channelCode: 'sms', recipient: recipient(), templateId: smsTemplateId, payload: {} },
            randomUUID(),
          ),
        422,
        ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID,
        "Invalid SMS template variables: Missing required template variable '1'",
      );
    });

    it('SMS payload.text that overrides the template: 422 SMS_PAYLOAD_INVALID', async () => {
      await expectRefused(
        () => post(a, sms(recipient(), { text: 'Something else' }), randomUUID()),
        422,
        ERROR_CODES.SMS_PAYLOAD_INVALID,
        'Payload text cannot override approved template content',
      );
    });

    it('SMS longer than maxSegments: 422 SMS_MAX_SEGMENTS_EXCEEDED', async () => {
      await expectRefused(
        () =>
          post(
            a,
            { ...sms(recipient(), { maxSegments: 1 }), templateId: smsLongTemplateId },
            randomUUID(),
          ),
        422,
        ERROR_CODES.SMS_MAX_SEGMENTS_EXCEEDED,
        'SMS message length requires 2 segments, exceeding maximum allowed limit of 1',
      );
    });

    it('invalid RCS payload: 422 RCS_PAYLOAD_INVALID', async () => {
      await expectRefused(
        () =>
          post(
            a,
            { channelCode: 'rcs', recipient: recipient(), payload: { messageType: 'hologram' } },
            randomUUID(),
          ),
        422,
        ERROR_CODES.RCS_PAYLOAD_INVALID,
        "Invalid RCS payload: Invalid RCS messageType 'hologram'. Allowed: text, media, rich_card",
      );
    });

    it('RCS with an unsafe action URL: 422 RCS_UNSAFE_ACTION_URL', async () => {
      const payload = {
        messageType: 'rich_card',
        card: {
          title: 'Prize',
          suggestions: [
            {
              type: 'action_open_url',
              text: 'Claim',
              postbackData: 'data',
              url: 'javascript:alert(1)',
            },
          ],
        },
      };
      await expectRefused(
        () => post(a, { channelCode: 'rcs', recipient: recipient(), payload }, randomUUID()),
        422,
        ERROR_CODES.RCS_UNSAFE_ACTION_URL,
        "Invalid RCS payload: Card suggestion [0]: Unsafe action URL 'javascript:alert(1)': only http and https protocols are permitted",
      );
    });

    it('no active provider assignment: 422 NO_ACTIVE_PROVIDER_ASSIGNMENT', async () => {
      await expectRefused(
        () => post(none, wa(recipient()), randomUUID()),
        422,
        ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT,
        'No active provider assignment for this channel',
        none.tenant.orgId,
      );
    });
  });

  // --- 3. precedence --------------------------------------------------------------

  describe('3. error precedence: the earlier check wins', () => {
    it('suppressed and an unapproved template: RECIPIENT_SUPPRESSED', async () => {
      const to = recipient();
      await h.admin.insert(schema.suppressions).values({
        orgId: a.tenant.orgId,
        channelId: channel.whatsapp!,
        rawAddress: to,
        normalizedAddress: to,
        reason: 'opt-out',
        status: 'active',
      });
      const res = await post(a, wa(to, { templateId: waDraftTemplateId }));
      expect(res.body.error.code).toBe(ERROR_CODES.RECIPIENT_SUPPRESSED);
    });

    it('revoked consent and no provider assignment: CONSENT_REVOKED', async () => {
      const to = recipient();
      const [contact] = await h.admin
        .insert(schema.contacts)
        .values({ orgId: none.tenant.orgId, workspaceId: none.tenant.workspaceId })
        .returning();
      await h.admin.insert(schema.contactIdentities).values({
        orgId: none.tenant.orgId,
        workspaceId: none.tenant.workspaceId,
        contactId: contact!.id,
        channelId: channel.whatsapp!,
        rawAddress: to,
        normalizedAddress: to,
        status: 'active',
      });
      await h.admin.insert(schema.consentEvents).values({
        orgId: none.tenant.orgId,
        workspaceId: none.tenant.workspaceId,
        contactId: contact!.id,
        channelId: channel.whatsapp!,
        consentType: 'marketing',
        event: 'revoke',
        occurredAt: new Date(),
        source: 'user_optout',
      });
      const res = await post(none, wa(to));
      expect(res.body.error.code).toBe(ERROR_CODES.CONSENT_REVOKED);
    });

    it("another channel's template and an invalid SMS payload: VALIDATION_FAILED", async () => {
      const res = await post(a, {
        channelCode: 'sms',
        recipient: recipient(),
        templateId: waTemplateId,
        payload: { colour: 'red' },
      });
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('a foreign workspace and an unknown template: workspace RESOURCE_NOT_FOUND', async () => {
      const res = await post(
        a,
        wa(recipient(), { workspaceId: b.tenant.workspaceId, templateId: uuidv7() }),
      );
      expect(res.body.error.message).toBe('Workspace not found');
    });

    it('a non-dispatchable channel and an invalid phone: CHANNEL_NOT_SUPPORTED', async () => {
      const res = await post(a, { channelCode: 'voice', recipient: 'nope', payload: {} });
      expect(res.body.error.code).toBe(ERROR_CODES.CHANNEL_NOT_SUPPORTED);
    });
  });

  // --- 4. idempotency -------------------------------------------------------------

  describe('4. idempotency', () => {
    it('a keyed replay returns the identical body and status and writes nothing', async () => {
      const key = randomUUID();
      const body = wa(recipient());
      const first = await post(a, body, key).expect(202);
      const before = await counts(a.tenant.orgId);
      const second = await post(a, body, key);
      expect(second.status).toBe(202);
      expect(second.body).toStrictEqual(first.body);
      expect(await counts(a.tenant.orgId)).toEqual(before);
    });

    it('the stored request fingerprint is the five-field body under POST /messages', async () => {
      const key = randomUUID();
      const body = { ...sms(recipient()), workspaceId: secondWorkspaceId };
      await post(a, body, key).expect(202);
      const [row] = await h.admin
        .select()
        .from(schema.idempotencyKeys)
        .where(
          and(
            eq(schema.idempotencyKeys.orgId, a.tenant.orgId),
            eq(schema.idempotencyKeys.idempotencyKey, key),
          ),
        );
      expect(row).toMatchObject({
        endpoint: 'POST /messages',
        status: 'completed',
        responseStatusCode: 202,
        actorUserId: a.tenant.userId,
      });
      expect(row!.requestHash).toBe(
        fingerprint({
          method: 'POST',
          route: '/messages',
          orgId: a.tenant.orgId,
          principal: { actorType: 'user', userId: a.tenant.userId, apiKeyId: null } as never,
          pathParams: {},
          query: {},
          body: {
            channelCode: body.channelCode,
            recipient: body.recipient,
            templateId: body.templateId,
            workspaceId: body.workspaceId,
            payload: body.payload,
          },
        }),
      );
    });

    it('the same key with a different body: 422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, nothing written', async () => {
      const key = randomUUID();
      const to = recipient();
      await post(a, wa(to), key).expect(202);
      await expectRefused(
        () => post(a, { ...wa(to), payload: { text: 'different' } }, key),
        422,
        ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
        'This Idempotency-Key was already used for a different request',
      );
    });

    it('concurrent identical keyed requests create exactly one message', async () => {
      const key = randomUUID();
      const body = wa(recipient());
      const before = await counts(a.tenant.orgId);
      const results = await Promise.all(Array.from({ length: 6 }, () => post(a, body, key)));
      const ok = results.filter((r) => r.status === 202);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of results) expect([202, 409]).toContain(r.status);
      expect(new Set(ok.map((r) => r.body.data.id)).size).toBe(1);
      const after = await counts(a.tenant.orgId);
      expect(after.messages).toBe(before.messages + 1);
      expect(after.queue).toBe(before.queue + 1);
    });

    it('unkeyed identical requests create two messages (pinned; D-4 is decided before 7-4)', async () => {
      const body = wa(recipient());
      const before = await counts(a.tenant.orgId);
      const r1 = await post(a, body).expect(202);
      const r2 = await post(a, body).expect(202);
      expect(r2.body.data.id).not.toBe(r1.body.data.id);
      expect((await counts(a.tenant.orgId)).messages).toBe(before.messages + 2);
    });
  });

  // --- 5. concurrency -------------------------------------------------------------

  describe('5. concurrent first sends', () => {
    it('six parallel first sends to one new address: six messages, one contact, one identity', async () => {
      const to = recipient();
      const before = await counts(a.tenant.orgId);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          post(a, { ...wa(to), payload: { text: `first ${i}` } }, randomUUID()),
        ),
      );
      for (const r of results) expect(r.status).toBe(202);
      const ids = results.map((r) => r.body.data.id as string);
      const rows = await h.admin
        .select({ contactId: schema.messages.contactId })
        .from(schema.messages)
        .where(inArray(schema.messages.id, ids));
      expect(new Set(rows.map((r) => r.contactId)).size).toBe(1);
      const after = await counts(a.tenant.orgId);
      expect(after.messages).toBe(before.messages + 6);
      expect(after.contacts).toBe(before.contacts + 1);
      expect(after.identities).toBe(before.identities + 1);
    });
  });

  // --- 6. principals --------------------------------------------------------------

  describe('6. principals', () => {
    it('an API key carrying messages.send succeeds; its idempotency record names the key', async () => {
      const key = randomUUID();
      const to = recipient();
      const res = await post(apiKey, wa(to), key);
      await expectQueued(res, {
        orgId: a.tenant.orgId,
        workspaceId: a.tenant.workspaceId,
        code: 'whatsapp',
        address: to,
        templateId: null,
        payload: { text: 'Hello from 7-3' },
      });
      const [row] = await h.admin
        .select()
        .from(schema.idempotencyKeys)
        .where(eq(schema.idempotencyKeys.idempotencyKey, key));
      expect(row).toMatchObject({ actorApiKeyId: apiKeyIds[0], actorUserId: null });
    });

    it('a principal without messages.send: 403, a denial audit row, and nothing else written', async () => {
      const deniedCount = async () => {
        const { rows } = await h.admin.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM audit_logs
              WHERE actor_user_id = ${denied.tenant.userId} AND action = 'authorization.denied'`,
        );
        return Number(rows[0]!.n);
      };
      const audits = await deniedCount();
      await expectRefused(
        () => post(denied, wa(recipient()), randomUUID()),
        403,
        ERROR_CODES.AUTHZ_SCOPE_DENIED,
        'You do not have permission to perform this action',
        denied.tenant.orgId,
      );
      expect(await deniedCount()).toBe(audits + 1);
    });
  });
});
