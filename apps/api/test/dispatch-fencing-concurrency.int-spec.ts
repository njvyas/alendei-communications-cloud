import { randomBytes } from 'node:crypto';
import { ORG_LIFECYCLE_LOCK_CLASS, schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import { DISPATCH_POOL } from '../src/database/database.tokens';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('Dispatch Concurrency, Fencing, Crash Recovery & Lifecycle Serialization (Phase 3.3)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenant: TenantFixture;
  let channelId: string;
  let providerId: string;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);

    tenant = await createTenant(h.admin, 'fencing-tenant', credentials);

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

    // Provider: simulator provider
    const pSlug = `prov-${randomBytes(4).toString('hex')}`;
    const [prov] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `WhatsApp Simulator ${pSlug}`,
        slug: pSlug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerId = prov!.id;

    // Active assignment for tenant
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: tenant.orgId,
      channelId,
      providerId,
      priority: 1,
      status: 'active',
    });
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
        if (tenant) {
          await h.admin
            .delete(schema.organizationProviderAssignments)
            .where(eq(schema.organizationProviderAssignments.orgId, tenant.orgId))
            .catch(() => {});
        }
        if (providerId) {
          await h.admin
            .delete(schema.providers)
            .where(eq(schema.providers.id, providerId))
            .catch(() => {});
        }
        if (tenant) {
          await destroyTenant(h.admin, tenant).catch(() => {});
        }
      }
    } catch {
      // Best-effort cleanup
    } finally {
      await h.close();
    }
  });

  async function seedMessage(
    customOrgId = tenant.orgId,
  ): Promise<{ messageId: string; contactId: string }> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: customOrgId,
      workspaceId: tenant.workspaceId,
      displayName: 'Test Recipient',
    });

    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: customOrgId,
      workspaceId: tenant.workspaceId,
      contactId,
      channelId,
      recipientAddress: '+12025550199',
      status: 'queued',
      payload: { text: 'Concurrency test message' },
      correlationId: uuidv7(),
    });

    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: customOrgId,
      priority: 1,
      dispatchEpoch: 0,
      claimedUntil: null,
      claimToken: null,
    });

    return { messageId, contactId };
  }

  describe('1. FOR UPDATE SKIP LOCKED Concurrency', () => {
    it('concurrent workers claim disjoint messages with zero collision', async () => {
      const messageIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { messageId } = await seedMessage();
        messageIds.push(messageId);
      }

      // Run 3 concurrent worker claims
      const [batch1, batch2, batch3] = await Promise.all([
        dispatcher.claimBatch(2),
        dispatcher.claimBatch(2),
        dispatcher.claimBatch(2),
      ]);

      const claimed1 = batch1.map((c) => c.messageId);
      const claimed2 = batch2.map((c) => c.messageId);
      const claimed3 = batch3.map((c) => c.messageId);

      const allClaimed = [...claimed1, ...claimed2, ...claimed3];
      expect(allClaimed.length).toBe(6);

      // Verify no overlap among claimed batches (disjoint sets)
      const uniqueClaimed = new Set(allClaimed);
      expect(uniqueClaimed.size).toBe(6);

      // Verify every claimed message is in the seeded set
      for (const id of allClaimed) {
        expect(messageIds).toContain(id);
      }

      // Check database state: all 6 rows are claimed with 30s lease and epoch = 1
      const queueRows = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(sql`message_id IN ${allClaimed}`);
      expect(queueRows.length).toBe(6);
      for (const r of queueRows) {
        expect(r.dispatchEpoch).toBe(1);
        expect(r.claimToken).not.toBeNull();
        expect(r.claimedUntil).not.toBeNull();
        expect(r.claimedUntil!.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  describe('2. Lease Expiration & Re-claiming', () => {
    it('expired lease allows message to be re-claimed with incremented dispatch_epoch', async () => {
      const { messageId } = await seedMessage();

      // First claim
      const claims1 = await dispatcher.claimBatch(10);
      const claim1 = claims1.find((c) => c.messageId === messageId);
      expect(claim1).toBeDefined();
      expect(claim1!.dispatchEpoch).toBe(1);

      // While lease is active, another claim returns nothing for this message
      const claimsActive = await dispatcher.claimBatch(10);
      expect(claimsActive.find((c) => c.messageId === messageId)).toBeUndefined();

      // Manually expire the lease in DB (claimed_until in the past)
      await h.admin
        .update(schema.messageDispatchQueue)
        .set({ claimedUntil: new Date(Date.now() - 5000) })
        .where(eq(schema.messageDispatchQueue.messageId, messageId));

      // Now claimBatch should pick it up again
      const claims2 = await dispatcher.claimBatch(10);
      const claim2 = claims2.find((c) => c.messageId === messageId);
      expect(claim2).toBeDefined();
      expect(claim2!.dispatchEpoch).toBe(2);
      expect(claim2!.claimToken).not.toBe(claim1!.claimToken);
    });
  });

  describe('3. Fencing Epoch Abort on Token Mismatch', () => {
    it('aborts settlement if fencing epoch or token was superseded by another worker', async () => {
      const { messageId } = await seedMessage();

      // Worker A claims message at epoch 1
      const [claimA] = await dispatcher.claimBatch(1);
      expect(claimA).toBeDefined();
      expect(claimA!.messageId).toBe(messageId);
      expect(claimA!.dispatchEpoch).toBe(1);

      // Simulate lease expiration + Worker B re-claiming the message at epoch 2
      await h.admin
        .update(schema.messageDispatchQueue)
        .set({ claimedUntil: new Date(Date.now() - 1000) })
        .where(eq(schema.messageDispatchQueue.messageId, messageId));

      const [claimB] = await dispatcher.claimBatch(1);
      expect(claimB).toBeDefined();
      expect(claimB!.messageId).toBe(messageId);
      expect(claimB!.dispatchEpoch).toBe(2);
      expect(claimB!.claimToken).not.toBe(claimA!.claimToken);

      // Worker A attempts to process its stale claim (epoch 1, stale token)
      const resultA = await dispatcher.processClaim(claimA!);
      expect(resultA.outcome).toBe('fenced');

      // Verify the queue row was NOT deleted by Worker A
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeDefined();
      expect(queueRow!.dispatchEpoch).toBe(2);
      expect(queueRow!.claimToken).toBe(claimB!.claimToken);

      // Worker B successfully processes its valid claim (epoch 2)
      const resultB = await dispatcher.processClaim(claimB!);
      expect(resultB.outcome).toBe('accepted');

      // Verify queue row is now removed upon successful settlement by Worker B
      const [finalQueue] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(finalQueue).toBeUndefined();

      // Verify message is accepted
      const [finalMsg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(finalMsg!.status).toBe('accepted');
    });
  });

  describe('4. Crash Recovery (Terminal OUTCOME_UNKNOWN)', () => {
    it('recovers expired lease on submitting attempt to OUTCOME_UNKNOWN (terminal, non-retryable)', async () => {
      const { messageId } = await seedMessage();

      // Claim the message
      const [claim] = await dispatcher.claimBatch(1);
      expect(claim).toBeDefined();

      // Create an attempt in "submitting" status (simulating a crash mid-submission)
      const attemptId = uuidv7();
      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId,
        orgId: tenant.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        status: 'submitting',
        claimToken: claim!.claimToken,
        fencingEpoch: claim!.dispatchEpoch,
      });

      await h.admin
        .update(schema.messages)
        .set({ currentAttemptId: attemptId, status: 'submitting' })
        .where(eq(schema.messages.id, messageId));

      // Expire the lease in the queue
      await h.admin
        .update(schema.messageDispatchQueue)
        .set({ claimedUntil: new Date(Date.now() - 10000) })
        .where(eq(schema.messageDispatchQueue.messageId, messageId));

      // Run crash recovery
      const recoveredCount = await dispatcher.recoverExpiredLeases();
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      // Verify attempt is terminalized as outcome_unknown
      const [attempt] = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.id, attemptId));
      expect(attempt!.status).toBe('outcome_unknown');
      expect(attempt!.completedAt).not.toBeNull();

      // Verify message is terminalized as outcome_unknown
      const [msg] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msg!.status).toBe('outcome_unknown');
      expect(msg!.failureReason).toContain('outcome_unknown');
      expect(msg!.completedAt).not.toBeNull();

      // Verify message_events recorded outcome_unknown
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
      expect((events[0]!.payload as Record<string, unknown>).outcome).toBe('outcome_unknown');

      // Verify queue row was removed from message_dispatch_queue
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeUndefined();
    });
  });

  describe('5. Organization Lifecycle Serialization (Advisory Lock)', () => {
    it('serializes organization suspension with in-flight message dispatch', async () => {
      await seedMessage();
      const [claim] = await dispatcher.claimBatch(1);
      expect(claim).toBeDefined();

      // Open a dedicated dispatch client that acquires the shared advisory lock
      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT pg_advisory_xact_lock_shared(${ORG_LIFECYCLE_LOCK_CLASS}, hashtext($1::text))`,
          [claim!.orgId],
        );

        // Attempting to suspend the organization in another transaction should be blocked
        let orgUpdateFinished = false;
        const updatePromise = h.admin
          .update(schema.organizations)
          .set({ status: 'suspended' })
          .where(eq(schema.organizations.id, tenant.orgId))
          .then(() => {
            orgUpdateFinished = true;
          });

        // Give it 100ms to verify update does NOT finish while shared lock is held
        await new Promise((r) => setTimeout(r, 100));
        expect(orgUpdateFinished).toBe(false);

        // Release the shared advisory lock by committing the dispatch transaction
        await client.query('COMMIT');

        // Now the org update should complete
        await updatePromise;
        expect(orgUpdateFinished).toBe(true);

        const [org] = await h.admin
          .select({ status: schema.organizations.status })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, tenant.orgId));
        expect(org!.status).toBe('suspended');

        // Restore org status for cleanup
        await h.admin
          .update(schema.organizations)
          .set({ status: 'active' })
          .where(eq(schema.organizations.id, tenant.orgId));
      } finally {
        client.release();
      }
    });
  });
});
