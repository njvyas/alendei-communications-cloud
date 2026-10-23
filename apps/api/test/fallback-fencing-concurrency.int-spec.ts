import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { and, eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import { DISPATCH_POOL } from '../src/database/database.tokens';
import { SimulatorAdapter } from '../src/provider-adapters/simulator.adapter';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('Phase 3.4 Fallback, Resilience & Fencing Concurrency Integration Suite', () => {
  let h: Harness;
  let credentials: CredentialService;
  let channelId: string;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  const createdProviders: string[] = [];
  const createdTenants: TenantFixture[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);

    // Channel: ensure whatsapp channel exists
    const [c] = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'))
      .limit(1);

    if (c) {
      channelId = c.id;
    } else {
      const [inserted] = await h.admin
        .insert(schema.channels)
        .values({
          code: 'whatsapp',
          displayName: 'WhatsApp',
          status: 'active',
        })
        .returning();
      channelId = inserted!.id;
    }
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
  });

  afterAll(async () => {
    try {
      if (dispatchPool) await dispatchPool.end();
      if (h?.admin) {
        await h.admin.delete(schema.messageDispatchQueue).catch(() => {});
        await purgeMessageEvents(h.admin).catch(() => {});
        await h.admin.delete(schema.messageAttempts).catch(() => {});
        await h.admin.delete(schema.messages).catch(() => {});
        await h.admin.delete(schema.contacts).catch(() => {});
        await h.admin.delete(schema.organizationProviderAssignments).catch(() => {});
        if (createdProviders.length > 0) {
          await h.admin
            .delete(schema.providerCapabilities)
            .where(inArray(schema.providerCapabilities.providerId, createdProviders))
            .catch(() => {});
          await h.admin
            .delete(schema.providers)
            .where(inArray(schema.providers.id, createdProviders))
            .catch(() => {});
        }
        for (const t of createdTenants) {
          await destroyTenant(h.admin, t).catch(() => {});
        }
      }
    } catch {
      // Best-effort cleanup
    } finally {
      await h.close();
    }
  });

  async function createTestTenant(label = 'fb-tenant'): Promise<TenantFixture> {
    const t = await createTenant(h.admin, label, credentials);
    createdTenants.push(t);
    return t;
  }

  async function createProvider(
    prefix: string,
    circuitState: 'closed' | 'open' = 'closed',
    simulatorBehavior?: string,
  ): Promise<string> {
    const slug = `${prefix}-${randomBytes(4).toString('hex')}`;
    const [prov] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `WhatsApp Simulator ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState,
        circuitGeneration: circuitState === 'open' ? 1 : 0,
        circuitChangedAt: circuitState === 'open' ? new Date() : null,
      })
      .returning();
    const pid = prov!.id;
    createdProviders.push(pid);

    if (simulatorBehavior) {
      await h.admin.insert(schema.providerCapabilities).values({
        providerId: pid,
        capabilityKey: 'simulator_behavior',
        value: simulatorBehavior,
      });
    }

    return pid;
  }

  async function assignProvider(
    tenant: TenantFixture,
    providerId: string,
    priority = 1,
  ): Promise<void> {
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: tenant.orgId,
      channelId,
      providerId,
      priority,
      status: 'active',
    });
  }

  async function seedMessage(tenant: TenantFixture): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      displayName: 'Test Recipient',
    });

    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      contactId,
      channelId,
      recipientAddress: '+12025550199',
      status: 'queued',
      payload: { text: 'Fallback resilience message' },
      correlationId: uuidv7(),
    });

    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: tenant.orgId,
      priority: 1,
      dispatchEpoch: 0,
      claimedUntil: null,
      claimToken: null,
    });

    return messageId;
  }

  describe('1. PROVIDER_ERROR Fallback & Retry Progression (P3-D13, P3-D14)', () => {
    it('falls back on PROVIDER_ERROR (500) to secondary provider and accepts', async () => {
      const tenant = await createTestTenant('fb-p500');
      const p1 = await createProvider('p-err-1', 'closed', '500');
      const p2 = await createProvider('p-err-2', 'closed'); // succeeds
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      // First pass: Worker claims batch at epoch 1
      const [claim1] = await dispatcher.claimBatch(1);
      expect(claim1).toBeDefined();
      expect(claim1!.messageId).toBe(messageId);
      expect(claim1!.dispatchEpoch).toBe(1);

      // Process attempt 1 with provider 1 -> fails with PROVIDER_ERROR -> fallback requeued
      const result1 = await dispatcher.processClaim(claim1!);
      expect(result1.outcome).toBe('failed');
      expect(result1.error).toContain('PROVIDER_ERROR');

      // Verify intermediate database state:
      // Message is back in queued status with current_attempt_id = null
      const [msgMid] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msgMid!.status).toBe('queued');
      expect(msgMid!.currentAttemptId).toBeNull();

      // Attempt 1 is recorded as failed
      const attemptsMid = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId))
        .orderBy(schema.messageAttempts.attemptNumber);
      expect(attemptsMid.length).toBe(1);
      expect(attemptsMid[0]!.providerId).toBe(p1);
      expect(attemptsMid[0]!.status).toBe('failed');
      expect(attemptsMid[0]!.failureReason).toContain('PROVIDER_ERROR');

      // Second pass: Worker claims batch at epoch 2
      const [claim2] = await dispatcher.claimBatch(1);
      expect(claim2).toBeDefined();
      expect(claim2!.messageId).toBe(messageId);
      expect(claim2!.dispatchEpoch).toBe(2);

      // Process attempt 2 with provider 2 -> succeeds -> accepted
      const result2 = await dispatcher.processClaim(claim2!);
      expect(result2.outcome).toBe('accepted');

      // Verify final database state
      const [msgFinal] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msgFinal!.status).toBe('accepted');
      expect(msgFinal!.completedAt).not.toBeNull();

      // Two attempts total: p1 failed, p2 accepted
      const attemptsFinal = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId))
        .orderBy(schema.messageAttempts.attemptNumber);
      expect(attemptsFinal.length).toBe(2);
      expect(attemptsFinal[0]!.providerId).toBe(p1);
      expect(attemptsFinal[0]!.status).toBe('failed');
      expect(attemptsFinal[1]!.providerId).toBe(p2);
      expect(attemptsFinal[1]!.status).toBe('accepted');

      // Queue row is deleted upon terminal acceptance
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeUndefined();

      // Events: message.queued (initial), message.queued (requeued), message.accepted
      const events = await h.admin
        .select()
        .from(schema.messageEvents)
        .where(eq(schema.messageEvents.messageId, messageId));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain('message.queued');
      expect(eventTypes).toContain('message.accepted');
    });
  });

  describe('2. RATE_LIMITED Fallback & Retry Progression (P3-D13)', () => {
    it('falls back on RATE_LIMITED (429) to secondary provider and accepts', async () => {
      const tenant = await createTestTenant('fb-p429');
      const p1 = await createProvider('p-rl-1', 'closed', '429');
      const p2 = await createProvider('p-rl-2', 'closed'); // succeeds
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      const [claim1] = await dispatcher.claimBatch(1);
      const res1 = await dispatcher.processClaim(claim1!);
      expect(res1.outcome).toBe('failed');
      expect(res1.error).toContain('RATE_LIMITED');

      const [claim2] = await dispatcher.claimBatch(1);
      const res2 = await dispatcher.processClaim(claim2!);
      expect(res2.outcome).toBe('accepted');

      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('accepted');

      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId))
        .orderBy(schema.messageAttempts.attemptNumber);
      expect(attempts.length).toBe(2);
      expect(attempts[0]!.providerId).toBe(p1);
      expect(attempts[0]!.status).toBe('failed');
      expect(attempts[0]!.failureReason).toContain('RATE_LIMITED');
      expect(attempts[1]!.providerId).toBe(p2);
      expect(attempts[1]!.status).toBe('accepted');
    });
  });

  describe('3. In-Memory Circuit Refusal Skipping (P3-D13, P3-D14)', () => {
    it('skips open circuit provider in-memory without inserting attempt row and dispatches to secondary', async () => {
      const tenant = await createTestTenant('fb-skip');
      const pOpen = await createProvider('p-open', 'open');
      const pHealthy = await createProvider('p-healthy', 'closed');
      await assignProvider(tenant, pOpen, 1);
      await assignProvider(tenant, pHealthy, 2);

      const messageId = await seedMessage(tenant);

      const [claim] = await dispatcher.claimBatch(1);
      expect(claim).toBeDefined();

      const result = await dispatcher.processClaim(claim!);
      expect(result.outcome).toBe('accepted');

      // Verify that NO attempt row was created for pOpen
      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId));
      expect(attempts.length).toBe(1);
      expect(attempts[0]!.providerId).toBe(pHealthy);
      expect(attempts[0]!.status).toBe('accepted');

      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('accepted');
    });
  });

  describe('4. Complete Circuit Refusal Exhaustion (P3-D14)', () => {
    it('fails fast with NO_ELIGIBLE_PROVIDER and 0 attempts when all candidate circuits are open', async () => {
      const tenant = await createTestTenant('fb-allopen');
      const pOpen1 = await createProvider('p-allopen-1', 'open');
      const pOpen2 = await createProvider('p-allopen-2', 'open');
      await assignProvider(tenant, pOpen1, 1);
      await assignProvider(tenant, pOpen2, 2);

      const messageId = await seedMessage(tenant);

      const [claim] = await dispatcher.claimBatch(1);
      const result = await dispatcher.processClaim(claim!);
      expect(result.outcome).toBe('circuit_refused');
      expect(result.error).toBe('NO_ELIGIBLE_PROVIDER');

      // Exactly 0 attempts created
      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId));
      expect(attempts.length).toBe(0);

      // Message terminalized with NO_ELIGIBLE_PROVIDER
      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('failed');
      expect(msg!.failureReason).toBe('NO_ELIGIBLE_PROVIDER');

      // Queue row deleted
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeUndefined();

      // message.failed event recorded
      const events = await h.admin
        .select()
        .from(schema.messageEvents)
        .where(
          and(
            eq(schema.messageEvents.messageId, messageId),
            eq(schema.messageEvents.eventType, 'message.failed'),
          ),
        );
      expect(events.length).toBe(1);
      expect((events[0]!.payload as Record<string, unknown>).reason).toBe('NO_ELIGIBLE_PROVIDER');
    });
  });

  describe('5. Candidate Exhaustion After Fallback Attempts (P3-D14)', () => {
    it('terminalizes message as failed with NO_ELIGIBLE_PROVIDER when all candidates are exhausted after failures', async () => {
      const tenant = await createTestTenant('fb-exh');
      const p1 = await createProvider('p-exh-1', 'closed', '500');
      const p2 = await createProvider('p-exh-2', 'closed', '500');
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      // Attempt 1 -> p1 fails with 500 -> requeued
      const [claim1] = await dispatcher.claimBatch(1);
      const res1 = await dispatcher.processClaim(claim1!);
      expect(res1.outcome).toBe('failed');

      // Attempt 2 -> p2 fails with 500 -> candidate exhaustion -> terminal failed
      const [claim2] = await dispatcher.claimBatch(1);
      const res2 = await dispatcher.processClaim(claim2!);
      expect(res2.outcome).toBe('failed');
      expect(res2.error).toBe('NO_ELIGIBLE_PROVIDER');

      // 2 attempt rows recorded
      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId))
        .orderBy(schema.messageAttempts.attemptNumber);
      expect(attempts.length).toBe(2);
      expect(attempts[0]!.status).toBe('failed');
      expect(attempts[1]!.status).toBe('failed');

      // Message is failed with NO_ELIGIBLE_PROVIDER
      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('failed');
      expect(msg!.failureReason).toBe('NO_ELIGIBLE_PROVIDER');

      // Queue row deleted
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeUndefined();
    });
  });

  describe('6. Non-Fallback Failures (P3-D13)', () => {
    it('terminalizes on AUTH_ERROR without attempting secondary provider', async () => {
      const tenant = await createTestTenant('fb-auth');
      const p1 = await createProvider('p-auth-1', 'closed', 'INVALID_CREDENTIALS');
      const p2 = await createProvider('p-auth-2', 'closed'); // healthy
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      const [claim] = await dispatcher.claimBatch(1);
      const result = await dispatcher.processClaim(claim!);
      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('AUTH_ERROR');

      // Only 1 attempt row recorded for p1
      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId));
      expect(attempts.length).toBe(1);
      expect(attempts[0]!.providerId).toBe(p1);
      expect(attempts[0]!.status).toBe('failed');
      expect(attempts[0]!.failureReason).toContain('AUTH_ERROR');

      // Message is failed
      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('failed');
      expect(msg!.failureReason).toContain('AUTH_ERROR');

      // Queue row deleted
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeUndefined();
    });
  });

  describe('7. Ambiguous Outcome Handling (P3-D15, P3-D03)', () => {
    it('terminalizes on TIMEOUT as outcome_unknown without fallback', async () => {
      const tenant = await createTestTenant('fb-to');
      const p1 = await createProvider('p-to-1', 'closed', 'TIMEOUT');
      const p2 = await createProvider('p-to-2', 'closed');
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      const [claim] = await dispatcher.claimBatch(1);
      const result = await dispatcher.processClaim(claim!);
      expect(result.outcome).toBe('unknown');

      // Exactly 1 attempt row, status = outcome_unknown
      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId));
      expect(attempts.length).toBe(1);
      expect(attempts[0]!.providerId).toBe(p1);
      expect(attempts[0]!.status).toBe('outcome_unknown');

      // Message status = outcome_unknown
      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('outcome_unknown');

      // Event emitted: message.outcome_unknown
      const events = await h.admin
        .select()
        .from(schema.messageEvents)
        .where(
          and(
            eq(schema.messageEvents.messageId, messageId),
            eq(schema.messageEvents.eventType, 'message.outcome_unknown'),
          ),
        );
      expect(events.length).toBe(1);

      // Queue row deleted
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeUndefined();
    }, 15_000);

    it('terminalizes on UNKNOWN outcome as outcome_unknown without fallback', async () => {
      const tenant = await createTestTenant('fb-unk');
      const p1 = await createProvider('p-unk-1', 'closed');
      const p2 = await createProvider('p-unk-2', 'closed');
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      const [claim] = await dispatcher.claimBatch(1);

      // Spy on SimulatorAdapter submit to return category: 'UNKNOWN'
      const adapterProto = SimulatorAdapter.prototype as unknown as {
        submit: (
          _ctx: unknown,
          submission: { submissionId: string; correlationId?: string },
        ) => Promise<unknown>;
      };
      const spy = jest
        .spyOn(adapterProto, 'submit')
        .mockImplementationOnce(async (_ctx, submission) => ({
          outcome: 'rejected',
          submissionId: submission.submissionId,
          correlationId: submission.correlationId,
          failure: {
            category: 'UNKNOWN',
            message: 'Indeterminate network disconnect',
            retryable: false,
            providerCode: 'SIM-UNKNOWN',
          },
          latencyMs: 10,
        }));

      try {
        const result = await dispatcher.processClaim(claim!);
        expect(result.outcome).toBe('unknown');

        const attempts = await h.admin
          .select()
          .from(schema.messageAttempts)
          .where(eq(schema.messageAttempts.messageId, messageId));
        expect(attempts.length).toBe(1);
        expect(attempts[0]!.status).toBe('outcome_unknown');

        const [msg] = await h.admin
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, messageId));
        expect(msg!.status).toBe('outcome_unknown');

        const [queueRow] = await h.admin
          .select()
          .from(schema.messageDispatchQueue)
          .where(eq(schema.messageDispatchQueue.messageId, messageId));
        expect(queueRow).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('8. Concurrency & Fencing Integrity', () => {
    it('aborts settlement if fencing epoch was superseded by another worker during fallback', async () => {
      const tenant = await createTestTenant('fb-fence');
      const p1 = await createProvider('p-fence-1', 'closed', '500');
      const p2 = await createProvider('p-fence-2', 'closed');
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      // Worker A claims at epoch 1
      const [claimA] = await dispatcher.claimBatch(1);
      expect(claimA!.dispatchEpoch).toBe(1);

      // Simulate lease expiration + Worker B re-claiming the message at epoch 2
      await h.admin
        .update(schema.messageDispatchQueue)
        .set({ claimedUntil: new Date(Date.now() - 1000) })
        .where(eq(schema.messageDispatchQueue.messageId, messageId));

      const [claimB] = await dispatcher.claimBatch(1);
      expect(claimB!.dispatchEpoch).toBe(2);

      // Worker A tries to process claimA -> fails fencing check
      const resultA = await dispatcher.processClaim(claimA!);
      expect(resultA.outcome).toBe('fenced');

      // Queue row at epoch 2 is preserved
      const [queueMid] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueMid).toBeDefined();
      expect(queueMid!.dispatchEpoch).toBe(2);
      expect(queueMid!.claimToken).toBe(claimB!.claimToken);

      // Worker B processes its valid claim -> primary fails with 500 -> fallback requeued
      const resultB = await dispatcher.processClaim(claimB!);
      expect(resultB.outcome).toBe('failed');
    });
  });

  describe('9. Priority Ordering and Idempotent Selection', () => {
    it('strictly respects ascending priority order and does not re-evaluate attempted providers', async () => {
      const tenant = await createTestTenant('fb-prio');
      const pLow = await createProvider('p-prio-low', 'closed', '500'); // priority 1, fails
      const pMed = await createProvider('p-prio-med', 'closed'); // priority 2, succeeds
      const pHigh = await createProvider('p-prio-high', 'closed'); // priority 3, never reached

      await assignProvider(tenant, pLow, 1);
      await assignProvider(tenant, pMed, 2);
      await assignProvider(tenant, pHigh, 3);

      const messageId = await seedMessage(tenant);

      // Pass 1: Tries prio 1 (pLow) -> fails -> fallback requeued
      const [claim1] = await dispatcher.claimBatch(1);
      const res1 = await dispatcher.processClaim(claim1!);
      expect(res1.outcome).toBe('failed');

      // Pass 2: Candidate query excludes pLow. Tries prio 2 (pMed) -> succeeds -> accepted
      const [claim2] = await dispatcher.claimBatch(1);
      const res2 = await dispatcher.processClaim(claim2!);
      expect(res2.outcome).toBe('accepted');

      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, messageId))
        .orderBy(schema.messageAttempts.attemptNumber);
      expect(attempts.length).toBe(2);
      expect(attempts[0]!.providerId).toBe(pLow);
      expect(attempts[1]!.providerId).toBe(pMed);

      // pHigh was never assigned or attempted
      const pHighAttempts = attempts.filter((a) => a.providerId === pHigh);
      expect(pHighAttempts.length).toBe(0);
    });
  });

  describe('10. Crash Recovery on In-Flight Fallback (P3-D15, P3-D03)', () => {
    it('recovers expired lease on fallback-attempt to OUTCOME_UNKNOWN', async () => {
      const tenant = await createTestTenant('fb-crash');
      const p1 = await createProvider('p-crash-1', 'closed', '500');
      const p2 = await createProvider('p-crash-2', 'closed');
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      const messageId = await seedMessage(tenant);

      // Pass 1: p1 fails -> requeued
      const [claim1] = await dispatcher.claimBatch(1);
      await dispatcher.processClaim(claim1!);

      // Pass 2: Worker claims epoch 2
      const [claim2] = await dispatcher.claimBatch(1);
      expect(claim2!.dispatchEpoch).toBe(2);

      // Simulate mid-submission crash on attempt 2: create attempt 2 in submitting state
      const attempt2Id = uuidv7();
      await h.admin.insert(schema.messageAttempts).values({
        id: attempt2Id,
        messageId,
        orgId: tenant.orgId,
        providerId: p2,
        channelId,
        attemptNumber: 2,
        status: 'submitting',
        claimToken: claim2!.claimToken,
        fencingEpoch: claim2!.dispatchEpoch,
      });

      await h.admin
        .update(schema.messages)
        .set({ currentAttemptId: attempt2Id, status: 'submitting' })
        .where(eq(schema.messages.id, messageId));

      // Expire lease
      await h.admin
        .update(schema.messageDispatchQueue)
        .set({ claimedUntil: new Date(Date.now() - 5000) })
        .where(eq(schema.messageDispatchQueue.messageId, messageId));

      // Run crash recovery
      const recovered = await dispatcher.recoverExpiredLeases();
      expect(recovered).toBeGreaterThanOrEqual(1);

      // Verify attempt 2 is outcome_unknown
      const [att2] = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.id, attempt2Id));
      expect(att2!.status).toBe('outcome_unknown');

      // Verify message is outcome_unknown
      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('outcome_unknown');
      expect(msg!.completedAt).not.toBeNull();

      // Queue row deleted
      const [queue] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queue).toBeUndefined();
    });
  });

  describe('11. BE-DISPATCH-01: Provider Circuit Tripping & Transition Settlement', () => {
    it('repeated failures trip provider circuit to open, settles without 42501 rollback, and falls back to secondary', async () => {
      const tenant = await createTestTenant('fb-circ-trip');
      const p1 = await createProvider('p-trip-1', 'closed', '500');
      const p2 = await createProvider('p-trip-2', 'closed'); // secondary succeeds
      await assignProvider(tenant, p1, 1);
      await assignProvider(tenant, p2, 2);

      // Verify initial provider state in DB
      const [p1Initial] = await h.admin
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, p1));
      expect(p1Initial!.circuitState).toBe('closed');
      expect(Number(p1Initial!.circuitGeneration)).toBe(0);
      expect(p1Initial!.healthState).toBe('healthy');

      // 4 initial messages: each attempts p1 (fails with 500) -> requeued -> attempts p2 (succeeds)
      for (let i = 1; i <= 4; i++) {
        const msgId = await seedMessage(tenant);

        // Attempt on p1
        const [claim1] = await dispatcher.claimBatch(1);
        expect(claim1).toBeDefined();
        expect(claim1!.messageId).toBe(msgId);
        const res1 = await dispatcher.processClaim(claim1!);
        expect(res1.outcome).toBe('failed');
        expect(res1.error).toContain('PROVIDER_ERROR');

        // Fallback attempt on p2
        const [claim2] = await dispatcher.claimBatch(1);
        expect(claim2).toBeDefined();
        expect(claim2!.messageId).toBe(msgId);
        const res2 = await dispatcher.processClaim(claim2!);
        expect(res2.outcome).toBe('accepted');

        // Circuit should still be closed (minSamples = 5)
        const [p1Mid] = await h.admin
          .select()
          .from(schema.providers)
          .where(eq(schema.providers.id, p1));
        expect(p1Mid!.circuitState).toBe('closed');
        expect(Number(p1Mid!.circuitGeneration)).toBe(0);
      }

      // 5th message: 5th failure on p1 trips the circuit (closed -> open, generation 0 -> 1, health -> offline)
      const msgId5 = await seedMessage(tenant);

      const [claim5_1] = await dispatcher.claimBatch(1);
      expect(claim5_1).toBeDefined();
      expect(claim5_1!.messageId).toBe(msgId5);

      const res5_1 = await dispatcher.processClaim(claim5_1!);
      // Verification: settlement did NOT roll back with SQLSTATE 42501 (outcome is failed, NOT unknown)
      expect(res5_1.outcome).toBe('failed');
      expect(res5_1.error).toContain('PROVIDER_ERROR');

      // Verify provider state in DB transitioned properly under acc_dispatch
      const [p1Tripped] = await h.admin
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, p1));
      expect(p1Tripped!.circuitState).toBe('open');
      expect(Number(p1Tripped!.circuitGeneration)).toBe(1);
      expect(p1Tripped!.circuitChangedAt).not.toBeNull();
      expect(p1Tripped!.healthState).toBe('offline');

      // Verify message 5 is NOT stuck in submitting or outcome_unknown
      const [msg5Mid] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, msgId5));
      expect(msg5Mid!.status).toBe('queued');
      expect(msg5Mid!.currentAttemptId).toBeNull();

      // Message 5 fallback to p2 succeeds
      const [claim5_2] = await dispatcher.claimBatch(1);
      expect(claim5_2).toBeDefined();
      expect(claim5_2!.messageId).toBe(msgId5);

      const res5_2 = await dispatcher.processClaim(claim5_2!);
      expect(res5_2.outcome).toBe('accepted');

      const [msg5Final] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, msgId5));
      expect(msg5Final!.status).toBe('accepted');

      // Subsequent message 6: skips open circuit p1 in-memory without attempt, dispatches directly to p2
      const msgId6 = await seedMessage(tenant);

      const [claim6] = await dispatcher.claimBatch(1);
      expect(claim6).toBeDefined();
      expect(claim6!.messageId).toBe(msgId6);

      const res6 = await dispatcher.processClaim(claim6!);
      expect(res6.outcome).toBe('accepted');

      // Verify attempts on message 6: only 1 attempt, directly on p2
      const attempts6 = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, msgId6));
      expect(attempts6).toHaveLength(1);
      expect(attempts6[0]!.providerId).toBe(p2);
      expect(attempts6[0]!.status).toBe('accepted');
    });
  });
});
