/**
 * Phase 4.3 (Gate F.3), batch F.3-1: channels with no authorized send path fail
 * closed at dispatch.
 *
 * `email` and `voice` are catalogued channels but have no authorized send path
 * (owner decision 24-Oct-2026). The send path refuses them; this suite covers a
 * message for either that is **already queued** — stored before the send path
 * refused it, or written outside the API. Even with an active, healthy
 * simulator provider assigned on that channel, the message must settle
 * `failed` without any attempt and without reaching an adapter, with its
 * `message.failed` event written before the queue claim is released (the
 * `message_events_dispatch_insert` policy needs the live claim).
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { and, eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import { SimulatorAdapter } from '../src/provider-adapters/simulator.adapter';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  purgeProviderHealth,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

type GatedChannel = 'email' | 'voice';

describe('Phase 4.3 F.3-1: email and voice messages fail closed at dispatch', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  const channelIds: Record<string, string> = {};
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  let submitSpy: jest.SpyInstance;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['email', 'voice', 'whatsapp']));
    for (const row of rows) channelIds[row.code] = row.id;
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
    // Every simulator submission passes `submit`; counting calls proves no
    // adapter was reached, without replacing what it does.
    submitSpy = jest.spyOn(SimulatorAdapter.prototype as never, 'submit' as never);
  });

  afterEach(() => {
    submitSpy.mockRestore();
  });

  afterAll(async () => {
    try {
      if (dispatchPool) await dispatchPool.end();
      const orgIds = tenants.map((t) => t.orgId);
      if (providers.length > 0) {
        await purgeProviderHealth(
          h.admin,
          inArray(schema.providerHealth.providerId, providers),
        ).catch(() => {});
      }
      if (orgIds.length > 0) {
        await h.admin.delete(schema.messageDispatchQueue).catch(() => {});
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
          .delete(schema.contacts)
          .where(inArray(schema.contacts.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(inArray(schema.organizationProviderAssignments.orgId, orgIds))
          .catch(() => {});
      }
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
      for (const t of tenants) await destroyTenant(h.admin, t).catch(() => {});
    } finally {
      await h.close();
    }
  });

  async function tenant(label: string): Promise<TenantFixture> {
    const t = await createTenant(h.admin, label, credentials);
    tenants.push(t);
    return t;
  }

  /** An active, healthy simulator provider that would accept anything submitted to it. */
  async function assignedProvider(t: TenantFixture, channel: string): Promise<string> {
    const slug = `gate-${channel}-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelIds[channel]!,
        name: `Channel gating ${slug}`,
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
      orgId: t.orgId,
      channelId: channelIds[channel]!,
      providerId: p!.id,
      priority: 1,
      status: 'active',
    });
    return p!.id;
  }

  /** A message planted as queued, as a row stored before the send path refused its channel would be. */
  async function queued(
    t: TenantFixture,
    channel: string,
    recipientAddress: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      displayName: 'Channel gating recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      contactId,
      channelId: channelIds[channel]!,
      recipientAddress,
      status: 'queued',
      payload,
      correlationId: uuidv7(),
    });
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: t.orgId,
      priority: 1,
      dispatchEpoch: 0,
      claimedUntil: null,
      claimToken: null,
    });
    return messageId;
  }

  async function dispatchOnce(messageId: string) {
    const [claim] = await dispatcher.claimBatch(1);
    expect(claim?.messageId).toBe(messageId);
    return dispatcher.processClaim(claim!);
  }

  const RECIPIENTS: Record<GatedChannel, string> = {
    email: 'gated.recipient@example.test',
    voice: '+12025550181',
  };

  it('runs under the dispatch principal, not an administrator', async () => {
    const { rows } = await dispatchPool.query<{ current_user: string; bypass: boolean }>(
      `SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
    );
    expect(rows[0]).toEqual({ current_user: 'acc_dispatch', bypass: false });
  });

  it.each(['email', 'voice'] as const)(
    'an already-queued %s message: failed CHANNEL_UNSUPPORTED, one event, queue cleared, no attempt, no adapter call',
    async (channel) => {
      const t = await tenant(`gate-${channel}`);
      const providerId = await assignedProvider(t, channel);
      const messageId = await queued(t, channel, RECIPIENTS[channel], { text: 'Must not be sent' });
      const reason = `CHANNEL_UNSUPPORTED: ${channel}`;

      const outcome = await dispatchOnce(messageId);
      expect(outcome).toEqual({ messageId, outcome: 'failed', error: reason });

      const [m] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(m!.status).toBe('failed');
      expect(m!.failureReason).toBe(reason);
      expect(m!.completedAt).not.toBeNull();
      expect(m!.currentAttemptId).toBeNull();

      const failedEvents = await h.admin
        .select({ orgId: schema.messageEvents.orgId, payload: schema.messageEvents.payload })
        .from(schema.messageEvents)
        .where(
          and(
            eq(schema.messageEvents.messageId, messageId),
            eq(schema.messageEvents.eventType, 'message.failed'),
          ),
        );
      expect(failedEvents).toEqual([{ orgId: t.orgId, payload: { reason, attempts: 0 } }]);

      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeUndefined();

      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId));
      expect(attempts).toHaveLength(0);

      // Neither the adapter nor the provider's health saw the message.
      expect(submitSpy).not.toHaveBeenCalled();
      const samples = await h.admin
        .select()
        .from(schema.providerHealth)
        .where(eq(schema.providerHealth.providerId, providerId));
      expect(samples).toHaveLength(0);

      // Nothing left to claim or to recover into outcome_unknown.
      expect(await dispatcher.claimBatch(1)).toEqual([]);
      expect(await dispatcher.recoverExpiredLeases()).toBe(0);
    },
  );

  it('a gated message does not disturb a WhatsApp message queued beside it', async () => {
    const t = await tenant('gate-mixed');
    await assignedProvider(t, 'email');
    await assignedProvider(t, 'whatsapp');
    const gated = await queued(t, 'email', RECIPIENTS.email, { text: 'Must not be sent' });
    const allowed = await queued(t, 'whatsapp', '+12025550182', { text: 'Hello' });

    const claims = await dispatcher.claimBatch(2);
    expect(claims.map((c) => c.messageId).sort()).toEqual([gated, allowed].sort());
    const outcomes = await Promise.all(claims.map((c) => dispatcher.processClaim(c)));
    const byId = new Map(outcomes.map((o) => [o.messageId, o]));

    expect(byId.get(gated)).toEqual({
      messageId: gated,
      outcome: 'failed',
      error: 'CHANNEL_UNSUPPORTED: email',
    });
    expect(byId.get(allowed)?.outcome).toBe('accepted');
    // Exactly one submission reached the simulator: the WhatsApp one.
    expect(submitSpy).toHaveBeenCalledTimes(1);

    const rows = await h.admin
      .select({ id: schema.messages.id, status: schema.messages.status })
      .from(schema.messages)
      .where(inArray(schema.messages.id, [gated, allowed]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [gated]: 'failed',
      [allowed]: 'accepted',
    });
  });
});
