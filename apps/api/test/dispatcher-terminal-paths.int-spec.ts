/**
 * Dispatcher claim-time terminal failures under the real dispatch principal.
 *
 * The intent transaction can end a claimed message without any provider call:
 * its organization was closed after it was queued, or it has no active
 * provider assignment for its channel any more (none at all, or none left
 * after earlier attempts). Each must settle `failed` with its `message.failed`
 * event and leave the queue — never roll back into a stuck claim that lease
 * recovery later turns into `outcome_unknown`.
 *
 * `message_events_dispatch_insert` lets `acc_dispatch` write an event only while
 * the message's claim row exists, so the event has to precede the queue delete.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  purgeProviderHealth,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('Dispatcher claim-time terminal failures (organization closed, no active assignment)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  let channelId: string;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = c!.id;
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
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

  async function provider(label: string, simulatorBehavior?: string): Promise<string> {
    const slug = `${label}-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `Terminal paths ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    if (simulatorBehavior) {
      await h.admin.insert(schema.providerCapabilities).values({
        providerId: p!.id,
        capabilityKey: 'simulator_behavior',
        value: simulatorBehavior,
      });
    }
    return p!.id;
  }

  async function assign(t: TenantFixture, providerId: string, priority: number): Promise<string> {
    const [a] = await h.admin
      .insert(schema.organizationProviderAssignments)
      .values({ orgId: t.orgId, channelId, providerId, priority, status: 'active' })
      .returning({ id: schema.organizationProviderAssignments.id });
    return a!.id;
  }

  async function disable(assignmentId: string): Promise<void> {
    await h.admin
      .update(schema.organizationProviderAssignments)
      .set({ status: 'disabled' })
      .where(eq(schema.organizationProviderAssignments.id, assignmentId));
  }

  async function queued(t: TenantFixture): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      displayName: 'Terminal path recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      contactId,
      channelId,
      recipientAddress: '+12025550180',
      status: 'queued',
      payload: { text: 'Terminal path message' },
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

  /** The terminal state every claim-time failure must leave behind. */
  async function expectSettledFailed(
    messageId: string,
    failureReason: string,
    eventReason: string,
    attempts: number,
  ) {
    const [m] = await h.admin
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    expect(m!.status).toBe('failed');
    expect(m!.failureReason).toBe(failureReason);
    expect(m!.completedAt).not.toBeNull();

    const failedEvents = await h.admin
      .select({ payload: schema.messageEvents.payload })
      .from(schema.messageEvents)
      .where(
        and(
          eq(schema.messageEvents.messageId, messageId),
          eq(schema.messageEvents.eventType, 'message.failed'),
        ),
      );
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0]!.payload as { reason?: string }).reason).toBe(eventReason);

    const [queueRow] = await h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, messageId));
    expect(queueRow).toBeUndefined();

    const rows = await h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, messageId));
    expect(rows).toHaveLength(attempts);

    // Nothing left to claim or to recover into outcome_unknown.
    expect(await dispatcher.claimBatch(1)).toEqual([]);
    expect(await dispatcher.recoverExpiredLeases()).toBe(0);
  }

  it('runs under the dispatch principal, not an administrator', async () => {
    const { rows } = await dispatchPool.query<{ current_user: string; bypass: boolean }>(
      `SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
    );
    expect(rows[0]).toEqual({ current_user: 'acc_dispatch', bypass: false });
  });

  it('organization closed after queuing: failed, one message.failed event, queue cleared, no attempt', async () => {
    const t = await tenant('term-closed');
    await assign(t, await provider('closed-ok'), 1);
    const messageId = await queued(t);
    await h.admin.execute(
      sql`UPDATE organizations SET status = 'closed', status_changed_at = now() WHERE id = ${t.orgId}`,
    );

    const outcome = await dispatchOnce(messageId);
    expect(outcome).toEqual({ messageId, outcome: 'failed', error: 'Organization closed' });
    await expectSettledFailed(messageId, 'Organization is closed', 'Organization is closed', 0);
  });

  it('no active assignment and no earlier attempt: failed with the no-assignment reason', async () => {
    const t = await tenant('term-none');
    const assignmentId = await assign(t, await provider('none-ok'), 1);
    const messageId = await queued(t);
    await disable(assignmentId);

    const outcome = await dispatchOnce(messageId);
    expect(outcome).toEqual({
      messageId,
      outcome: 'failed',
      error: 'No active provider assignment for channel',
    });
    await expectSettledFailed(
      messageId,
      'No active provider assignment for channel',
      'No active provider assignment for channel',
      0,
    );
  });

  it('no active assignment left after an earlier attempt: failed NO_ELIGIBLE_PROVIDER, the attempt kept', async () => {
    const t = await tenant('term-left');
    await assign(t, await provider('left-500', '500'), 1);
    const secondary = await assign(t, await provider('left-ok'), 2);
    const messageId = await queued(t);

    // First attempt fails over to the secondary and requeues the message.
    const first = await dispatchOnce(messageId);
    expect(first.outcome).toBe('failed');
    expect(first.error).toContain('PROVIDER_ERROR');
    const [requeued] = await h.admin
      .select({ status: schema.messages.status })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    expect(requeued!.status).toBe('queued');

    // The secondary is withdrawn before the retry is claimed.
    await disable(secondary);
    const second = await dispatchOnce(messageId);
    expect(second).toEqual({ messageId, outcome: 'failed', error: 'NO_ELIGIBLE_PROVIDER' });
    await expectSettledFailed(messageId, 'NO_ELIGIBLE_PROVIDER', 'NO_ELIGIBLE_PROVIDER', 1);
  });
});
