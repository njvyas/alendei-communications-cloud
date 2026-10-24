// Must stay the first import: it switches the dispatch loop on before the
// application module (and its configuration) is loaded.
import { POLL_INTERVAL_MS, PREVIOUS } from './dispatch-worker.env';

/**
 * Phase 4.3 (Gate F.3), batch F.3-2: SMS and RCS through the dispatch loop of
 * the booted application (ADR-014 D18), with nothing in the suite calling the
 * dispatcher.
 *
 * 1. SMS and RCS messages sent over HTTP reach `accepted`, and the simulator
 *    receives the SMS DLT metadata and the RCS payload intact.
 * 2. An RCS claim abandoned before submission is recovered when its lease
 *    expires and is then dispatched with its payload intact.
 * 3. An SMS submission interrupted mid-flight is recovered `outcome_unknown`
 *    and never resubmitted.
 *
 * Each case uses its own tenant and provider, so the loop — which serves the
 * whole queue — cannot blur one case with another. The HTTP server listens
 * once for the suite, so concurrent requests never race supertest's
 * per-request listen and close.
 *
 * Simulator providers only; no network. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  PERMISSIONS,
  type ProviderAdapterContext,
  type ProviderSubmission,
  type RcsBasicPayload,
  type SmsDltMetadata,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { DispatchWorker } from '../src/messages/dispatch/dispatch.worker';
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

const url = (p: string) => `/${PREFIX}${p}`;

// Sign-ins (Argon2) and real poll cycles; the default 5 s is too tight.
jest.setTimeout(30_000);
const TERMINAL = new Set(['accepted', 'failed', 'outcome_unknown']);

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
  },
};

interface Sender {
  readonly tenant: TenantFixture;
  readonly token: string;
  readonly smsTemplateId: string;
}

describe('Phase 4.3 F.3-2: SMS and RCS through the dispatch loop (ADR-014 D18)', () => {
  let h: Harness;
  let credentials: CredentialService;
  const channelIds: Record<string, string> = {};
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const customRoles: string[] = [];

  let simulated: jest.SpyInstance;
  /** The simulator calls made for one provider. */
  const callsFor = (providerId: string) =>
    simulated.mock.calls
      .map((args: unknown[]) => ({
        context: args[1] as ProviderAdapterContext,
        submission: args[2] as ProviderSubmission,
      }))
      .filter((c) => c.context.providerId === providerId);

  beforeAll(async () => {
    h = await startHarness();
    // One listening server for the suite (see the header).
    await new Promise<void>((resolve) => h.app.getHttpServer().listen(0, resolve));
    credentials = h.app.get(CredentialService);
    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['sms', 'rcs']));
    for (const row of rows) channelIds[row.code] = row.id;
  }, 60_000);

  beforeEach(() => {
    simulated = jest.spyOn(
      SimulatorAdapter.prototype as unknown as { simulate: () => unknown },
      'simulate',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      const orgIds = tenants.map((t) => t.orgId);
      if (providers.length > 0) {
        await purgeProviderHealth(
          h.admin,
          inArray(schema.providerHealth.providerId, providers),
        ).catch(() => {});
      }
      if (orgIds.length > 0) {
        await h.admin
          .delete(schema.messageDispatchQueue)
          .where(inArray(schema.messageDispatchQueue.orgId, orgIds))
          .catch(() => {});
        await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, orgIds)).catch(
          () => {},
        );
        await h.admin
          .delete(schema.messageAttempts)
          .where(inArray(schema.messageAttempts.orgId, orgIds))
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
      for (const [key, value] of Object.entries(PREVIOUS)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  // --- fixtures ---------------------------------------------------------------

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
      key: `p43_dw_${randomBytes(4).toString('hex')}`,
      name: 'Phase 4.3 worker sender',
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
        channelId: channelIds.sms!,
        name: `p43_dw_otp_${randomBytes(3).toString('hex')}`,
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

  async function assigned(s: Sender, channel: 'sms' | 'rcs'): Promise<string> {
    const slug = `p43-dw-${channel}-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelIds[channel]!,
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
      value: 'SUCCESS',
    });
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: s.tenant.orgId,
      channelId: channelIds[channel]!,
      providerId: p!.id,
      priority: 1,
      status: 'active',
    });
    return p!.id;
  }

  async function submit(s: Sender, body: Record<string, unknown>): Promise<string> {
    const res = await request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Acc-Organization', s.tenant.orgId)
      .set('Idempotency-Key', randomUUID())
      .send(body);
    expect(res.status).toBe(202);
    return res.body.data.id as string;
  }

  /** Reads the message over the API until it is terminal. */
  async function settled(s: Sender, messageId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await request(h.app.getHttpServer())
        .get(url(`/messages/${messageId}`))
        .set('Authorization', `Bearer ${s.token}`)
        .set('X-Acc-Organization', s.tenant.orgId)
        .expect(200);
      if (TERMINAL.has(res.body.data.status)) return res.body.data;
      if (Date.now() > deadline) {
        throw new Error(`message ${messageId} still ${res.body.data.status} after ${timeoutMs} ms`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /** A message written directly as the send path would have stored it, for states the API cannot produce. */
  async function seedMessage(
    s: Sender,
    channel: 'sms' | 'rcs',
    payload: Record<string, unknown>,
  ): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: s.tenant.orgId,
      workspaceId: s.tenant.workspaceId,
      displayName: 'Phase 4.3 worker recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: s.tenant.orgId,
      workspaceId: s.tenant.workspaceId,
      contactId,
      channelId: channelIds[channel]!,
      recipientAddress: '+12025554001',
      status: 'queued',
      payload,
      correlationId: uuidv7(),
    });
    return messageId;
  }

  const attemptsOf = (messageId: string) =>
    h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, messageId));

  // --- cases --------------------------------------------------------------------

  it('the loop runs in the booted application', () => {
    expect(h.app.get(DispatchWorker).isRunning()).toBe(true);
  });

  it('SMS and RCS sent over HTTP reach accepted with no manual dispatch, their content intact', async () => {
    const s = await sender('p43-dw-http');
    const smsProvider = await assigned(s, 'sms');
    const rcsProvider = await assigned(s, 'rcs');

    const smsId = await submit(s, {
      channelCode: 'sms',
      recipient: '+12025554002',
      templateId: s.smsTemplateId,
      payload: { variables: { '1': '515151' } },
    });
    const rcsId = await submit(s, { channelCode: 'rcs', recipient: '+12025554003', payload: CARD });

    expect((await settled(s, smsId)).status).toBe('accepted');
    expect((await settled(s, rcsId)).status).toBe('accepted');
    expect(await attemptsOf(smsId)).toHaveLength(1);
    expect(await attemptsOf(rcsId)).toHaveLength(1);

    const [smsCall] = callsFor(smsProvider);
    expect(callsFor(smsProvider)).toHaveLength(1);
    expect(smsCall!.submission).toMatchObject({
      channel: 'sms',
      content: { text: 'Your verification code is 515151.' },
      sms: { dlt: TEMPLATE_DLT },
    });
    const [rcsCall] = callsFor(rcsProvider);
    expect(callsFor(rcsProvider)).toHaveLength(1);
    expect(rcsCall!.submission.channel).toBe('rcs');
    expect(rcsCall!.submission.rcs).toEqual(CARD);
  });

  it('an RCS claim abandoned before submission is recovered when its lease expires, then dispatched intact', async () => {
    const s = await sender('p43-dw-stale');
    const providerId = await assigned(s, 'rcs');
    const messageId = await seedMessage(s, 'rcs', { ...CARD });
    // A worker claimed it and vanished: the lease has run out.
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: s.tenant.orgId,
      priority: 1,
      dispatchEpoch: 1,
      claimToken: randomUUID(),
      claimedUntil: new Date(Date.now() - 5_000),
    });

    expect((await settled(s, messageId)).status).toBe('accepted');
    const attempts = await attemptsOf(messageId);
    expect(attempts).toHaveLength(1);
    // Above the abandoned claim's epoch 1: 2 when the loop re-claims it directly,
    // 3 when lease recovery fenced and released it first. Either way the
    // vanished worker's epoch can no longer settle anything.
    expect(attempts[0]!.fencingEpoch).toBeGreaterThan(1);
    const calls = callsFor(providerId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.submission.rcs).toEqual(CARD);
  });

  it('an SMS submission interrupted mid-flight is recovered outcome_unknown, never resubmitted', async () => {
    const s = await sender('p43-dw-crash');
    const providerId = await assigned(s, 'sms');
    const messageId = await seedMessage(s, 'sms', {
      text: 'Your verification code is 616161.',
      dlt: { ...TEMPLATE_DLT },
    });
    const claimToken = randomUUID();
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: s.tenant.orgId,
      priority: 1,
      dispatchEpoch: 1,
      claimToken,
      // Held while the attempt is written, so the loop cannot claim it first.
      claimedUntil: new Date(Date.now() + 60_000),
    });
    const attemptId = uuidv7();
    await h.admin.insert(schema.messageAttempts).values({
      id: attemptId,
      messageId,
      orgId: s.tenant.orgId,
      providerId,
      channelId: channelIds.sms!,
      attemptNumber: 1,
      status: 'submitting',
      claimToken,
      fencingEpoch: 1,
    });
    await h.admin
      .update(schema.messages)
      .set({ currentAttemptId: attemptId, status: 'submitting' })
      .where(eq(schema.messages.id, messageId));
    // The worker that wrote the attempt died: its lease runs out.
    await h.admin
      .update(schema.messageDispatchQueue)
      .set({ claimedUntil: new Date(Date.now() - 5_000) })
      .where(eq(schema.messageDispatchQueue.messageId, messageId));

    expect((await settled(s, messageId)).status).toBe('outcome_unknown');
    const attempts = await attemptsOf(messageId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('outcome_unknown');
    const [queueRow] = await h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, messageId));
    expect(queueRow).toBeUndefined();
    // Give the loop further cycles: nothing may reach the provider.
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 5));
    expect(callsFor(providerId)).toHaveLength(0);
  });
});
