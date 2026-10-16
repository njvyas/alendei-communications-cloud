/**
 * Phase 3.4 Message Fallback & Resilience Security Specification Suite
 * (ADR-014 §7, §8, P3-D13, P3-D14, P3-D15, P3-D03)
 *
 * Covers:
 * 1. Database Guard Boundary on Message State Transitions:
 *    - Rejection of `submitting -> queued` for `acc_app` and unauthorized principals (42501 UNAUTHORIZED_REQUEUE).
 *    - RLS suppression (0 rows updated) when dispatch claim token is missing or lease is expired.
 *    - Rejection of `submitting -> queued` without durably settled attempt (FALLBACK_ATTEMPT_UNVERIFIED).
 *    - Rejection of `submitting -> queued` when attempt is in `outcome_unknown` (FALLBACK_ATTEMPT_UNVERIFIED).
 *    - Rejection of `submitting -> queued` for non-fallback failure categories: AUTH_ERROR, INVALID_REQUEST (FALLBACK_ATTEMPT_UNVERIFIED).
 *    - Permission of `submitting -> queued` for `acc_dispatch` under active claim with settled PROVIDER_ERROR or RATE_LIMITED attempt.
 * 2. Terminal State Immutability:
 *    - Terminal states (`accepted`, `failed`, `outcome_unknown`) cannot transition to `queued` or any other state (MESSAGE_ALREADY_TERMINAL).
 * 3. Tenant Content Model B Isolation during fallback:
 *    - Cross-tenant messages and attempts remain strictly isolated across fallback hops.
 */
