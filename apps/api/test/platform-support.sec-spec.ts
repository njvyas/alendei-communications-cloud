/**
 * Platform operational support and troubleshooting (U13.4, `SECURITY.md`, ADR-015).
 *
 * 1. Read-only access by default: PLATFORM_SUPPORT_READ permission.
 * 2. Strict negative authorization: unauthenticated callers get 401, tenant admins get 403.
 * 3. Probing non-existent organizations fails closed with 403 (no existence oracle).
 * 4. Authorized platform support operators can inspect overview, routing, dispatch, and cross-tenant audit.
 * 5. Privacy (U13.4 review F-1, F-2, F-4): dispatch diagnostics carry no recipient, message
 *    content or provider failure text — only fixed failure codes; audit search returns no IP
 *    address, user agent or actor email.
 * 6. Auditability: every diagnostic read is synchronously recorded in audit_logs, in the same
 *    transaction — a read whose record cannot be written fails (500) and returns nothing.
 * 7. Phase 5.0 (migration 0049): the dispatch `deliveryStatus` filter narrows within the same
 *    boundary, returns the same shape (no delivery field, no provider message reference), is
 *    validated, recorded in the audit row and refused to tenant principals.
 */
import { ERROR_CODES, PLATFORM_ROLE_KEYS, PLATFORM_SUPPORT_FAILURE_CODES } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AuditWriter } from '../src/audit/audit-writer.service';
import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url, type Org, type Person } from './revocation-fixtures';

