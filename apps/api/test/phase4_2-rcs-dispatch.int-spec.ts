/**
 * Phase 4.2, Batch 2 — RCS dispatch through the simulator.
 *
 * 1. Each ADR-016 D-4 RCS type (text, media, single rich card) goes from
 *    POST /messages to the simulator whole, as channel rcs, and settles accepted.
 * 2. Content eligibility: a provider whose rcs_message_types excludes the type is
 *    skipped before circuit admission (no attempt, no provider call); with no
 *    eligible provider the message fails NO_ELIGIBLE_PROVIDER with no attempt.
 *    An invalid stored declaration carries nothing (fail closed).
 * 3. Same-channel fallback only, in an organization assigned on WhatsApp, SMS
 *    and RCS; fallback that reaches an ineligible secondary ends
 *    NO_ELIGIBLE_PROVIDER; the primary's circuit opens on its fifth failure.
 * 4. A stored RCS payload that is no longer valid fails before any attempt.
 *
 * Simulator providers only; no network. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import {
  PERMISSIONS,
  type ProviderAdapterContext,
  type ProviderSubmission,
  type RcsBasicPayload,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  purgeMessageEvents,
  purgeProviderHealth,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (path: string) => `/${PREFIX}${path}`;

const TEXT: RcsBasicPayload = {
  messageType: 'text',
  text: 'Your table is ready.',
  suggestions: [{ type: 'reply', text: 'On my way', postbackData: 'omw' }],
};
const MEDIA: RcsBasicPayload = {
  messageType: 'media',
  media: { url: 'https://example.com/menu.png', mimeType: 'image/png', height: 'MEDIUM' },
};
const CARD: RcsBasicPayload = {
  messageType: 'rich_card',
  card: {
    title: 'Weekend offer',
    description: '20% off all mains',
    media: { url: 'https://example.com/offer.jpg', height: 'TALL' },
    suggestions: [
      {
        type: 'action_open_url',
        text: 'Book',
        postbackData: 'book',
        url: 'https://example.com/book',
      },
      { type: 'action_dial', text: 'Call', postbackData: 'call', phoneNumber: '+12025550190' },
    ],
  },
};

interface SendTenant {
  readonly tenant: TenantFixture;
  readonly token: string;
}

describe('Phase 4.2 Batch 2: RCS simulator dispatch, content eligibility and same-channel fallback', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  let rcsChannelId: string;
  let smsChannelId: string;
  let whatsappChannelId: string;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const customRoles: string[] = [];

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
    rcsChannelId = channels.find((c) => c.code === 'rcs')!.id;
    smsChannelId = channels.find((c) => c.code === 'sms')!.id;
    whatsappChannelId = channels.find((c) => c.code === 'whatsapp')!.id;
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

  async function sendTenant(label: string): Promise<SendTenant> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
      );
    const roleId = uuidv7();
    customRoles.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `p42r_role_${randomBytes(4).toString('hex')}`,
      name: 'Phase 4.2 RCS Test Role',
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
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: login.body.data.accessToken as string };
  }

  async function provider(
    channelId: string,
    label: string,
    options: { behavior?: string; rcsTypes?: unknown } = {},
  ): Promise<string> {
    const slug = `${label}-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `Phase 4.2 RCS ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    if (options.behavior) {
      await h.admin.insert(schema.providerCapabilities).values({
        providerId: p!.id,
        capabilityKey: 'simulator_behavior',
        value: options.behavior,
      });
    }
    if (options.rcsTypes !== undefined) {
      // Written directly: this suite tests what the dispatcher does with any
      // stored value; the API's validation of the key is tested in the
      // security suite.
      await h.admin.insert(schema.providerCapabilities).values({
        providerId: p!.id,
        capabilityKey: 'rcs_message_types',
        value: options.rcsTypes,
      });
    }
    return p!.id;
  }

  async function assign(orgId: string, channelId: string, providerId: string, priority: number) {
    await h.admin
      .insert(schema.organizationProviderAssignments)
      .values({ orgId, channelId, providerId, priority, status: 'active' });
  }

  async function sendRcs(t: SendTenant, recipient: string, payload: RcsBasicPayload) {
    const res = await request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${t.token}`)
      .set('X-Acc-Organization', t.tenant.orgId)
      .send({ channelCode: 'rcs', recipient, payload });
    expect(res.status).toBe(202);
    return res.body.data.id as string;
  }

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

  async function failedEvents(id: string) {
    return h.admin
      .select({ payload: schema.messageEvents.payload })
      .from(schema.messageEvents)
      .where(
        and(
          eq(schema.messageEvents.messageId, id),
          eq(schema.messageEvents.eventType, 'message.failed'),
        ),
      );
  }

  /** Terminal NO_ELIGIBLE_PROVIDER at claim time: no stuck claim, nothing to recover. */
  async function expectNoEligible(id: string, attempts: number) {
    const m = await messageRow(id);
    expect(m.status).toBe('failed');
    expect(m.failureReason).toBe('NO_ELIGIBLE_PROVIDER');
    expect(m.completedAt).not.toBeNull();
    expect(await attemptsOf(id)).toHaveLength(attempts);
    const events = await failedEvents(id);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { reason?: string }).reason).toBe('NO_ELIGIBLE_PROVIDER');
    expect(await dispatcher.claimBatch(1)).toEqual([]);
    expect(await dispatcher.recoverExpiredLeases()).toBe(0);
  }

  describe('1. each RCS type is submitted whole and settles accepted', () => {
    it.each([
      ['text', TEXT, 'Your table is ready.'],
      ['media', MEDIA, ''],
      ['rich_card', CARD, 'Weekend offer\n20% off all mains'],
    ] as const)('%s', async (_type, payload, renderedText) => {
      const t = await sendTenant(`rcs-ok-${_type}`);
      const rcs = await provider(rcsChannelId, `ok-${_type}`);
      await assign(t.tenant.orgId, rcsChannelId, rcs, 1);

      const id = await sendRcs(t, '+12025550191', payload);
      expect((await dispatchOnce(id)).outcome).toBe('accepted');

      expect(calls()).toHaveLength(1);
      const [{ context, submission }] = calls();
      expect(context.channel).toBe('rcs');
      expect(context.providerId).toBe(rcs);
      expect(submission.channel).toBe('rcs');
      expect(submission.rcs).toEqual(payload);
      expect(submission.content).toEqual({ text: renderedText });
      expect(submission.sms).toBeUndefined();

      expect((await messageRow(id)).status).toBe('accepted');
      const attempts = await attemptsOf(id);
      expect(attempts.map((a) => [a.providerId, a.channelId, a.status])).toEqual([
        [rcs, rcsChannelId, 'accepted'],
      ]);
    });
  });

  describe('2. content eligibility', () => {
    it('skips a provider that declares it does not carry the type — no attempt, no call — and uses the next eligible one', async () => {
      const t = await sendTenant('rcs-skip');
      const textOnly = await provider(rcsChannelId, 'skip-text-only', { rcsTypes: ['text'] });
      const undeclared = await provider(rcsChannelId, 'skip-all');
      await assign(t.tenant.orgId, rcsChannelId, textOnly, 1);
      await assign(t.tenant.orgId, rcsChannelId, undeclared, 2);

      const id = await sendRcs(t, '+12025550192', CARD);
      expect((await dispatchOnce(id)).outcome).toBe('accepted');

      expect(calls().map((c) => c.context.providerId)).toEqual([undeclared]);
      expect((await attemptsOf(id)).map((a) => a.providerId)).toEqual([undeclared]);
      // The skipped provider took no admission: no health sample was recorded for it.
      const samples = await h.admin
        .select()
        .from(schema.providerHealth)
        .where(eq(schema.providerHealth.providerId, textOnly));
      expect(samples).toHaveLength(0);
    });

    it('with no eligible provider: failed NO_ELIGIBLE_PROVIDER, no attempt, no provider call', async () => {
      const t = await sendTenant('rcs-none');
      await assign(
        t.tenant.orgId,
        rcsChannelId,
        await provider(rcsChannelId, 'none-text', { rcsTypes: ['text', 'rich_card'] }),
        1,
      );

      const id = await sendRcs(t, '+12025550193', MEDIA);
      expect(await dispatchOnce(id)).toEqual({
        messageId: id,
        outcome: 'failed',
        error: 'NO_ELIGIBLE_PROVIDER',
      });
      expect(calls()).toHaveLength(0);
      await expectNoEligible(id, 0);
      const [event] = await failedEvents(id);
      expect((event!.payload as { details?: string }).details).toContain('media');
    });

    it('an invalid stored declaration carries nothing (fail closed)', async () => {
      const t = await sendTenant('rcs-badcap');
      await assign(
        t.tenant.orgId,
        rcsChannelId,
        await provider(rcsChannelId, 'badcap', { rcsTypes: ['text', 'carousel'] }),
        1,
      );
      const id = await sendRcs(t, '+12025550194', TEXT);
      expect((await dispatchOnce(id)).error).toBe('NO_ELIGIBLE_PROVIDER');
      expect(calls()).toHaveLength(0);
      await expectNoEligible(id, 0);
    });
  });

  describe('3. same-channel fallback and the RCS circuit', () => {
    it('falls back from a failing RCS primary to the RCS secondary only, in an organization also assigned on WhatsApp and SMS', async () => {
      const t = await sendTenant('rcs-fb');
      const primary = await provider(rcsChannelId, 'fb-500', { behavior: '500' });
      const secondary = await provider(rcsChannelId, 'fb-ok');
      const sms = await provider(smsChannelId, 'fb-sms');
      const wa = await provider(whatsappChannelId, 'fb-wa');
      await assign(t.tenant.orgId, rcsChannelId, primary, 1);
      await assign(t.tenant.orgId, rcsChannelId, secondary, 2);
      await assign(t.tenant.orgId, smsChannelId, sms, 1);
      await assign(t.tenant.orgId, whatsappChannelId, wa, 1);

      const id = await sendRcs(t, '+12025550195', CARD);
      const first = await dispatchOnce(id);
      expect(first.outcome).toBe('failed');
      expect(first.error).toContain('PROVIDER_ERROR');
      expect((await messageRow(id)).status).toBe('queued');
      expect((await dispatchOnce(id)).outcome).toBe('accepted');

      expect((await messageRow(id)).status).toBe('accepted');
      const attempts = await attemptsOf(id);
      expect(attempts.map((a) => [a.providerId, a.status])).toEqual([
        [primary, 'failed'],
        [secondary, 'accepted'],
      ]);
      expect(attempts.every((a) => a.channelId === rcsChannelId)).toBe(true);
      const seen = calls();
      expect(seen.map((c) => c.context.providerId)).toEqual([primary, secondary]);
      expect(seen.every((c) => c.context.channel === 'rcs' && c.submission.channel === 'rcs')).toBe(
        true,
      );
      // jsonb does not keep key order, so compare structurally.
      for (const c of seen) expect(c.submission.rcs).toEqual(CARD);
    });

    it('fallback that reaches only an ineligible secondary ends NO_ELIGIBLE_PROVIDER, the first attempt kept', async () => {
      const t = await sendTenant('rcs-fb-inel');
      const primary = await provider(rcsChannelId, 'inel-500', { behavior: '500' });
      const textOnly = await provider(rcsChannelId, 'inel-text', { rcsTypes: ['text'] });
      await assign(t.tenant.orgId, rcsChannelId, primary, 1);
      await assign(t.tenant.orgId, rcsChannelId, textOnly, 2);

      const id = await sendRcs(t, '+12025550196', MEDIA);
      expect((await dispatchOnce(id)).error).toContain('PROVIDER_ERROR');
      expect(await dispatchOnce(id)).toEqual({
        messageId: id,
        outcome: 'failed',
        error: 'NO_ELIGIBLE_PROVIDER',
      });
      expect(calls().map((c) => c.context.providerId)).toEqual([primary]);
      await expectNoEligible(id, 1);
    });

    it('the fifth primary failure opens its circuit without a state-guard error; every message settles on the secondary', async () => {
      const t = await sendTenant('rcs-circ');
      const primary = await provider(rcsChannelId, 'circ-500', { behavior: '500' });
      const secondary = await provider(rcsChannelId, 'circ-ok');
      await assign(t.tenant.orgId, rcsChannelId, primary, 1);
      await assign(t.tenant.orgId, rcsChannelId, secondary, 2);

      for (let i = 0; i < 5; i++) {
        const id = await sendRcs(t, `+1202555017${i}`, TEXT);
        const failed = await dispatchOnce(id);
        expect(failed.outcome).toBe('failed'); // a rolled-back settlement would be 'unknown'
        expect((await dispatchOnce(id)).outcome).toBe('accepted');
        expect((await messageRow(id)).status).toBe('accepted');
      }
      const [p] = await h.admin
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, primary));
      expect(p!.circuitState).toBe('open');
      expect(Number(p!.circuitGeneration)).toBe(1);
    });
  });

  describe('4. stored payloads that cannot be submitted', () => {
    it('a stored RCS payload with an unsafe URL fails RCS_PAYLOAD_INVALID before any attempt or provider call', async () => {
      const t = await sendTenant('rcs-bad');
      await assign(t.tenant.orgId, rcsChannelId, await provider(rcsChannelId, 'bad-ok'), 1);

      const contactId = uuidv7();
      await h.admin.insert(schema.contacts).values({
        id: contactId,
        orgId: t.tenant.orgId,
        workspaceId: t.tenant.workspaceId,
        displayName: 'Legacy RCS row',
      });
      const id = uuidv7();
      await h.admin.insert(schema.messages).values({
        id,
        orgId: t.tenant.orgId,
        workspaceId: t.tenant.workspaceId,
        contactId,
        channelId: rcsChannelId,
        recipientAddress: '+12025550197',
        status: 'queued',
        payload: {
          messageType: 'text',
          text: 'Written outside the send path',
          suggestions: [
            { type: 'action_open_url', text: 'Go', postbackData: 'go', url: 'javascript:alert(1)' },
          ],
        },
        correlationId: uuidv7(),
      });
      await h.admin.insert(schema.messageDispatchQueue).values({
        messageId: id,
        orgId: t.tenant.orgId,
        priority: 1,
        dispatchEpoch: 0,
        claimedUntil: null,
        claimToken: null,
      });

      const outcome = await dispatchOnce(id);
      expect(outcome.outcome).toBe('failed');
      expect(outcome.error).toMatch(/^RCS_PAYLOAD_INVALID: /);
      const m = await messageRow(id);
      expect(m.status).toBe('failed');
      expect(m.failureReason).toMatch(/^RCS_PAYLOAD_INVALID: /);
      expect(await attemptsOf(id)).toHaveLength(0);
      expect(await failedEvents(id)).toHaveLength(1);
      expect(calls()).toHaveLength(0);
      expect(await dispatcher.claimBatch(1)).toEqual([]);
    });
  });
});