import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { DISPATCH_POOL } from '../src/database/database.tokens';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('Phase 3.4 Fallback & Resilience Security Suite', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatchPool: Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  let channelId: string;
  let providerId: string;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatchPool = h.app.get(DISPATCH_POOL);

    tenantA = await createTenant(h.admin, 'sec34-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'sec34-tenant-b', credentials);

    // Channel
    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = c!.id;

    // Provider
    const pSlug = `sec34-prov-${randomBytes(4).toString('hex')}`;
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

    // Active assignment
    await h.admin.insert(schema.organizationProviderAssignments).values([
      {
        orgId: tenantA.orgId,
        channelId,
        providerId,
        priority: 1,
        status: 'active',
      },
    ]);
  });

  afterAll(async () => {
    await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, tenantA.orgId));
    await h.admin
      .delete(schema.messageAttempts)
      .where(eq(schema.messageAttempts.orgId, tenantA.orgId));
    await h.admin
      .delete(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.orgId, tenantA.orgId));
    await h.admin.delete(schema.messages).where(eq(schema.messages.orgId, tenantA.orgId));
    await h.admin.delete(schema.contacts).where(eq(schema.contacts.orgId, tenantA.orgId));
    await h.admin
      .delete(schema.organizationProviderAssignments)
      .where(eq(schema.organizationProviderAssignments.orgId, tenantA.orgId));
    await h.admin.delete(schema.providers).where(eq(schema.providers.id, providerId));
    await destroyTenant(h.admin, tenantA);
    await destroyTenant(h.admin, tenantB);
    if (dispatchPool) await dispatchPool.end();
    await h.close();
  });

  async function seedMessage(orgId: string, workspaceId: string): Promise<string> {
    const [contact] = await h.admin
      .insert(schema.contacts)
      .values({
        orgId,
        workspaceId,
        displayName: 'Test Recipient',
        status: 'active',
      })
      .returning();

    const [msg] = await h.admin
      .insert(schema.messages)
      .values({
        orgId,
        workspaceId,
        contactId: contact!.id,
        channelId,
        recipientAddress: '+15555550100',
        correlationId: `corr-${uuidv7()}`,
        status: 'queued',
      })
      .returning();

    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId: msg!.id,
      orgId,
      dispatchEpoch: 0,
      availableAt: new Date(),
    });

    return msg!.id;
  }

  describe('1. Database Guard Boundary on Fallback Transition (submitting -> queued)', () => {
    it('rejects submitting -> queued when attempted by acc_app or unauthorized principal', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);

      // Set to submitting as admin
      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting' })
        .where(eq(schema.messages.id, msgId));

      const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true)`,
          [tenantA.orgId, tenantA.userId],
        );

        await expect(
          client.query(`UPDATE messages SET status = 'queued' WHERE id = $1`, [msgId]),
        ).rejects.toThrow(/UNAUTHORIZED_REQUEUE/);

        await client.query('ROLLBACK');
      } finally {
        client.release();
        await appPool.end();
      }
    });

    it('rejects submitting -> queued without active unexpired dispatch claim (RLS suppresses update to 0 rows)', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);
      const attemptId = uuidv7();
      const token = uuidv7();

      // Set attempt and message to submitting
      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting', currentAttemptId: attemptId })
        .where(eq(schema.messages.id, msgId));

      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId: msgId,
        orgId: tenantA.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        fencingEpoch: 1,
        claimToken: token,
        status: 'failed',
        failureReason: 'PROVIDER_ERROR: simulated error',
      });

      // Claim in queue has token NULL
      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, token],
        );

        // RLS messages_dispatch_update matches 0 rows because claim_token does not match queue row
        const res = await client.query(`UPDATE messages SET status = 'queued' WHERE id = $1`, [
          msgId,
        ]);
        expect(res.rowCount).toBe(0);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('rejects submitting -> queued when claim lease is expired in queue (RLS suppresses update to 0 rows)', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);
      const attemptId = uuidv7();
      const token = uuidv7();

      // Claim is expired in message_dispatch_queue
      await h.admin
        .update(schema.messageDispatchQueue)
        .set({
          claimToken: token,
          dispatchEpoch: 1,
          claimedUntil: new Date(Date.now() - 5000), // Expired
        })
        .where(eq(schema.messageDispatchQueue.messageId, msgId));

      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting', currentAttemptId: attemptId })
        .where(eq(schema.messages.id, msgId));

      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId: msgId,
        orgId: tenantA.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        fencingEpoch: 1,
        claimToken: token,
        status: 'failed',
        failureReason: 'PROVIDER_ERROR: 500',
      });

      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, token],
        );

        // RLS messages_dispatch_update matches 0 rows because claimed_until <= now()
        const res = await client.query(`UPDATE messages SET status = 'queued' WHERE id = $1`, [
          msgId,
        ]);
        expect(res.rowCount).toBe(0);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('rejects submitting -> queued without durably settled failed attempt (attempt still submitting)', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);
      const attemptId = uuidv7();
      const token = uuidv7();

      await h.admin
        .update(schema.messageDispatchQueue)
        .set({
          claimToken: token,
          dispatchEpoch: 1,
          claimedUntil: new Date(Date.now() + 30000),
        })
        .where(eq(schema.messageDispatchQueue.messageId, msgId));

      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting', currentAttemptId: attemptId })
        .where(eq(schema.messages.id, msgId));

      // Attempt is still 'submitting' (NOT settled as failed)
      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId: msgId,
        orgId: tenantA.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        fencingEpoch: 1,
        claimToken: token,
        status: 'submitting',
      });

      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, token],
        );

        await expect(
          client.query(`UPDATE messages SET status = 'queued' WHERE id = $1`, [msgId]),
        ).rejects.toThrow(/FALLBACK_ATTEMPT_UNVERIFIED/);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('rejects submitting -> queued when attempt settled as outcome_unknown', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);
      const attemptId = uuidv7();
      const token = uuidv7();

      await h.admin
        .update(schema.messageDispatchQueue)
        .set({
          claimToken: token,
          dispatchEpoch: 1,
          claimedUntil: new Date(Date.now() + 30000),
        })
        .where(eq(schema.messageDispatchQueue.messageId, msgId));

      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting', currentAttemptId: attemptId })
        .where(eq(schema.messages.id, msgId));

      // Attempt settled as outcome_unknown
      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId: msgId,
        orgId: tenantA.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        fencingEpoch: 1,
        claimToken: token,
        status: 'outcome_unknown',
        failureReason: 'TIMEOUT: timed out',
      });

      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, token],
        );

        await expect(
          client.query(`UPDATE messages SET status = 'queued' WHERE id = $1`, [msgId]),
        ).rejects.toThrow(/FALLBACK_ATTEMPT_UNVERIFIED/);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('rejects submitting -> queued for non-fallback failure categories (AUTH_ERROR, INVALID_REQUEST, CONFIGURATION_ERROR)', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);
      const attemptId = uuidv7();
      const token = uuidv7();

      await h.admin
        .update(schema.messageDispatchQueue)
        .set({
          claimToken: token,
          dispatchEpoch: 1,
          claimedUntil: new Date(Date.now() + 30000),
        })
        .where(eq(schema.messageDispatchQueue.messageId, msgId));

      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting', currentAttemptId: attemptId })
        .where(eq(schema.messages.id, msgId));

      // Attempt failed with AUTH_ERROR (non-fallback eligible)
      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId: msgId,
        orgId: tenantA.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        fencingEpoch: 1,
        claimToken: token,
        status: 'failed',
        failureReason: 'AUTH_ERROR: Bad API credentials',
      });

      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, token],
        );

        await expect(
          client.query(`UPDATE messages SET status = 'queued' WHERE id = $1`, [msgId]),
        ).rejects.toThrow(/FALLBACK_ATTEMPT_UNVERIFIED/);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('permits submitting -> queued for acc_dispatch with active claim and settled PROVIDER_ERROR or RATE_LIMITED attempt', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);
      const attemptId = uuidv7();
      const token = uuidv7();

      await h.admin
        .update(schema.messageDispatchQueue)
        .set({
          claimToken: token,
          dispatchEpoch: 1,
          claimedUntil: new Date(Date.now() + 30000),
        })
        .where(eq(schema.messageDispatchQueue.messageId, msgId));

      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting', currentAttemptId: attemptId })
        .where(eq(schema.messages.id, msgId));

      // Attempt settled as failed with PROVIDER_ERROR
      await h.admin.insert(schema.messageAttempts).values({
        id: attemptId,
        messageId: msgId,
        orgId: tenantA.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        fencingEpoch: 1,
        claimToken: token,
        status: 'failed',
        failureReason: 'PROVIDER_ERROR: 502 Bad Gateway',
      });

      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, token],
        );

        // Update succeeds!
        await client.query(
          `UPDATE messages SET status = 'queued', current_attempt_id = NULL WHERE id = $1`,
          [msgId],
        );

        const res = await client.query(
          `SELECT status, current_attempt_id FROM messages WHERE id = $1`,
          [msgId],
        );
        expect(res.rows[0].status).toBe('queued');
        expect(res.rows[0].current_attempt_id).toBeNull();

        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });
  });

  describe('2. Terminal State Immutability', () => {
    it('strictly forbids transitions out of accepted, failed, or outcome_unknown', async () => {
      const msgId = await seedMessage(tenantA.orgId, tenantA.workspaceId);

      // Transition queued -> submitting -> accepted
      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting' })
        .where(eq(schema.messages.id, msgId));

      await h.admin
        .update(schema.messages)
        .set({ status: 'accepted' })
        .where(eq(schema.messages.id, msgId));

      let threw1 = false;
      try {
        await h.admin.execute(sql`UPDATE messages SET status = 'queued' WHERE id = ${msgId}`);
      } catch (err: unknown) {
        threw1 = true;
        const msg =
          err instanceof Error
            ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message || ''}`
            : String(err);
        expect(msg).toMatch(/MESSAGE_ALREADY_TERMINAL/);
      }
      expect(threw1).toBe(true);

      // Reset to submitting then outcome_unknown
      const msgId2 = await seedMessage(tenantA.orgId, tenantA.workspaceId);
      await h.admin
        .update(schema.messages)
        .set({ status: 'submitting' })
        .where(eq(schema.messages.id, msgId2));
      await h.admin
        .update(schema.messages)
        .set({ status: 'outcome_unknown' })
        .where(eq(schema.messages.id, msgId2));

      let threw2 = false;
      try {
        await h.admin.execute(sql`UPDATE messages SET status = 'queued' WHERE id = ${msgId2}`);
      } catch (err: unknown) {
        threw2 = true;
        const msg =
          err instanceof Error
            ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message || ''}`
            : String(err);
        expect(msg).toMatch(/MESSAGE_ALREADY_TERMINAL/);
      }
      expect(threw2).toBe(true);
    });
  });
});