describe('Platform Support & Operations (U13.4 Security & RLS Spec)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let org: Org;
  let supportUser: Person;
  let supportToken: string;
  let tenantAdmin: Person;
  let tenantAdminToken: string;
  let smsId: string;
  let providerId: string;
  let messageId: string;
  const PLANTED_RECIPIENT = '+919800000077';
  const PLANTED_BODY = 'PLANTED-SEC-BODY-5512';
  const PLANTED_CREDENTIAL = 'sk_live_SECPLANT';

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('platform-support');
    org = await w.org('support-target');

    // Create a user with alendei_support platform role
    supportUser = await w.person('support-operator');
    const [supportRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT));
    await w.grant(supportUser.userId, supportRole!.id, 'platform', null);
    supportToken = await w.login(supportUser.email);

    // Synthetic dispatch data in the target organization: a failed message whose
    // stored reason and attempt text echo the recipient, the body and a credential.
    const [sms] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'sms'));
    smsId = sms!.id;
    providerId = uuidv7();
    await h.admin.execute(
      sql`INSERT INTO providers (id, channel_id, name, adapter_key, status)
          VALUES (${providerId}, ${smsId}, ${`u134-sec-${providerId.slice(-8)}`}, 'simulator', 'active')`,
    );
    await h.admin.execute(
      sql`INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority)
          VALUES (${org.orgId}, ${providerId}, ${smsId}, 1)`,
    );
    const contactId = uuidv7();
    await h.admin.execute(
      sql`INSERT INTO contacts (id, org_id, workspace_id) VALUES (${contactId}, ${org.orgId}, ${org.workspaceId})`,
    );
    messageId = uuidv7();
    await h.admin.execute(
      sql`INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, payload,
                                recipient_address, failure_reason, correlation_id)
          VALUES (${messageId}, ${org.orgId}, ${org.workspaceId}, ${contactId}, ${smsId}, 'failed',
                  ${JSON.stringify({ text: PLANTED_BODY })}::jsonb, ${PLANTED_RECIPIENT},
                  ${`INVALID_REQUEST: provider echoed ${PLANTED_RECIPIENT} body="${PLANTED_BODY}"`},
                  ${uuidv7()})`,
    );
    await h.admin.execute(
      sql`INSERT INTO message_attempts (message_id, org_id, provider_id, channel_id, attempt_number,
                                        fencing_epoch, claim_token, status, failure_reason, latency_ms)
          VALUES (${messageId}, ${org.orgId}, ${providerId}, ${smsId}, 1, 1, ${uuidv7()}, 'failed',
                  ${`AUTH_ERROR: credential ${PLANTED_CREDENTIAL} rejected`}, 95)`,
    );
    // An audit row in the organization carrying an IP address and user agent.
    await h.admin.execute(
      sql`INSERT INTO audit_logs (correlation_id, actor_type, actor_user_id, action, resource_type, resource_id,
                                  scope_type, scope_id, outcome, metadata, ip, user_agent)
          VALUES (${uuidv7()}, 'user', ${supportUser.userId}, 'u134.sec.probe', 'Organization', ${org.orgId},
                  'organization', ${org.orgId}, 'success', ${JSON.stringify({ ip: '198.51.100.9', note: 'kept' })}::jsonb,
                  '198.51.100.9', 'u134-sec-agent')`,
    );

    // Create a tenant admin user
    const adminPerson = await w.admin(org, 'tenant-admin');
    tenantAdmin = adminPerson;
    tenantAdminToken = await w.login(tenantAdmin.email);
  }, 120_000);

  afterAll(async () => {
    if (org) {
      await h.admin.execute(sql`DELETE FROM message_attempts WHERE org_id = ${org.orgId}`);
      await h.admin.execute(sql`DELETE FROM messages WHERE org_id = ${org.orgId}`);
      await h.admin.execute(sql`DELETE FROM contacts WHERE org_id = ${org.orgId}`);
      await h.admin.execute(
        sql`DELETE FROM organization_provider_assignments WHERE org_id = ${org.orgId}`,
      );
    }
    if (providerId) await h.admin.execute(sql`DELETE FROM providers WHERE id = ${providerId}`);
    await w.teardown();
    await h.close();
  }, 120_000);

  afterEach(async () => {
    await purgeAudit(h.admin, sql`action = 'platform.support.diagnostic_read'`);
  });

  describe('Negative authorization — unauthenticated (401)', () => {
    it('rejects overview request without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/platform/support/organizations/${org.orgId}/overview`),
      );
      expect(res.status).toBe(401);
    });

    it('rejects routing diagnostics request without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/platform/support/organizations/${org.orgId}/routing`),
      );
      expect(res.status).toBe(401);
    });

    it('rejects dispatch diagnostics request without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/platform/support/organizations/${org.orgId}/dispatch`),
      );
      expect(res.status).toBe(401);
    });

    it('rejects cross-tenant audit search without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(url('/platform/support/audit'));
      expect(res.status).toBe(401);
    });
  });

  describe('Negative authorization — tenant principals (403)', () => {
    it('refuses tenant administrator on overview with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/overview`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator on routing diagnostics with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/routing`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator on dispatch diagnostics with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/dispatch`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator on cross-tenant audit search with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url('/platform/support/audit'))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator probing non-existent organization with 403 (fails closed before disclosure)', async () => {
      const randomOrgId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${randomOrgId}/overview`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Dispatch delivery-status filter (Phase 5.0, migration 0049)', () => {
    let deliveredId: string;
    const PROVIDER_REF = `u134-sec-ref-${uuidv7().slice(-12)}`;
    const dispatch = (query: string, token: string | null = supportToken) => {
      const r = request(h.app.getHttpServer()).get(
        url(`/platform/support/organizations/${org.orgId}/dispatch${query}`),
      );
      return token ? r.set('authorization', `Bearer ${token}`) : r;
    };

    beforeAll(async () => {
      // An accepted message delivered on its attempt; removed by the suite's afterAll.
      const contactId = uuidv7();
      await h.admin.execute(
        sql`INSERT INTO contacts (id, org_id, workspace_id) VALUES (${contactId}, ${org.orgId}, ${org.workspaceId})`,
      );
      deliveredId = uuidv7();
      await h.admin.execute(
        sql`INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, payload,
                                  recipient_address, correlation_id, delivery_status, delivered_at)
            VALUES (${deliveredId}, ${org.orgId}, ${org.workspaceId}, ${contactId}, ${smsId}, 'accepted',
                    ${JSON.stringify({ text: PLANTED_BODY })}::jsonb, ${PLANTED_RECIPIENT}, ${uuidv7()},
                    'delivered', now())`,
      );
      await h.admin.execute(
        sql`INSERT INTO message_attempts (message_id, org_id, provider_id, channel_id, attempt_number,
                                          fencing_epoch, claim_token, status, latency_ms,
                                          provider_message_id, delivery_status, delivered_at)
            VALUES (${deliveredId}, ${org.orgId}, ${providerId}, ${smsId}, 1, 1, ${uuidv7()}, 'accepted', 30,
                    ${PROVIDER_REF}, 'delivered', now())`,
      );
    });

    it('returns only messages with that delivery status, in the unchanged shape', async () => {
      const res = await dispatch('?deliveryStatus=delivered').expect(200);
      const ids = res.body.data.recentMessages.map((m: { messageId: string }) => m.messageId);
      expect(ids).toEqual([deliveredId]);
      const [m] = res.body.data.recentMessages;
      expect(Object.keys(m).sort()).toEqual(
        [
          'attemptCount',
          'attempts',
          'channel',
          'completedAt',
          'createdAt',
          'failureCode',
          'messageId',
          'status',
          'updatedAt',
        ].sort(),
      );
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(PROVIDER_REF);
      expect(raw).not.toContain(PLANTED_BODY);
      expect(raw).not.toContain(PLANTED_RECIPIENT.slice(3));
      expect(raw).not.toMatch(/delivery|providerMessage|recipient|payload/i);
      for (const other of ['pending', 'undelivered', 'not_supported']) {
        const r = await dispatch(`?deliveryStatus=${other}`).expect(200);
        expect([other, r.body.data.recentMessages]).toEqual([other, []]);
      }
    });

    it('omitted: the default troubleshooting view is unchanged (the accepted message is not listed)', async () => {
      const res = await dispatch('').expect(200);
      const ids = res.body.data.recentMessages.map((m: { messageId: string }) => m.messageId);
      expect(ids).toContain(messageId);
      expect(ids).not.toContain(deliveredId);
    });

    it('composes with status; an untracked failed message never matches', async () => {
      const failed = await dispatch('?deliveryStatus=delivered&status=failed').expect(200);
      expect(failed.body.data.recentMessages).toEqual([]);
      const accepted = await dispatch('?deliveryStatus=delivered&status=accepted').expect(200);
      expect(
        accepted.body.data.recentMessages.map((m: { messageId: string }) => m.messageId),
      ).toEqual([deliveredId]);
    });

    it('refuses values outside MESSAGE_DELIVERY_STATUSES with 400', async () => {
      for (const value of [
        'read',
        'not_tracked',
        'expired',
        'DELIVERED',
        '',
        'delivered,pending',
      ]) {
        const res = await dispatch(`?deliveryStatus=${encodeURIComponent(value)}`);
        expect([value, res.status]).toEqual([value, 400]);
      }
    });

    it('tenant administrator 403, no token 401 — with the filter', async () => {
      expect((await dispatch('?deliveryStatus=delivered', tenantAdminToken)).status).toBe(403);
      expect((await dispatch('?deliveryStatus=delivered', null)).status).toBe(401);
    });

    it('the diagnostic read is audited with the filter', async () => {
      await dispatch('?deliveryStatus=delivered&limit=7').expect(200);
      const [row] = await h.admin
        .select()
        .from(schema.auditLogs)
        .where(sql`action = 'platform.support.diagnostic_read' AND metadata->>'tool' = 'dispatch'`);
      expect(row?.actorUserId).toBe(supportUser.userId);
      expect(row?.metadata).toEqual({
        tool: 'dispatch',
        channel: null,
        status: null,
        deliveryStatus: 'delivered',
        limit: 7,
      });
    });
  });

  describe('Platform Support Authorized Operations (200)', () => {
    it('returns 404 for authorized support user when organization does not exist', async () => {
      const nonExistentOrgId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${nonExistentOrgId}/overview`))
        .set('authorization', `Bearer ${supportToken}`);
      if (res.status !== 404) console.error('Non-existent org error:', res.status, res.body);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('allows support operator to inspect organization overview', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/overview`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.organization.id).toBe(org.orgId);
      expect(res.body.data.workspaces).toBeDefined();
      expect(res.body.data.metrics).toBeDefined();

      // Check synchronous audit record was written
      const auditRows = await h.admin
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'platform.support.diagnostic_read'));
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const audit = auditRows.find((r) => r.resourceId === org.orgId);
      expect(audit).toBeDefined();
      expect(audit?.actorUserId).toBe(supportUser.userId);
      expect(audit?.outcome).toBe('success');
    });

    it('allows support operator to inspect routing without exposing provider credentials', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/routing`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.channels).toBeDefined();
      expect(res.body.data.assignments).toBeDefined();
      expect(res.body.data.providerHealth).toBeDefined();

      const rawJson = JSON.stringify(res.body);
      expect(rawJson).not.toContain('secret');
      expect(rawJson).not.toContain('apiKey');
      expect(rawJson).not.toContain('credentials');
      expect(rawJson).not.toContain('password');
      expect(rawJson).not.toContain('token');
    });

    it('dispatch diagnostics return metadata and fixed codes only — no recipient, content or provider text', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/dispatch`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      for (const planted of [
        PLANTED_RECIPIENT,
        PLANTED_RECIPIENT.slice(3),
        PLANTED_BODY,
        PLANTED_CREDENTIAL,
        'provider echoed',
      ]) {
        expect(raw).not.toContain(planted);
      }
      expect(raw).not.toMatch(/recipient|failureReason|payload/i);
      expect(res.body.data.queue).toEqual({ pendingCount: 0, delayedCount: 0, claimedCount: 0 });
      const message = res.body.data.recentMessages.find(
        (m: { messageId: string }) => m.messageId === messageId,
      );
      expect(message).toEqual({
        messageId,
        channel: 'sms',
        status: 'failed',
        failureCode: 'INVALID_REQUEST',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        completedAt: null,
        attemptCount: 1,
        attempts: [
          {
            attemptNumber: 1,
            providerId,
            adapterKey: 'simulator',
            status: 'failed',
            failureCode: 'AUTH_ERROR',
            latencyMs: 95,
            attemptedAt: expect.any(String),
          },
        ],
      });
      expect(PLATFORM_SUPPORT_FAILURE_CODES).toContain(message.failureCode);
    });

    it('cross-tenant audit search returns no IP address, user agent or actor email', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/audit?limit=10&action=u134.sec.probe`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.page.limit).toBe(10);
      expect(res.body.data).toHaveLength(1);
      const item = res.body.data[0];
      expect(item).not.toHaveProperty('ip');
      expect(item).not.toHaveProperty('userAgent');
      expect(item).not.toHaveProperty('actorEmail');
      expect(item.metadata).toEqual({ note: 'kept' });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('198.51.100.9');
      expect(raw).not.toContain('u134-sec-agent');
      expect(raw).not.toContain(supportUser.email);
    });

    it('the search is recorded with its filters, and without the opaque cursor', async () => {
      const since = '2026-01-01T00:00:00.000Z';
      const res = await request(h.app.getHttpServer())
        .get(
          url(
            `/platform/support/audit?orgId=${org.orgId}&action=u134.sec.probe&actorUserId=${supportUser.userId}&since=${since}&limit=5`,
          ),
        )
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      const [row] = await h.admin
        .select()
        .from(schema.auditLogs)
        .where(
          sql`action = 'platform.support.diagnostic_read' AND metadata->>'tool' = 'audit_search'`,
        );
      expect(row?.actorUserId).toBe(supportUser.userId);
      expect(row?.metadata).toEqual({
        tool: 'audit_search',
        orgId: org.orgId,
        action: 'u134.sec.probe',
        actorUserId: supportUser.userId,
        since,
        until: null,
        limit: 5,
        page: 'first',
      });
    });

    it('an action filter outside the audit-action vocabulary is refused (400)', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/audit?action=${encodeURIComponent("x' OR 1=1 --")}`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(400);
    });

    it('a diagnostic read whose audit record cannot be written fails (500) and returns no data', async () => {
      const writer = h.app.get(AuditWriter);
      const real = writer.record.bind(writer);
      const spy = jest
        .spyOn(writer, 'record')
        .mockImplementation((input, tx) =>
          input.action === 'platform.support.diagnostic_read'
            ? Promise.reject(new Error('audit unavailable'))
            : real(input, tx),
        );
      try {
        for (const path of [
          `/platform/support/organizations/${org.orgId}/overview`,
          `/platform/support/organizations/${org.orgId}/routing`,
          `/platform/support/organizations/${org.orgId}/dispatch`,
          '/platform/support/audit?limit=5',
        ]) {
          const res = await request(h.app.getHttpServer())
            .get(url(path))
            .set('authorization', `Bearer ${supportToken}`);
          expect({ path, status: res.status }).toEqual({ path, status: 500 });
          expect(res.body.error?.code).toBe(ERROR_CODES.INTERNAL_ERROR);
          expect(res.body.data).toBeUndefined();
          expect(JSON.stringify(res.body)).not.toContain(messageId);
        }
      } finally {
        spy.mockRestore();
      }
      const rows = await h.admin
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'platform.support.diagnostic_read'));
      expect(rows).toEqual([]);
    });
  });
});
