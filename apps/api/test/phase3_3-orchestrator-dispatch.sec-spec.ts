/**
 * Phase 3.3 Orchestrator & Dispatch Execution Security Specification Suite
 * (ADR-014 §4, §9.2, §12, §17.1; ADR-015 R-7, R-8, R-13, HIGH-6, MEDIUM-7)
 *
 * Covers:
 * 1. Model B RLS on Tenant-Content Tables (messages, message_attempts, message_events):
 *    - Strict context validation: requires org_id = app_current_org_id() AND app_content_context_valid().
 *    - Absence of platform / reseller reach: no break-glass, support, or reseller reach into content.
 *    - Cross-tenant isolation: Tenant A cannot select, insert, or update Tenant B messages.
 * 2. Model A RLS on Tenancy-Record Queue (message_dispatch_queue):
 *    - Scoped by app_org_in_scope(org_id) for acc_app.
 *    - Content-free: carries queue identifiers, fencing epochs, lease timestamps only.
 * 3. Dedicated `acc_dispatch` Database Principal Isolation & Least Privilege:
 *    - Forbidden administrative writes on messages (cannot modify payload, channel_id, recipient, org_id).
 *    - Forbidden audit log insertion (HIGH-6 / table grant denial).
 *    - Strictly bounded dispatch context: zero rows visible without valid dispatch session context
 *      (app.current_org_id, app.dispatch_message_id, app.dispatch_claim_token) and active lease.
 *    - Denial of cross-tenant observation and deletion on content tables.
 * 4. Anti-Enumeration across HTTP boundary:
 *    - Cross-tenant GET /messages/:id returns 404 RESOURCE_NOT_FOUND.
 * 5. Fencing Integrity & Attempt Binding:
 *    - message_attempts and provider_health insertion strictly bound to matching claim token.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { DISPATCH_POOL } from '../src/database/database.tokens';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeProviderHealth,
  removeIdentities,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 3.3 Orchestrator & Dispatch Execution Security Suite', () => {
  let h: Harness;
  let credentials: CredentialService;
  let appPool: Pool;
  let adminPool: Pool;
  let dispatchPool: Pool;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let platformToken: string;
  let platUserId: string | undefined;

  let channelId: string;
  let providerId: string;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatchPool = h.app.get(DISPATCH_POOL);

    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });

    tenantA = await createTenant(h.admin, 'sec33-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'sec33-tenant-b', credentials);

    // Grant messages permissions to tenant users
    const msgPerms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
      );

    for (const t of [tenantA, tenantB]) {
      const rId = uuidv7();
      await h.admin.insert(schema.roles).values({
        id: rId,
        orgId: t.orgId,
        key: `msg_role_${randomBytes(4).toString('hex')}`,
        name: 'Messages Role',
        description: 'Allows messages send and read',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });

      for (const p of msgPerms) {
        await h.admin.insert(schema.rolePermissions).values({
          roleId: rId,
          permissionId: p.id,
          orgId: t.orgId,
        });
      }

      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.insert(schema.userRoles).values({
          userId: t.userId,
          roleId: rId,
          scopeType: 'organization',
          scopeId: t.orgId,
        });
      });
    }

    // Channel
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

    // Provider
    const pSlug = `sec33-prov-${randomBytes(4).toString('hex')}`;
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

    // Active assignment for tenantA and tenantB
    await h.admin.insert(schema.organizationProviderAssignments).values([
      {
        orgId: tenantA.orgId,
        channelId,
        providerId,
        priority: 1,
        status: 'active',
      },
      {
        orgId: tenantB.orgId,
        channelId,
        providerId,
        priority: 1,
        status: 'active',
      },
    ]);

    // Logins
    await h.clearRateLimits();
    const resA = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantA.email, password: PASSWORD })
      .expect(200);
    tokenA = resA.body.data.accessToken as string;

    await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantB.email, password: PASSWORD })
      .expect(200);

    // Platform user
    const platEmail = `plat-${uuidv7().slice(-8)}@example.test`;
    const [platUser] = await h.admin
      .insert(schema.users)
      .values({
        email: platEmail,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
      })
      .returning();
    platUserId = platUser!.id;
    const [superRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN));
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: platUser!.id,
        roleId: superRole!.id,
        scopeType: 'platform',
      });
    });
    const resPlat = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: platEmail, password: PASSWORD })
      .expect(200);
    platformToken = resPlat.body.data.accessToken as string;
  }, 60_000);

  afterAll(async () => {
    try {
      if (h?.admin) {
        if (providerId) {
          await purgeProviderHealth(h.admin, sql`provider_id = ${providerId}`);
        }
        const orgIds = [tenantA?.orgId, tenantB?.orgId].filter(Boolean);
        if (orgIds.length > 0) {
          await h.admin.execute(
            sql`DELETE FROM message_events WHERE org_id IN (${sql.join(
              orgIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
          await h.admin.execute(
            sql`DELETE FROM message_attempts WHERE org_id IN (${sql.join(
              orgIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
          await h.admin.execute(
            sql`DELETE FROM message_dispatch_queue WHERE org_id IN (${sql.join(
              orgIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
          await h.admin.execute(
            sql`DELETE FROM messages WHERE org_id IN (${sql.join(
              orgIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
          await h.admin.execute(
            sql`DELETE FROM contacts WHERE org_id IN (${sql.join(
              orgIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
          await h.admin.execute(
            sql`DELETE FROM organization_provider_assignments WHERE org_id IN (${sql.join(
              orgIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
        }
        if (providerId) {
          await h.admin.execute(sql`DELETE FROM providers WHERE id = ${providerId}`);
        }
        if (platUserId) {
          await removeIdentities(h.admin, [platUserId]);
        }
        if (tenantA) await destroyTenant(h.admin, tenantA);
        if (tenantB) await destroyTenant(h.admin, tenantB);
      }
    } catch {
      // Best-effort cleanup
    } finally {
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
      if (h) await h.close();
    }
  }, 60_000);

  async function seedTenantMessage(orgId: string, workspaceId: string): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId,
      workspaceId,
      firstName: 'Sec',
      lastName: 'Recipient',
    });

    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId,
      workspaceId,
      contactId,
      channelId,
      recipientAddress: '+12025550188',
      status: 'queued',
      payload: { text: 'Confidential Tenant Content' },
      correlationId: uuidv7(),
    });

    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId,
      priority: 1,
      dispatchEpoch: 0,
      claimedUntil: null,
      claimToken: null,
    });

    return messageId;
  }

  describe('1. Model B RLS on Tenant-Content Tables (messages, message_attempts, message_events)', () => {
    it('enforces app_content_context_valid(): acc_app sees zero rows without valid content context', async () => {
      const msgId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const client = await appPool.connect();

      try {
        await client.query('BEGIN');
        // Set org_id alone without setting valid user or API key content context
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [tenantA.orgId]);

        const { rows } = await client.query(`SELECT * FROM messages WHERE id = $1`, [msgId]);
        // Model B RLS evaluates app_content_context_valid() => false => 0 rows returned
        expect(rows).toHaveLength(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('denies platform admin and reseller reach into tenant content (No break-glass or support arm)', async () => {
      const msgId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const client = await appPool.connect();

      try {
        await client.query('BEGIN');
        // Simulate platform administrator context
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.is_platform_admin', 'on', true)`,
          [tenantA.orgId],
        );

        const { rows: msgRows } = await client.query(`SELECT * FROM messages WHERE id = $1`, [
          msgId,
        ]);
        expect(msgRows).toHaveLength(0);

        // Simulate reseller context
        await client.query(
          `SELECT set_config('app.current_reseller_id', $1, true),
                  set_config('app.is_platform_admin', '', true)`,
          [tenantA.resellerId],
        );

        const { rows: resellerRows } = await client.query(`SELECT * FROM messages WHERE id = $1`, [
          msgId,
        ]);
        expect(resellerRows).toHaveLength(0);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('enforces cross-tenant isolation: Tenant A cannot select, insert, or update Tenant B messages', async () => {
      const msgBId = await seedTenantMessage(tenantB.orgId, tenantB.workspaceId);
      const client = await appPool.connect();

      try {
        await client.query('BEGIN');
        // Set tenant A context with user A grant
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true)`,
          [tenantA.orgId, tenantA.userId],
        );

        // SELECT Tenant B message
        const { rows: selectRows } = await client.query(`SELECT * FROM messages WHERE id = $1`, [
          msgBId,
        ]);
        expect(selectRows).toHaveLength(0);

        // UPDATE Tenant B message
        const updateResult = await client.query(
          `UPDATE messages SET status = 'failed' WHERE id = $1`,
          [msgBId],
        );
        expect(updateResult.rowCount).toBe(0);

        // INSERT message with Tenant B org_id under Tenant A context fails check
        await expect(
          client.query(
            `INSERT INTO messages (
               id, org_id, workspace_id, contact_id, channel_id,
               recipient_address, status, payload, correlation_id
             ) VALUES (
               $1, $2, $3, $4, $5, '+12025550999', 'queued', '{"text":"Cross-tenant attack"}', $6
             )`,
            [uuidv7(), tenantB.orgId, tenantB.workspaceId, uuidv7(), channelId, uuidv7()],
          ),
        ).rejects.toThrow();

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('2. Model A RLS on Tenancy-Record Queue (message_dispatch_queue)', () => {
    it('isolates queue rows by organization scope for acc_app', async () => {
      const msgAId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const msgBId = await seedTenantMessage(tenantB.orgId, tenantB.workspaceId);

      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true)`,
          [tenantA.orgId, tenantA.userId],
        );

        const { rows } = await client.query<{ message_id: string }>(
          `SELECT message_id FROM message_dispatch_queue`,
        );
        const ids = rows.map((r) => r.message_id);
        expect(ids).toContain(msgAId);
        expect(ids).not.toContain(msgBId);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('3. Dedicated acc_dispatch Database Principal Isolation & Least Privilege', () => {
    it('forbids acc_dispatch from inserting into audit_logs (HIGH-6 / least privilege)', async () => {
      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        await expect(
          client.query(
            `INSERT INTO audit_logs (id, org_id, action, resource_type, resource_id, actor_label)
             VALUES ($1, $2, 'test.action', 'messages', $3, 'dispatcher')`,
            [uuidv7(), tenantA.orgId, uuidv7()],
          ),
        ).rejects.toThrow(/permission denied|42501/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('forbids acc_dispatch from modifying administrative/content columns on messages', async () => {
      const msgId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const client = await dispatchPool.connect();

      try {
        await client.query('BEGIN');
        // Set valid dispatch context
        const claimToken = uuidv7();
        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = $1, claimed_until = now() + interval '30 seconds', dispatch_epoch = 1
           WHERE message_id = $2`,
          [claimToken, msgId],
        );
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, claimToken],
        );

        // Attempting to update payload must be rejected by PostgreSQL column privileges
        await client.query('SAVEPOINT sp1');
        await expect(
          client.query(`UPDATE messages SET payload = '{"tampered":true}' WHERE id = $1`, [msgId]),
        ).rejects.toThrow(/permission denied|42501/);
        await client.query('ROLLBACK TO SAVEPOINT sp1');

        // Attempting to update recipient_address must be rejected
        await client.query('SAVEPOINT sp2');
        await expect(
          client.query(`UPDATE messages SET recipient_address = '+12025559999' WHERE id = $1`, [
            msgId,
          ]),
        ).rejects.toThrow(/permission denied|42501/);
        await client.query('ROLLBACK TO SAVEPOINT sp2');

        // Attempting to update channel_id must be rejected
        await client.query('SAVEPOINT sp3');
        await expect(
          client.query(`UPDATE messages SET channel_id = $1 WHERE id = $2`, [uuidv7(), msgId]),
        ).rejects.toThrow(/permission denied|42501/);
        await client.query('ROLLBACK TO SAVEPOINT sp3');

        // Attempting to update org_id must be rejected
        await client.query('SAVEPOINT sp4');
        await expect(
          client.query(`UPDATE messages SET org_id = $1 WHERE id = $2`, [tenantB.orgId, msgId]),
        ).rejects.toThrow(/permission denied|42501/);
        await client.query('ROLLBACK TO SAVEPOINT sp4');

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('forbids acc_dispatch from deleting messages, message_attempts, or message_events', async () => {
      const msgId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const client = await dispatchPool.connect();

      try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp1');
        await expect(client.query(`DELETE FROM messages WHERE id = $1`, [msgId])).rejects.toThrow(
          /permission denied|42501/,
        );
        await client.query('ROLLBACK TO SAVEPOINT sp1');

        await client.query('SAVEPOINT sp2');
        await expect(
          client.query(`DELETE FROM message_attempts WHERE message_id = $1`, [msgId]),
        ).rejects.toThrow(/permission denied|42501/);
        await client.query('ROLLBACK TO SAVEPOINT sp2');

        await client.query('SAVEPOINT sp3');
        await expect(
          client.query(`DELETE FROM message_events WHERE message_id = $1`, [msgId]),
        ).rejects.toThrow(/permission denied|42501/);
        await client.query('ROLLBACK TO SAVEPOINT sp3');

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('hides all tenant messages when dispatch context functions are not set or mismatched', async () => {
      const msgId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const client = await dispatchPool.connect();

      try {
        await client.query('BEGIN');

        // Case 1: No session context set
        const { rows: r1 } = await client.query(`SELECT * FROM messages WHERE id = $1`, [msgId]);
        expect(r1).toHaveLength(0);

        // Case 2: Only org_id set
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [tenantA.orgId]);
        const { rows: r2 } = await client.query(`SELECT * FROM messages WHERE id = $1`, [msgId]);
        expect(r2).toHaveLength(0);

        // Case 3: message_id set, but claim_token not matching queue
        await client.query(
          `SELECT set_config('app.dispatch_message_id', $1, true),
                  set_config('app.dispatch_claim_token', $2, true)`,
          [msgId, uuidv7()],
        );
        const { rows: r3 } = await client.query(`SELECT * FROM messages WHERE id = $1`, [msgId]);
        expect(r3).toHaveLength(0);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('prevents acc_dispatch from touching unrelated tenant messages or claims', async () => {
      const msgAId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const msgBId = await seedTenantMessage(tenantB.orgId, tenantB.workspaceId);
      const client = await dispatchPool.connect();

      try {
        await client.query('BEGIN');
        const tokenA = uuidv7();

        // Claim message A for tenant A
        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = $1, claimed_until = now() + interval '30 seconds', dispatch_epoch = 1
           WHERE message_id = $2`,
          [tokenA, msgAId],
        );

        // Worker sets context for message A in tenant A
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgAId, tokenA],
        );

        // Worker attempts to read Tenant B message
        const { rows: bRows } = await client.query(`SELECT * FROM messages WHERE id = $1`, [
          msgBId,
        ]);
        expect(bRows).toHaveLength(0);

        // Worker attempts to update Tenant B message
        const updateB = await client.query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [
          msgBId,
        ]);
        expect(updateB.rowCount).toBe(0);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('4. Anti-Enumeration across HTTP Boundary', () => {
    it('returns 404 RESOURCE_NOT_FOUND when retrieving message of another tenant', async () => {
      const msgBId = await seedTenantMessage(tenantB.orgId, tenantB.workspaceId);

      // Caller from Tenant A tries to GET Tenant B message
      const res = await request(h.app.getHttpServer())
        .get(url(`/messages/${msgBId}`))
        .set('authorization', `Bearer ${tokenA}`)
        .expect(404);

      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
      expect(res.body.error.message).toContain('Message not found');
    });

    it('returns 404 RESOURCE_NOT_FOUND for non-existent message ID', async () => {
      const nonExistentId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .get(url(`/messages/${nonExistentId}`))
        .set('authorization', `Bearer ${tokenA}`)
        .expect(404);

      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('refuses platform administrator from reading tenant message via HTTP (403 Forbidden)', async () => {
      const msgAId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);

      // Platform admin calling GET /messages/:id receives 403 because content permissions
      // are never conferred by platform grants (ADR-015 R-5 / R-8)
      await request(h.app.getHttpServer())
        .get(url(`/messages/${msgAId}`))
        .set('authorization', `Bearer ${platformToken}`)
        .set('x-acc-organization', tenantA.orgId)
        .expect(403);
    });
  });

  describe('5. Fencing Integrity & Attempt Binding', () => {
    it('binds message_attempts insertion to matching dispatch claim token and active provider', async () => {
      const msgId = await seedTenantMessage(tenantA.orgId, tenantA.workspaceId);
      const client = await dispatchPool.connect();

      try {
        await client.query('BEGIN');
        const validToken = uuidv7();
        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = $1, claimed_until = now() + interval '30 seconds', dispatch_epoch = 1
           WHERE message_id = $2`,
          [validToken, msgId],
        );

        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [tenantA.orgId, msgId, validToken],
        );

        // Attempting to insert attempt with mismatched claim_token fails RLS WITH CHECK
        await client.query('SAVEPOINT sp_mismatch');
        await expect(
          client.query(
            `INSERT INTO message_attempts (
               id, message_id, org_id, provider_id, channel_id, attempt_number,
               fencing_epoch, claim_token, status
             ) VALUES (
               $1, $2, $3, $4, $5, 1, 1, $6, 'submitting'
             )`,
            [uuidv7(), msgId, tenantA.orgId, providerId, channelId, uuidv7()],
          ),
        ).rejects.toThrow();
        await client.query('ROLLBACK TO SAVEPOINT sp_mismatch');

        // Inserting with matching claim_token succeeds
        const attemptId = uuidv7();
        await client.query(
          `INSERT INTO message_attempts (
             id, message_id, org_id, provider_id, channel_id, attempt_number,
             fencing_epoch, claim_token, status
           ) VALUES (
             $1, $2, $3, $4, $5, 1, 1, $6, 'submitting'
           )`,
          [attemptId, msgId, tenantA.orgId, providerId, channelId, validToken],
        );

        // Inserting provider_health sample with attempt_id matching succeeds
        await client.query(
          `INSERT INTO provider_health (
             id, provider_id, attempt_id, kind, latency_ms, outcome,
             classification, health_state, circuit_state, circuit_generation,
             circuit_policy_version, source, observed_at
           ) VALUES (
             $1, $2, $3, 'submission', 45, 'accepted',
             'success', 'healthy', 'closed', 0,
             1, 'automatic', now()
           )`,
          [uuidv7(), providerId, attemptId],
        );

        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });
});
