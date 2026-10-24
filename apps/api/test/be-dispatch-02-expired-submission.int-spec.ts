/**
 * BE-DISPATCH-02: a message whose worker vanished mid-submission is never
 * submitted again.
 *
 * `claimBatch` takes rows whose lease has expired, as well as unclaimed ones,
 * so a claim can land on a message still `submitting` before lease recovery
 * reaches it — in one worker between its recovery and claim steps, or on
 * another instance at any time. Before the fix, `processClaim` then excluded
 * the attempted provider and submitted to the next one (a possible duplicate
 * send), or, with no other provider, failed the message NO_ELIGIBLE_PROVIDER
 * and left its attempt `submitting` forever.
 *
 * Deterministic: the worker loop is off for this suite (`setup-env.ts`); each
 * case plants the abandoned state and calls `claimBatch` + `processClaim`
 * directly, with no recovery run first. Simulator providers only; no network.
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { schema } from '@acc/db';
import { eq, inArray } from 'drizzle-orm';
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

const ABANDONED_REASON = 'Dispatch lease expired during external submission (outcome_unknown)';

interface Abandoned {
  readonly messageId: string;
  readonly attemptId: string;
}

describe('BE-DISPATCH-02: an expired lease on a submitting message is settled, never resubmitted', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  let channelId: string;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  let simulated: jest.SpyInstance;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    const [channel] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = channel!.id;
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

  // --- fixtures ---------------------------------------------------------------

  async function tenant(label: string): Promise<TenantFixture> {
    const t = await createTenant(h.admin, label, credentials);
    tenants.push(t);
    return t;
  }

  /** An active, healthy simulator provider assigned to `t` that would accept anything. */
  async function assignedProvider(t: TenantFixture, priority: number): Promise<string> {
    const slug = `bd02-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `BE-DISPATCH-02 ${slug}`,
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
      channelId,
      providerId: p!.id,
      priority,
      status: 'active',
    });
    return p!.id;
  }

  async function queuedMessage(t: TenantFixture): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      displayName: 'BE-DISPATCH-02 recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      contactId,
      channelId,
      recipientAddress: `+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      status: 'queued',
      payload: { text: 'BE-DISPATCH-02' },
      correlationId: uuidv7(),
    });
    return messageId;
  }

  /**
   * The state a worker leaves when it dies mid-submission: the message
   * `submitting` with its attempt on `providerId`, and the lease run out. No
   * lease recovery has run.
   */
  async function abandonedMidSubmission(t: TenantFixture, providerId: string): Promise<Abandoned> {
    const messageId = await queuedMessage(t);
    const claimToken = randomUUID();
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: t.orgId,
      priority: 1,
      dispatchEpoch: 1,
      claimToken,
      claimedBy: 'vanished-worker',
      // Live while the attempt is written, as the vanished worker held it.
      claimedUntil: new Date(Date.now() + 60_000),
    });
    const attemptId = uuidv7();
    await h.admin.insert(schema.messageAttempts).values({
      id: attemptId,
      messageId,
      orgId: t.orgId,
      providerId,
      channelId,
      attemptNumber: 1,
      status: 'submitting',
      claimToken,
      fencingEpoch: 1,
    });
    await h.admin
      .update(schema.messages)
      .set({ currentAttemptId: attemptId, status: 'submitting' })
      .where(eq(schema.messages.id, messageId));
    await h.admin
      .update(schema.messageDispatchQueue)
      .set({ claimedUntil: new Date(Date.now() - 5_000) })
      .where(eq(schema.messageDispatchQueue.messageId, messageId));
    return { messageId, attemptId };
  }

  /** The claim path, with no recovery first: exactly one claim, on `messageId`. */
  async function claimAndProcess(messageId: string) {
    const claims = await dispatcher.claimBatch(10);
    expect(claims.map((c) => c.messageId)).toEqual([messageId]);
    return dispatcher.processClaim(claims[0]!);
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
    return h.admin
      .select({
        type: schema.messageEvents.eventType,
        attemptId: schema.messageEvents.attemptId,
        payload: schema.messageEvents.payload,
      })
      .from(schema.messageEvents)
      .where(eq(schema.messageEvents.messageId, id))
      .orderBy(schema.messageEvents.createdAt, schema.messageEvents.id);
  }

  async function queueRows(id: string) {
    return h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, id));
  }

  /** Settled OUTCOME_UNKNOWN on its one original attempt, off the queue, with its event. */
  async function expectSettledOutcomeUnknown(a: Abandoned, providerId: string) {
    const m = await messageRow(a.messageId);
    expect([m.status, m.failureReason, m.currentAttemptId]).toEqual([
      'outcome_unknown',
      ABANDONED_REASON,
      a.attemptId,
    ]);
    expect(m.completedAt).not.toBeNull();
    const attempts = await attemptsOf(a.messageId);
    expect(
      attempts.map((x) => [x.id, x.attemptNumber, x.providerId, x.status, x.failureReason]),
    ).toEqual([[a.attemptId, 1, providerId, 'outcome_unknown', ABANDONED_REASON]]);
    expect(attempts[0]!.completedAt).not.toBeNull();
    expect(await eventsOf(a.messageId)).toEqual([
      {
        type: 'message.outcome_unknown',
        attemptId: a.attemptId,
        payload: { outcome: 'outcome_unknown', reason: ABANDONED_REASON },
      },
    ]);
    expect(await queueRows(a.messageId)).toEqual([]);
  }

  // --- cases --------------------------------------------------------------------

  it('duplicate submission: with a second provider assigned, the claim settles OUTCOME_UNKNOWN and submits to neither', async () => {
    const t = await tenant('bd02-dup');
    const primary = await assignedProvider(t, 1);
    await assignedProvider(t, 2);
    const a = await abandonedMidSubmission(t, primary);

    const result = await claimAndProcess(a.messageId);

    expect(result).toEqual({
      messageId: a.messageId,
      attemptId: a.attemptId,
      outcome: 'unknown',
      error: ABANDONED_REASON,
    });
    expect(simulated).not.toHaveBeenCalled();
    await expectSettledOutcomeUnknown(a, primary);

    // Terminal: nothing left to claim, recover or submit later.
    expect(await dispatcher.claimBatch(10)).toEqual([]);
    expect(await dispatcher.recoverExpiredLeases()).toBe(0);
    expect(simulated).not.toHaveBeenCalled();
  });

  it('single provider: the claim settles OUTCOME_UNKNOWN, not failed NO_ELIGIBLE_PROVIDER with the attempt left submitting', async () => {
    const t = await tenant('bd02-single');
    const only = await assignedProvider(t, 1);
    const a = await abandonedMidSubmission(t, only);

    const result = await claimAndProcess(a.messageId);

    expect(result.outcome).toBe('unknown');
    expect(simulated).not.toHaveBeenCalled();
    await expectSettledOutcomeUnknown(a, only);
    expect((await messageRow(a.messageId)).failureReason).not.toBe('NO_ELIGIBLE_PROVIDER');
  });

  it('outcome_unknown settlement: the claim path settles exactly as lease recovery does', async () => {
    const t = await tenant('bd02-parity');
    const providerId = await assignedProvider(t, 1);

    const viaRecovery = await abandonedMidSubmission(t, providerId);
    expect(await dispatcher.recoverExpiredLeases()).toBe(1);
    await expectSettledOutcomeUnknown(viaRecovery, providerId);

    const viaClaim = await abandonedMidSubmission(t, providerId);
    await claimAndProcess(viaClaim.messageId);
    await expectSettledOutcomeUnknown(viaClaim, providerId);

    expect(simulated).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'closed'] as const)(
    'an organization %s while the submission was in flight: settled OUTCOME_UNKNOWN, not held or failed',
    async (orgStatus) => {
      const t = await tenant(`bd02-${orgStatus}`);
      const providerId = await assignedProvider(t, 1);
      const a = await abandonedMidSubmission(t, providerId);
      await h.admin
        .update(schema.organizations)
        .set({ status: orgStatus })
        .where(eq(schema.organizations.id, t.orgId));

      const result = await claimAndProcess(a.messageId);

      expect(result.outcome).toBe('unknown');
      expect(simulated).not.toHaveBeenCalled();
      await expectSettledOutcomeUnknown(a, providerId);
    },
  );

  it('control: an expired lease on a message that never started submitting is still dispatched once', async () => {
    const t = await tenant('bd02-control');
    const providerId = await assignedProvider(t, 1);
    const messageId = await queuedMessage(t);
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: t.orgId,
      priority: 1,
      dispatchEpoch: 1,
      claimToken: randomUUID(),
      claimedBy: 'vanished-worker',
      claimedUntil: new Date(Date.now() - 5_000),
    });

    const result = await claimAndProcess(messageId);

    expect(result.outcome).toBe('accepted');
    expect(simulated).toHaveBeenCalledTimes(1);
    const attempts = await attemptsOf(messageId);
    expect(attempts.map((x) => [x.providerId, x.status])).toEqual([[providerId, 'accepted']]);
    expect((await messageRow(messageId)).status).toBe('accepted');
  });
});
