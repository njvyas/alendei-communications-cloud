/**
 * Phase 4.3 (Gate F.3), batch F.3-2: SMS and RCS through the dispatcher's
 * concurrency, fencing and recovery paths.
 *
 * The Phase 3 suites that cover claiming, fencing and lease recovery seed
 * WhatsApp messages only. This suite drives the same paths with SMS and RCS
 * messages sent through the real API, and checks what reaches the simulator:
 *   1. concurrent workers on a mixed WhatsApp/SMS/RCS queue claim disjoint
 *      messages and settle each exactly once, each on its own channel;
 *   2. an expired lease is re-claimed at the next epoch; the stale worker is
 *      fenced before any provider call, and the new one submits the SMS DLT
 *      metadata or the RCS payload intact;
 *   3. a stale worker is fenced during SMS same-channel fallback, which still
 *      completes on the secondary SMS provider;
 *   4. a submission interrupted mid-flight is recovered `outcome_unknown` and is
 *      never resubmitted.
 *
 * Simulator providers only; no network. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import {
  PERMISSIONS,
  type ChannelCode,
  type ProviderAdapterContext,
  type ProviderSubmission,
  type RcsBasicPayload,
  type SmsDltMetadata,
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
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  purgeProviderHealth,
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
    ],
  },
};

type Dispatchable = Extract<ChannelCode, 'whatsapp' | 'sms' | 'rcs'>;

interface Sender {
  readonly tenant: TenantFixture;
  readonly token: string;
  readonly smsTemplateId: string;
}

describe('Phase 4.3 F.3-2: SMS and RCS through dispatcher concurrency, fencing and recovery', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  const channelIds = {} as Record<Dispatchable, string>;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const customRoles: string[] = [];
  let recipientSeq = 0;

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
    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['whatsapp', 'sms', 'rcs']));
    for (const row of rows) channelIds[row.code as Dispatchable] = row.id;
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
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
      }
      // Only this suite's custom roles; the tenants' own roles go with destroyTenant.
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
      for (const t of tenants) await destroyTenant(h.admin, t).catch(() => {});
      if (providers.length > 0) {
        await h.admin
          .delete(schema.providerCapabilities)
          .where(inArray(schema.providerCapabilities.providerId, providers))
          .catch(() => {});
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

  /** A tenant whose user may send and read messages, with an approved DLT-bound SMS template. */
  async function sender(label: string): Promise<Sender> {
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
      key: `p43_res_${randomBytes(4).toString('hex')}`,
      name: 'Phase 4.3 resilience sender',
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
        channelId: channelIds.sms,
        name: `p43_otp_${randomBytes(3).toString('hex')}`,
        body: 'Your verification code is {{1}}.',
        variables: { names: ['1'], dlt: TEMPLATE_DLT },
        approvalStatus: 'approved',
      })
      .returning();
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: login.body.data.accessToken as string, smsTemplateId: template!.id };
  }

  /** An active simulator provider on `channel`, assigned to the tenant at `priority`. */
  async function assigned(
    s: Sender,
    channel: Dispatchable,
    priority: number,
    behavior = 'SUCCESS',
  ): Promise<string> {
    const slug = `p43-res-${channel}-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelIds[channel],
        name: `Phase 4.3 ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    await h.admin.insert(schema.providerCapabilities).values({
      providerId: p!.id,
      capabilityKey: 'simulator_behavior',
      value: behavior,
    });
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: s.tenant.orgId,
      channelId: channelIds[channel],
      providerId: p!.id,
      priority,
      status: 'active',
    });
    return p!.id;
  }

  /** Sequential sends only, each to a fresh recipient (see `dispatch-worker.int-spec.ts`). */
  async function send(s: Sender, channel: Dispatchable): Promise<string> {
    recipientSeq += 1;
    const recipient = `+1202555${String(3000 + recipientSeq).padStart(4, '0')}`;
    const body =
      channel === 'sms'
        ? {
            channelCode: 'sms',
            recipient,
            templateId: s.smsTemplateId,
            payload: { variables: { '1': '424242' } },
          }
        : channel === 'rcs'
          ? { channelCode: 'rcs', recipient, payload: CARD }
          : { channelCode: 'whatsapp', recipient, payload: { text: 'Hello' } };
    const res = await request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Acc-Organization', s.tenant.orgId)
      .send(body);
    expect(res.status).toBe(202);
    return res.body.data.id as string;
  }

  async function messageRow(id: string) {
    const [m] = await h.admin.select().from(schema.messages).where(eq(schema.messages.id, id));
    return m!;
  }

  const attemptsOf = (id: string) =>
    h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, id))
      .orderBy(schema.messageAttempts.attemptNumber);

  async function queueRow(id: string) {
    const [row] = await h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, id));
    return row;
  }

  async function expireLease(id: string) {
    await h.admin
      .update(schema.messageDispatchQueue)
      .set({ claimedUntil: new Date(Date.now() - 1_000) })
      .where(eq(schema.messageDispatchQueue.messageId, id));
  }

  /** What the simulator must have received for a message of this channel. */
  function expectChannelSubmission(channel: Dispatchable, submission: ProviderSubmission) {
    expect(submission.channel).toBe(channel);
    if (channel === 'sms') {
      expect(submission.content.text).toBe('Your verification code is 424242.');
      expect(submission.sms).toEqual({ dlt: TEMPLATE_DLT });
      expect(submission.rcs).toBeUndefined();
    } else if (channel === 'rcs') {
      expect(submission.rcs).toEqual(CARD);
      expect(submission.content.text).toBe('Weekend offer\n20% off all mains');
      expect(submission.sms).toBeUndefined();
    } else {
      expect(submission.content.text).toBe('Hello');
      expect(submission.sms).toBeUndefined();
      expect(submission.rcs).toBeUndefined();
    }
  }

  // --- 1. concurrency ---------------------------------------------------------

  it('concurrent workers on a mixed WhatsApp/SMS/RCS queue claim disjoint messages and settle each once, on its own channel', async () => {
    const s = await sender('p43-res-mixed');
    const providerChannel = new Map<string, Dispatchable>();
    for (const channel of ['whatsapp', 'sms', 'rcs'] as const) {
      providerChannel.set(await assigned(s, channel, 1), channel);
    }
    const channelOf = new Map<string, Dispatchable>();
    for (const channel of ['whatsapp', 'sms', 'rcs'] as const) {
      for (let i = 0; i < 2; i++) channelOf.set(await send(s, channel), channel);
    }
    const ids = [...channelOf.keys()];

    const batches = await Promise.all([
      dispatcher.claimBatch(2),
      dispatcher.claimBatch(2),
      dispatcher.claimBatch(2),
    ]);
    const claims = batches.flat();
    expect(claims.map((c) => c.messageId).sort()).toEqual([...ids].sort());

    const outcomes = await Promise.all(claims.map((c) => dispatcher.processClaim(c)));
    expect(outcomes.map((o) => o.outcome)).toEqual(ids.map(() => 'accepted'));

    for (const id of ids) {
      expect((await messageRow(id)).status).toBe('accepted');
      const attempts = await attemptsOf(id);
      expect(attempts).toHaveLength(1);
      // The attempt used a provider of the message's own channel.
      expect(providerChannel.get(attempts[0]!.providerId)).toBe(channelOf.get(id));
      expect(await queueRow(id)).toBeUndefined();
    }

    // One simulator call per message; each carried its own channel's content.
    const seen = calls();
    expect(seen).toHaveLength(ids.length);
    for (const { context, submission } of seen) {
      const channel = providerChannel.get(context.providerId)!;
      expect(context.channel).toBe(channel);
      expectChannelSubmission(channel, submission);
    }
    const accepted = await h.admin
      .select({ messageId: schema.messageEvents.messageId })
      .from(schema.messageEvents)
      .where(
        and(
          inArray(schema.messageEvents.messageId, ids),
          eq(schema.messageEvents.eventType, 'message.accepted'),
        ),
      );
    expect(accepted.map((e) => e.messageId).sort()).toEqual([...ids].sort());
  });

  // --- 2. lease expiry, re-claim and fencing ----------------------------------

  it.each(['sms', 'rcs'] as const)(
    '%s: an expired lease is re-claimed at the next epoch; the stale worker is fenced before any provider call',
    async (channel) => {
      const s = await sender(`p43-res-fence-${channel}`);
      await assigned(s, channel, 1);
      const id = await send(s, channel);

      const [claimA] = await dispatcher.claimBatch(1);
      expect(claimA).toMatchObject({ messageId: id, dispatchEpoch: 1 });
      await expireLease(id);
      const [claimB] = await dispatcher.claimBatch(1);
      expect(claimB).toMatchObject({ messageId: id, dispatchEpoch: 2 });
      expect(claimB!.claimToken).not.toBe(claimA!.claimToken);

      expect((await dispatcher.processClaim(claimA!)).outcome).toBe('fenced');
      expect(simulated).not.toHaveBeenCalled();
      expect(await attemptsOf(id)).toHaveLength(0);
      expect(await queueRow(id)).toMatchObject({
        dispatchEpoch: 2,
        claimToken: claimB!.claimToken,
      });

      expect((await dispatcher.processClaim(claimB!)).outcome).toBe('accepted');
      const seen = calls();
      expect(seen).toHaveLength(1);
      expectChannelSubmission(channel, seen[0]!.submission);
      const attempts = await attemptsOf(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.fencingEpoch).toBe(2);
      expect((await messageRow(id)).status).toBe('accepted');
      expect(await queueRow(id)).toBeUndefined();
    },
  );

  it('sms: a stale worker is fenced during same-channel fallback, which still completes on the secondary SMS provider', async () => {
    const s = await sender('p43-res-fb-fence');
    const primary = await assigned(s, 'sms', 1, '500');
    const secondary = await assigned(s, 'sms', 2);
    const whatsapp = await assigned(s, 'whatsapp', 1);
    const id = await send(s, 'sms');

    const [claimA] = await dispatcher.claimBatch(1);
    await expireLease(id);
    const [claimB] = await dispatcher.claimBatch(1);
    expect(claimB).toMatchObject({ messageId: id, dispatchEpoch: 2 });

    expect((await dispatcher.processClaim(claimA!)).outcome).toBe('fenced');
    expect(simulated).not.toHaveBeenCalled();

    // The live worker meets the primary's failure and requeues for fallback.
    const first = await dispatcher.processClaim(claimB!);
    expect(first.outcome).toBe('failed');
    expect(first.error).toContain('PROVIDER_ERROR');
    expect((await messageRow(id)).status).toBe('queued');

    const [claimC] = await dispatcher.claimBatch(1);
    expect(claimC?.messageId).toBe(id);
    expect((await dispatcher.processClaim(claimC!)).outcome).toBe('accepted');

    const attempts = await attemptsOf(id);
    expect(attempts.map((a) => [a.providerId, a.status])).toEqual([
      [primary, 'failed'],
      [secondary, 'accepted'],
    ]);
    const seen = calls();
    expect(seen.map((c) => c.context.providerId)).toEqual([primary, secondary]);
    expect(seen.map((c) => c.context.providerId)).not.toContain(whatsapp);
    for (const { submission } of seen) expectChannelSubmission('sms', submission);
    expect((await messageRow(id)).status).toBe('accepted');
  });

  // --- 3. crash recovery --------------------------------------------------------

  it.each(['sms', 'rcs'] as const)(
    '%s: a submission interrupted mid-flight is recovered outcome_unknown and never resubmitted',
    async (channel) => {
      const s = await sender(`p43-res-crash-${channel}`);
      const providerId = await assigned(s, channel, 1);
      const id = await send(s, channel);

      const [claim] = await dispatcher.claimBatch(1);
      expect(claim?.messageId).toBe(id);
      // The worker wrote its attempt and died before the provider answered.
      const attemptId = uuidv7();
      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId: id,
        orgId: s.tenant.orgId,
        providerId,
        channelId: channelIds[channel],
        attemptNumber: 1,
        status: 'submitting',
        claimToken: claim!.claimToken,
        fencingEpoch: claim!.dispatchEpoch,
      });
      await h.admin
        .update(schema.messages)
        .set({ currentAttemptId: attemptId, status: 'submitting' })
        .where(eq(schema.messages.id, id));
      await expireLease(id);

      expect(await dispatcher.recoverExpiredLeases()).toBeGreaterThanOrEqual(1);

      const message = await messageRow(id);
      expect(message.status).toBe('outcome_unknown');
      expect(message.completedAt).not.toBeNull();
      const attempts = await attemptsOf(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe('outcome_unknown');
      const events = await h.admin
        .select({ type: schema.messageEvents.eventType })
        .from(schema.messageEvents)
        .where(eq(schema.messageEvents.messageId, id));
      expect(events.filter((e) => e.type === 'message.outcome_unknown')).toHaveLength(1);
      expect(await queueRow(id)).toBeUndefined();

      // Never resubmitted: nothing to claim, nothing reached the provider.
      expect(await dispatcher.claimBatch(1)).toEqual([]);
      expect(simulated).not.toHaveBeenCalled();
    },
  );
});
