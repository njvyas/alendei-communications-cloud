/**
 * Phase 4.2, Batch 1 — SMS dispatch through the simulator.
 *
 * 1. Organization-level SMS provider assignments and send eligibility, through
 *    the real API (platform administrator assigns; tenant sends).
 * 2. SMS enqueue → dispatch → provider submission → settlement. The dispatcher
 *    resolves the channel from the message (never a hardcoded WhatsApp) and
 *    hands the simulator the rendered approved template and its DLT metadata.
 * 3. SMS failure settlement, terminal and retryable, without rollback.
 * 4. Same-channel fallback from a failing primary SMS simulator to a secondary
 *    one, never to another channel's provider; and the primary's circuit opening
 *    on its fifth failure without a state-guard permission error (BE-DISPATCH-01).
 * 5. A stored SMS row without DLT metadata fails before any provider call.
 * 6. WhatsApp dispatch still submits as WhatsApp.
 *
 * Simulator providers only; no network. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import {
  PERMISSIONS,
  PLATFORM_ROLE_KEYS,
  type ProviderAdapterContext,
  type ProviderSubmission,
  type SmsDltMetadata,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import { SimulatorAdapter } from '../src/provider-adapters/simulator.adapter';
import {
  createTenant,
  destroyTenant,
  PASSWORD,
  PREFIX,
  purgeAudit,
  purgeMessageEvents,
  purgeProviderHealth,
  removeIdentities,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (path: string) => `/${PREFIX}${path}`;

const TEMPLATE_DLT: SmsDltMetadata = {
  entityId: '1201159123456789012',
  templateId: '1207161234567890123',
  headerId: 'ALENDE',
};

interface SmsTenant {
  readonly tenant: TenantFixture;
  readonly token: string;
  readonly templateId: string;
}

describe('Phase 4.2 Batch 1: SMS simulator dispatch, channel resolution and SMS assignments', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  let smsChannelId: string;
  let whatsappChannelId: string;
  let platformToken: string;
  let platformUserId: string;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const customRoles: string[] = [];

  /** Every call that reached the simulated provider: its context and submission. */
  let simulated: jest.SpyInstance;
  const calls = () =>
    simulated.mock.calls.map((args: unknown[]) => ({
      context: args[1] as ProviderAdapterContext,
      submission: args[2] as ProviderSubmission,
    }));

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);

    const channels = await h.admin.select().from(schema.channels);
    smsChannelId = channels.find((c) => c.code === 'sms')!.id;
    whatsappChannelId = channels.find((c) => c.code === 'whatsapp')!.id;

    // A platform administrator who can sign in: assignments are platform-only.
    const email = `p42-platform-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
    const [user] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    platformUserId = user!.id;
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
            isNull(schema.roles.orgId),
          ),
        );
      await tx
        .insert(schema.userRoles)
        .values({ userId: platformUserId, roleId: role!.id, scopeType: 'platform' });
    });
    platformToken = await login(email);
  }, 60_000);

  beforeEach(() => {
    simulated = jest.spyOn(
      SimulatorAdapter.prototype as unknown as { simulate: () => unknown },
      'simulate',
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await h.admin.delete(schema.messageDispatchQueue);
  });

  afterAll(async () => {
    try {
      if (dispatchPool) await dispatchPool.end();
      const orgIds = tenants.map((t) => t.orgId);
      // Health samples reference attempts: they go first.
      if (providers.length > 0) {
        await purgeProviderHealth(
          h.admin,
          inArray(schema.providerHealth.providerId, providers),
        ).catch(() => {});
      }
      if (orgIds.length > 0) {
        await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, orgIds)).catch(
          () => {},
        );
        await h.admin
          .delete(schema.messageAttempts)
          .where(inArray(schema.messageAttempts.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.messages)
          .where(inArray(schema.messages.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(inArray(schema.organizationProviderAssignments.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.templates)
          .where(inArray(schema.templates.orgId, orgIds))
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
      }
      // Only this suite's custom roles; the tenants' system roles go with destroyTenant.
      if (customRoles.length > 0) {
        await h.admin
          .delete(schema.userRoles)
          .where(inArray(schema.userRoles.roleId, customRoles))
          .catch(() => {});
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, customRoles))
          .catch(() => {});
        await h.admin
          .delete(schema.roles)
          .where(inArray(schema.roles.id, customRoles))
          .catch(() => {});
      }
      if (providers.length > 0) {
        await h.admin
          .delete(schema.providerCapabilities)
          .where(inArray(schema.providerCapabilities.providerId, providers))
          .catch(() => {});
      }
      await removeIdentities(h.admin, [platformUserId]).catch(() => {});
      for (const t of tenants) await destroyTenant(h.admin, t).catch(() => {});
      if (providers.length > 0) {
        await purgeAudit(h.admin, inArray(sql`resource_id`, providers)).catch(() => {});
        await h.admin
          .delete(schema.providers)
          .where(inArray(schema.providers.id, providers))
          .catch(() => {});
      }
    } finally {
      await h.close();
    }
  });

  async function login(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  /** A tenant whose user may send and read messages, with an approved DLT-bound SMS template. */
  async function smsTenant(label: string): Promise<SmsTenant> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);

    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [
          PERMISSIONS.MESSAGES_SEND,
          PERMISSIONS.MESSAGES_READ,
          PERMISSIONS.TEMPLATES_READ,
          PERMISSIONS.CONTACTS_READ,
        ]),
      );
    const roleId = uuidv7();
    customRoles.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `p42_role_${randomBytes(4).toString('hex')}`,
      name: 'Phase 4.2 Test Role',
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

    const [template] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenant.orgId,
        channelId: smsChannelId,
        name: `p42_otp_${randomBytes(3).toString('hex')}`,
        body: 'Your verification code is {{1}}.',
        variables: { names: ['1'], dlt: TEMPLATE_DLT },
        approvalStatus: 'approved',
      })
      .returning();

    return { tenant, token: await login(tenant.email), templateId: template!.id };
  }

  async function createProvider(
    channelId: string,
    label: string,
    simulatorBehavior?: string,
  ): Promise<string> {
    const slug = `${label}-${randomBytes(4).toString('hex')}`;
    const [provider] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `Phase 4.2 ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(provider!.id);
    if (simulatorBehavior) {
      await h.admin.insert(schema.providerCapabilities).values({
        providerId: provider!.id,
        capabilityKey: 'simulator_behavior',
        value: simulatorBehavior,
      });
    }
    return provider!.id;
  }

  async function assign(orgId: string, channelId: string, providerId: string, priority: number) {
    await h.admin
      .insert(schema.organizationProviderAssignments)
      .values({ orgId, channelId, providerId, priority, status: 'active' });
  }

  function sendSms(t: SmsTenant, recipient: string, code: string) {
    return request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${t.token}`)
      .set('X-Acc-Organization', t.tenant.orgId)
      .send({
        channelCode: 'sms',
        recipient,
        templateId: t.templateId,
        payload: { variables: { '1': code } },
      });
  }

  /** Claims and processes exactly one queued message; fails the test if none is claimable. */
  async function dispatchOnce(expectedMessageId: string) {
    const [claim] = await dispatcher.claimBatch(1);
    expect(claim?.messageId).toBe(expectedMessageId);
    return dispatcher.processClaim(claim!);
  }

  async function messageRow(id: string) {
    const [m] = await h.admin.select().from(schema.messages).where(eq(schema.messages.id, id));
    return m!;
  }

  async function attemptsOf(id: string) {
    return h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, id))
      .orderBy(schema.messageAttempts.attemptNumber);
  }

  async function eventsOf(id: string) {
    const rows = await h.admin
      .select({ type: schema.messageEvents.eventType })
      .from(schema.messageEvents)
      .where(eq(schema.messageEvents.messageId, id))
      .orderBy(schema.messageEvents.createdAt, schema.messageEvents.id);
    return rows.map((r) => r.type);
  }

  describe('1. organization-level SMS provider assignment and send eligibility', () => {
    it('refuses SMS before an SMS assignment exists, and accepts it once the platform assigns an SMS simulator', async () => {
      const t = await smsTenant('p42-elig');
      const smsProvider = await createProvider(smsChannelId, 'elig-sms');
      // A WhatsApp assignment does not make the organization SMS-eligible.
      await assign(
        t.tenant.orgId,
        whatsappChannelId,
        await createProvider(whatsappChannelId, 'elig-wa'),
        1,
      );

      const refused = await sendSms(t, '+12025550160', '111111');
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('NO_ACTIVE_PROVIDER_ASSIGNMENT');

      const assigned = await request(h.app.getHttpServer())
        .post(url(`/organizations/${t.tenant.orgId}/provider-assignments`))
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ providerId: smsProvider, priority: 1 });
      expect(assigned.status).toBe(201);
      expect(assigned.body.data.channelId).toBe(smsChannelId);
      expect(assigned.body.data.providerId).toBe(smsProvider);
      expect(assigned.body.data.status).toBe('active');

      const accepted = await sendSms(t, '+12025550160', '111111');
      expect(accepted.status).toBe(202);
      expect((await messageRow(accepted.body.data.id)).channelId).toBe(smsChannelId);
    });
  });

  describe('2. SMS enqueue, dispatch, provider submission and settlement', () => {
    it('submits the rendered approved template with its DLT metadata to the SMS simulator as channel sms, and settles accepted', async () => {
      const t = await smsTenant('p42-ok');
      const sms = await createProvider(smsChannelId, 'ok-sms');
      const wa = await createProvider(whatsappChannelId, 'ok-wa');
      await assign(t.tenant.orgId, smsChannelId, sms, 1);
      await assign(t.tenant.orgId, whatsappChannelId, wa, 1);

      const res = await sendSms(t, '+12025550161', '654321');
      expect(res.status).toBe(202);
      const messageId = res.body.data.id as string;

      const outcome = await dispatchOnce(messageId);
      expect(outcome.outcome).toBe('accepted');

      expect(calls()).toHaveLength(1);
      const [{ context, submission }] = calls();
      expect(context.channel).toBe('sms');
      expect(context.providerId).toBe(sms);
      expect(submission.channel).toBe('sms');
      expect(submission.submissionId).toBe(messageId);
      expect(submission.recipient).toBe('+12025550161');
      expect(submission.content).toEqual({ text: 'Your verification code is 654321.' });
      expect(submission.sms).toEqual({ dlt: TEMPLATE_DLT });

      const message = await messageRow(messageId);
      expect(message.status).toBe('accepted');
      expect(message.completedAt).not.toBeNull();
      const attempts = await attemptsOf(messageId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.providerId).toBe(sms);
      expect(attempts[0]!.channelId).toBe(smsChannelId);
      expect(attempts[0]!.status).toBe('accepted');
      expect(await eventsOf(messageId)).toEqual([
        'message.queued',
        'message.submitting',
        'message.accepted',
      ]);
      const [queued] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queued).toBeUndefined();
    });

    it('a non-retryable SMS rejection settles the message failed on its only provider, with no fallback and no rollback', async () => {
      const t = await smsTenant('p42-term');
      const primary = await createProvider(smsChannelId, 'term-sms-1', 'INVALID_CREDENTIALS');
      const secondary = await createProvider(smsChannelId, 'term-sms-2');
      await assign(t.tenant.orgId, smsChannelId, primary, 1);
      await assign(t.tenant.orgId, smsChannelId, secondary, 2);

      const res = await sendSms(t, '+12025550162', '222222');
      expect(res.status).toBe(202);
      const messageId = res.body.data.id as string;

      const outcome = await dispatchOnce(messageId);
      expect(outcome.outcome).toBe('failed');
      expect(outcome.error).toContain('AUTH_ERROR');

      const message = await messageRow(messageId);
      expect(message.status).toBe('failed');
      const attempts = await attemptsOf(messageId);
      expect(attempts.map((a) => [a.providerId, a.status])).toEqual([[primary, 'failed']]);
      expect(calls().map((c) => c.submission.channel)).toEqual(['sms']);
      expect(await dispatcher.claimBatch(1)).toEqual([]);
    });
  });

  describe('3. same-channel fallback and the SMS circuit', () => {
    it('falls back from a failing primary SMS simulator to the secondary SMS simulator, never to the WhatsApp provider', async () => {
      const t = await smsTenant('p42-fb');
      const primary = await createProvider(smsChannelId, 'fb-sms-1', '500');
      const secondary = await createProvider(smsChannelId, 'fb-sms-2');
      const wa = await createProvider(whatsappChannelId, 'fb-wa');
      await assign(t.tenant.orgId, smsChannelId, primary, 1);
      await assign(t.tenant.orgId, smsChannelId, secondary, 2);
      await assign(t.tenant.orgId, whatsappChannelId, wa, 1);

      const res = await sendSms(t, '+12025550163', '333333');
      expect(res.status).toBe(202);
      const messageId = res.body.data.id as string;

      const first = await dispatchOnce(messageId);
      expect(first.outcome).toBe('failed');
      expect(first.error).toContain('PROVIDER_ERROR');
      expect((await messageRow(messageId)).status).toBe('queued');

      const second = await dispatchOnce(messageId);
      expect(second.outcome).toBe('accepted');

      expect((await messageRow(messageId)).status).toBe('accepted');
      const attempts = await attemptsOf(messageId);
      expect(attempts.map((a) => [a.attemptNumber, a.providerId, a.status])).toEqual([
        [1, primary, 'failed'],
        [2, secondary, 'accepted'],
      ]);
      expect(attempts.every((a) => a.channelId === smsChannelId)).toBe(true);
      const seen = calls();
      expect(seen.map((c) => c.context.providerId)).toEqual([primary, secondary]);
      expect(seen.every((c) => c.submission.channel === 'sms' && c.context.channel === 'sms')).toBe(
        true,
      );
      expect(seen.every((c) => c.submission.sms?.dlt.templateId === TEMPLATE_DLT.templateId)).toBe(
        true,
      );
    });

    it('the fifth primary failure opens its circuit without a state-guard error; each message still settles on the secondary', async () => {
      const t = await smsTenant('p42-circ');
      const primary = await createProvider(smsChannelId, 'circ-sms-1', '500');
      const secondary = await createProvider(smsChannelId, 'circ-sms-2');
      await assign(t.tenant.orgId, smsChannelId, primary, 1);
      await assign(t.tenant.orgId, smsChannelId, secondary, 2);

      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await sendSms(t, `+1202555017${i}`, `40000${i}`);
        expect(res.status).toBe(202);
        const messageId = res.body.data.id as string;
        ids.push(messageId);

        const failed = await dispatchOnce(messageId);
        // A rolled-back settlement would surface as 'unknown' (BE-DISPATCH-01).
        expect(failed.outcome).toBe('failed');
        expect(failed.error).toContain('PROVIDER_ERROR');
        const accepted = await dispatchOnce(messageId);
        expect(accepted.outcome).toBe('accepted');
      }

      const [p] = await h.admin
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, primary));
      expect(p!.circuitState).toBe('open');
      expect(Number(p!.circuitGeneration)).toBe(1);
      expect(p!.healthState).toBe('offline');

      const settled = await h.admin
        .select({ status: schema.messages.status })
        .from(schema.messages)
        .where(inArray(schema.messages.id, ids));
      expect(settled.map((m) => m.status)).toEqual(Array(5).fill('accepted'));

      // With the primary's circuit open, the next SMS goes straight to the secondary.
      const res = await sendSms(t, '+12025550175', '500005');
      const next = await dispatchOnce(res.body.data.id as string);
      expect(next.outcome).toBe('accepted');
      expect((await attemptsOf(res.body.data.id as string)).map((a) => a.providerId)).toEqual([
        secondary,
      ]);
    });
  });

  describe('4. stored payloads that cannot be submitted', () => {
    it('an SMS row without DLT metadata fails before any attempt or provider call', async () => {
      const t = await smsTenant('p42-bad');
      await assign(t.tenant.orgId, smsChannelId, await createProvider(smsChannelId, 'bad-sms'), 1);

      const contactId = uuidv7();
      await h.admin.insert(schema.contacts).values({
        id: contactId,
        orgId: t.tenant.orgId,
        workspaceId: t.tenant.workspaceId,
        displayName: 'Legacy row',
      });
      const messageId = uuidv7();
      await h.admin.insert(schema.messages).values({
        id: messageId,
        orgId: t.tenant.orgId,
        workspaceId: t.tenant.workspaceId,
        contactId,
        channelId: smsChannelId,
        recipientAddress: '+12025550164',
        status: 'queued',
        payload: { text: 'Written outside the send path' },
        correlationId: uuidv7(),
      });
      await h.admin.insert(schema.messageDispatchQueue).values({
        messageId,
        orgId: t.tenant.orgId,
        priority: 1,
        dispatchEpoch: 0,
        claimedUntil: null,
        claimToken: null,
      });

      const outcome = await dispatchOnce(messageId);
      expect(outcome.outcome).toBe('failed');
      expect(outcome.error).toMatch(/^SMS_PAYLOAD_INVALID: /);

      const message = await messageRow(messageId);
      expect(message.status).toBe('failed');
      expect(message.failureReason).toMatch(/^SMS_PAYLOAD_INVALID: /);
      expect(await attemptsOf(messageId)).toHaveLength(0);
      expect(calls()).toHaveLength(0);
      expect(await dispatcher.claimBatch(1)).toEqual([]);
    });
  });

  describe('5. WhatsApp is unchanged', () => {
    it('a WhatsApp message is still submitted as whatsapp with its payload text and no SMS metadata', async () => {
      const t = await smsTenant('p42-wa');
      const wa = await createProvider(whatsappChannelId, 'wa-only');
      await assign(t.tenant.orgId, whatsappChannelId, wa, 1);

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${t.token}`)
        .set('X-Acc-Organization', t.tenant.orgId)
        .send({
          channelCode: 'whatsapp',
          recipient: '+12025550165',
          payload: { type: 'text', text: 'Hello from WhatsApp' },
        });
      expect(res.status).toBe(202);

      const outcome = await dispatchOnce(res.body.data.id as string);
      expect(outcome.outcome).toBe('accepted');
      const [{ context, submission }] = calls();
      expect(context.channel).toBe('whatsapp');
      expect(submission.channel).toBe('whatsapp');
      expect(submission.content).toEqual({ text: 'Hello from WhatsApp' });
      expect(submission.sms).toBeUndefined();
    });
  });
});
