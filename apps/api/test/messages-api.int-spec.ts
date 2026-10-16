import { randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

describe('Messages API Suite (Phase 3.3)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let channelId: string;
  let providerId: string;
  let userAToken: string;
  let userBToken: string;
  const createdRoleIds: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);

    tenantA = await createTenant(h.admin, 'msg-a', credentials);
    tenantB = await createTenant(h.admin, 'msg-b', credentials);

    // Grant messages permissions via an organization-scoped role
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
      );

    for (const t of [tenantA, tenantB]) {
      const roleId = uuidv7();
      createdRoleIds.push(roleId);
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: t.orgId,
        key: `msg_role_${randomBytes(4).toString('hex')}`,
        name: 'Messages Role',
        description: 'Allows messages send and read',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });

      for (const p of perms) {
        await h.admin.insert(schema.rolePermissions).values({
          roleId,
          permissionId: p.id,
          orgId: t.orgId,
        });
      }

      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.insert(schema.userRoles).values({
          userId: t.userId,
          roleId,
          scopeType: 'organization',
          scopeId: t.orgId,
        });
      });
    }

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

    // Provider: ensure a provider is active on whatsapp
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

    // Create assignments for tenantA
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: tenantA.orgId,
      channelId,
      providerId,
      priority: 1,
      status: 'active',
    });

    // Create tokens for user in tenantA and tenantB
    await h.clearRateLimits();
    const loginA = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantA.email, password: PASSWORD })
      .expect(200);
    userAToken = loginA.body.data.accessToken;

    await h.clearRateLimits();
    const loginB = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantB.email, password: PASSWORD })
      .expect(200);
    userBToken = loginB.body.data.accessToken;
  }, 60_000);

  afterAll(async () => {
    try {
      await h.admin.delete(schema.messageDispatchQueue);
      if (createdRoleIds.length > 0) {
        await h.admin
          .delete(schema.userRoles)
          .where(inArray(schema.userRoles.roleId, createdRoleIds));
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, createdRoleIds));
        await h.admin.delete(schema.roles).where(inArray(schema.roles.id, createdRoleIds));
      }
      if (tenantA && tenantB) {
        await h.admin
          .delete(schema.messages)
          .where(inArray(schema.messages.orgId, [tenantA.orgId, tenantB.orgId]));
        await h.admin
          .delete(schema.contacts)
          .where(inArray(schema.contacts.orgId, [tenantA.orgId, tenantB.orgId]));
      }
    } catch {
      // Best-effort cleanup
    } finally {
      await h.close();
    }
  });

  describe('POST /messages (Preflight Order & Enqueue)', () => {
    it('1. Successfully queues message and returns 202 Accepted', async () => {
      const idempotencyKey = randomUUID();
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          channelCode: 'whatsapp',
          recipient: '+12025550199',
          payload: { text: 'Hello, Antigravity!' },
        });

      expect(res.status).toBe(202);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe('queued');
      expect(res.body.data.correlationId).toBeDefined();

      const messageId = res.body.data.id;

      // Verify row in messages table
      const [msgRow] = await h.admin
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId));
      expect(msgRow).toBeDefined();
      expect(msgRow?.orgId).toBe(tenantA.orgId);
      expect(msgRow?.status).toBe('queued');

      // Verify row in message_dispatch_queue
      const [queueRow] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId));
      expect(queueRow).toBeDefined();
      expect(queueRow?.orgId).toBe(tenantA.orgId);
      expect(queueRow?.dispatchEpoch).toBe(0);

      // Verify event in message_events
      const events = await h.admin
        .select()
        .from(schema.messageEvents)
        .where(eq(schema.messageEvents.messageId, messageId));
      expect(events.length).toBe(1);
      expect(events[0]?.eventType).toBe('message.queued');
    });

    it('2. Enforces idempotency: identical replay returns identical 202 without duplicate queue row', async () => {
      const idempotencyKey = randomUUID();
      const body = {
        channelCode: 'whatsapp',
        recipient: '+12025550198',
        payload: { text: 'Idempotency test' },
      };

      const res1 = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .set('Idempotency-Key', idempotencyKey)
        .send(body);

      expect(res1.status).toBe(202);

      const res2 = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .set('Idempotency-Key', idempotencyKey)
        .send(body);

      expect(res2.status).toBe(202);
      expect(res2.body.data.id).toBe(res1.body.data.id);

      // Verify only 1 queue row exists
      const queueRows = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, res1.body.data.id));
      expect(queueRows.length).toBe(1);
    });

    it('3. Enforces idempotency conflict (422) if payload differs', async () => {
      const idempotencyKey = randomUUID();

      await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          channelCode: 'whatsapp',
          recipient: '+12025550197',
          payload: { text: 'Original message' },
        });

      const resConflict = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          channelCode: 'whatsapp',
          recipient: '+12025550197',
          payload: { text: 'Different message' },
        });

      expect(resConflict.status).toBe(422);
      expect(resConflict.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('4. Preflight 1: Unknown channel returns 404', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'unknown-channel',
          recipient: '+12025550196',
          payload: { text: 'Test' },
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('5. Preflight 2: Actively suppressed recipient returns 422 RECIPIENT_SUPPRESSED', async () => {
      const suppressedRecipient = '+12025550195';

      // Insert active suppression
      await h.admin.insert(schema.suppressions).values({
        orgId: tenantA.orgId,
        channelId,
        rawAddress: suppressedRecipient,
        normalizedAddress: suppressedRecipient,
        reason: 'User opted out',
        status: 'active',
      });

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'whatsapp',
          recipient: suppressedRecipient,
          payload: { text: 'Test' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.RECIPIENT_SUPPRESSED);
    });

    it('6. Preflight 3: Revoked consent returns 422 CONSENT_REVOKED', async () => {
      const unconsentedRecipient = '+12025550194';

      // Create contact and revoke consent
      const [contact] = await h.admin
        .insert(schema.contacts)
        .values({
          orgId: tenantA.orgId,
          workspaceId: tenantA.workspaceId,
        })
        .returning();

      await h.admin.insert(schema.contactIdentities).values({
        orgId: tenantA.orgId,
        workspaceId: tenantA.workspaceId,
        contactId: contact!.id,
        channelId,
        rawAddress: unconsentedRecipient,
        normalizedAddress: unconsentedRecipient,
        status: 'active',
      });

      await h.admin.insert(schema.consentEvents).values({
        orgId: tenantA.orgId,
        workspaceId: tenantA.workspaceId,
        contactId: contact!.id,
        channelId,
        consentType: 'marketing',
        event: 'revoke',
        occurredAt: new Date(),
        source: 'user_optout',
      });

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'whatsapp',
          recipient: unconsentedRecipient,
          payload: { text: 'Test' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.CONSENT_REVOKED);
    });

    it('7. Preflight 4: Template not approved returns 422 TEMPLATE_NOT_APPROVED', async () => {
      // Create draft template
      const [tmpl] = await h.admin
        .insert(schema.templates)
        .values({
          orgId: tenantA.orgId,
          channelId,
          name: `Draft Template ${randomBytes(3).toString('hex')}`,
          body: 'Hello {{1}}',
          variables: ['name'],
          approvalStatus: 'draft',
        })
        .returning();

      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'whatsapp',
          recipient: '+12025550193',
          templateId: tmpl!.id,
          payload: { text: 'Test' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.TEMPLATE_NOT_APPROVED);
    });

    it('8. Preflight 5: No active provider assignment returns 422 NO_ACTIVE_PROVIDER_ASSIGNMENT', async () => {
      // TenantB has no provider assignment for whatsapp channel
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userBToken}`)
        .set('X-Acc-Organization', tenantB.orgId)
        .send({
          channelCode: 'whatsapp',
          recipient: '+12025550192',
          payload: { text: 'Test' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT);
    });
  });

  describe('GET /messages/:id', () => {
    let messageId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .send({
          channelCode: 'whatsapp',
          recipient: '+12025550191',
          payload: { text: 'Lookup test' },
        });
      messageId = res.body.data.id;
    });

    it('1. Authorizes message retrieval within organization', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/messages/${messageId}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(messageId);
      expect(res.body.data.orgId).toBe(tenantA.orgId);
      expect(res.body.data.status).toBe('queued');
      expect(Array.isArray(res.body.data.attempts)).toBe(true);
    });

    it('2. Denies cross-tenant retrieval with 404 (Anti-enumeration)', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/messages/${messageId}`))
        .set('Authorization', `Bearer ${userBToken}`)
        .set('X-Acc-Organization', tenantB.orgId);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });
  });
});
