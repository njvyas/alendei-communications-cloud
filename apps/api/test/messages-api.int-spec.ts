import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { OpenApiValidator } from './openapi-validator';

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
      if (h?.admin) {
        await h.admin.delete(schema.messageDispatchQueue).catch(() => {});
        const orgIds = [tenantA?.orgId, tenantB?.orgId].filter(Boolean);
        if (orgIds.length > 0) {
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
        if (providerId) {
          await h.admin
            .delete(schema.providers)
            .where(eq(schema.providers.id, providerId))
            .catch(() => {});
        }
        if (createdRoleIds.length > 0) {
          await h.admin
            .delete(schema.userRoles)
            .where(inArray(schema.userRoles.roleId, createdRoleIds))
            .catch(() => {});
          await h.admin
            .delete(schema.rolePermissions)
            .where(inArray(schema.rolePermissions.roleId, createdRoleIds))
            .catch(() => {});
          await h.admin
            .delete(schema.roles)
            .where(inArray(schema.roles.id, createdRoleIds))
            .catch(() => {});
        }
        if (tenantA) await destroyTenant(h.admin, tenantA);
        if (tenantB) await destroyTenant(h.admin, tenantB);
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

    it('9. Concurrent first sends to one new recipient all succeed and share one contact identity', async () => {
      // Each request reads "no identity yet" and creates one; the partial unique
      // index lets exactly one win. The others must reuse it, not fail with 500.
      const recipient = `+1202556${randomBytes(2).readUInt16BE(0).toString().padStart(4, '0')}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request(h.app.getHttpServer())
            .post(url('/messages'))
            .set('Authorization', `Bearer ${userAToken}`)
            .set('X-Acc-Organization', tenantA.orgId)
            .set('Idempotency-Key', randomUUID())
            .send({ channelCode: 'whatsapp', recipient, payload: { text: `first send ${i}` } }),
        ),
      );

      expect(results.map((r) => r.status)).toEqual(results.map(() => 202));
      const ids = results.map((r) => r.body.data.id as string);
      const rows = await h.admin
        .select({ contactId: schema.messages.contactId })
        .from(schema.messages)
        .where(inArray(schema.messages.id, ids));
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((r) => r.contactId)).size).toBe(1);
      const identities = await h.admin
        .select({ contactId: schema.contactIdentities.contactId })
        .from(schema.contactIdentities)
        .where(eq(schema.contactIdentities.contactId, rows[0]!.contactId));
      expect(identities).toHaveLength(1);
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
  describe('GET /messages (list)', () => {
    let tenantC: TenantFixture;
    let tokenC: string;
    let noReadToken: string;
    let otherWorkspaceId: string;
    let templateId: string;
    let smsChannelId: string;
    /** Seeded in creation order; the list is newest first. */
    const seeded: string[] = [];
    const base = Date.parse('2026-10-01T00:00:00.000Z');

    beforeAll(async () => {
      tenantC = await createTenant(h.admin, 'msg-list', credentials);
      const perms = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, PERMISSIONS.MESSAGES_READ));
      const roleId = uuidv7();
      createdRoleIds.push(roleId);
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: tenantC.orgId,
        key: `msg_list_${randomBytes(4).toString('hex')}`,
        name: 'Messages Reader',
        description: 'messages.read only',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });
      for (const p of perms) {
        await h.admin
          .insert(schema.rolePermissions)
          .values({ roleId, permissionId: p.id, orgId: tenantC.orgId });
      }
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.insert(schema.userRoles).values({
          userId: tenantC.userId,
          roleId,
          scopeType: 'organization',
          scopeId: tenantC.orgId,
        });
      });

      const [sms] = await h.admin
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.code, 'sms'));
      smsChannelId = sms!.id;
      const [ws] = await h.admin
        .insert(schema.workspaces)
        .values({
          orgId: tenantC.orgId,
          name: 'Second',
          slug: `second-${randomBytes(3).toString('hex')}`,
        })
        .returning({ id: schema.workspaces.id });
      otherWorkspaceId = ws!.id;
      const [tpl] = await h.admin
        .insert(schema.templates)
        .values({ orgId: tenantC.orgId, channelId, name: 'list_tpl', body: 'Hello' })
        .returning({ id: schema.templates.id });
      templateId = tpl!.id;

      // Five messages, one day apart: varied status, channel, workspace, template.
      const plan = [
        { status: 'accepted', channel: channelId, workspace: tenantC.workspaceId, template: null },
        {
          status: 'failed',
          channel: channelId,
          workspace: tenantC.workspaceId,
          template: templateId,
        },
        { status: 'queued', channel: smsChannelId, workspace: tenantC.workspaceId, template: null },
        { status: 'failed', channel: channelId, workspace: otherWorkspaceId, template: null },
        {
          status: 'outcome_unknown',
          channel: channelId,
          workspace: tenantC.workspaceId,
          template: null,
        },
      ] as const;
      for (const [i, m] of plan.entries()) {
        const contactId = uuidv7();
        await h.admin.insert(schema.contacts).values({
          id: contactId,
          orgId: tenantC.orgId,
          workspaceId: m.workspace,
          displayName: `List ${i}`,
        });
        const id = uuidv7();
        await h.admin.insert(schema.messages).values({
          id,
          orgId: tenantC.orgId,
          workspaceId: m.workspace,
          contactId,
          channelId: m.channel,
          templateId: m.template,
          status: m.status,
          payload: { text: `secret body ${i}` },
          recipientAddress: `+120255577${10 + i}`,
          failureReason: m.status === 'failed' ? 'NO_ELIGIBLE_PROVIDER' : null,
          correlationId: uuidv7(),
          createdAt: new Date(base + i * 86_400_000),
        });
        seeded.push(id);
      }

      await h.clearRateLimits();
      tokenC = (
        await request(h.app.getHttpServer())
          .post(url('/auth/login'))
          .send({ email: tenantC.email, password: PASSWORD })
          .expect(200)
      ).body.data.accessToken;
      const reader = await createScopedUser(
        h.admin,
        tenantC,
        credentials,
        'organization',
        tenantC.orgId,
        'msg-noread',
      );
      await h.clearRateLimits();
      noReadToken = (
        await request(h.app.getHttpServer())
          .post(url('/auth/login'))
          .send({ email: reader.email, password: PASSWORD })
          .expect(200)
      ).body.data.accessToken;
    }, 60_000);

    afterAll(async () => {
      await h.admin.delete(schema.messages).where(eq(schema.messages.orgId, tenantC.orgId));
      await h.admin.delete(schema.contacts).where(eq(schema.contacts.orgId, tenantC.orgId));
      await destroyTenant(h.admin, tenantC);
    });

    const list = (query = '', token = tokenC) =>
      request(h.app.getHttpServer())
        .get(url(`/messages${query ? `?${query}` : ''}`))
        .set('Authorization', `Bearer ${token}`);
    const ids = (res: request.Response) => res.body.data.map((m: { id: string }) => m.id);

    it('1. lists the organization’s messages newest first, metadata only (no payload)', async () => {
      const res = await list().expect(200);
      expect(ids(res)).toEqual([...seeded].reverse());
      expect(res.body.page).toMatchObject({ hasMore: false, nextCursor: null });
      const first = res.body.data[0];
      expect(Object.keys(first).sort()).toEqual(
        [
          'attemptCount',
          'channelCode',
          'channelId',
          'completedAt',
          'contactId',
          'createdAt',
          'failureReason',
          'id',
          'orgId',
          'recipientAddress',
          'status',
          'templateId',
          'workspaceId',
        ].sort(),
      );
      expect(first).toMatchObject({
        orgId: tenantC.orgId,
        channelCode: 'whatsapp',
        attemptCount: 0,
      });
      expect(JSON.stringify(res.body)).not.toContain('secret body');
    });

    it('2. pages with a cursor, without gaps or repeats', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await list(
          `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ).expect(200);
        expect(res.body.data.length).toBeLessThanOrEqual(2);
        seen.push(...ids(res));
        cursor = res.body.page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([...seeded].reverse());

      const asc = await list('sort=createdAt').expect(200);
      expect(ids(asc)).toEqual(seeded);
    });

    it('3. filters by status, channel, workspace, template and creation window', async () => {
      expect(ids(await list('status=failed').expect(200))).toEqual([seeded[3], seeded[1]]);
      expect(ids(await list('channelCode=sms').expect(200))).toEqual([seeded[2]]);
      expect(ids(await list('channelCode=email').expect(200))).toEqual([]);
      expect(ids(await list(`workspaceId=${otherWorkspaceId}`).expect(200))).toEqual([seeded[3]]);
      expect(ids(await list(`templateId=${templateId}`).expect(200))).toEqual([seeded[1]]);
      const from = new Date(base + 86_400_000).toISOString();
      const to = new Date(base + 3 * 86_400_000).toISOString();
      expect(
        ids(
          await list(
            `createdFrom=${encodeURIComponent(from)}&createdTo=${encodeURIComponent(to)}`,
          ).expect(200),
        ),
      ).toEqual([seeded[2], seeded[1]]);
      expect(ids(await list('status=failed&channelCode=whatsapp').expect(200))).toEqual([
        seeded[3],
        seeded[1],
      ]);
    });

    it('4. refuses invalid filters and unknown fields with 400', async () => {
      for (const query of [
        'status=delivered',
        'channelCode=fax',
        'workspaceId=not-a-uuid',
        'providerId=1',
        'createdFrom=yesterday',
        'sort=status',
        'limit=0',
        'recipient=%2B12025557710',
        `orgId=${tenantA.orgId}`,
      ]) {
        const res = await list(query);
        expect([query, res.status]).toEqual([query, 400]);
      }
    });

    it('5. requires messages.read (403 without it, 401 without a credential)', async () => {
      const res = await list('', noReadToken);
      expect(res.status).toBe(403);
      await request(h.app.getHttpServer()).get(url('/messages')).expect(401);
    });

    it('6. never shows another organization’s messages, whatever the filters or header', async () => {
      const resA = await request(h.app.getHttpServer())
        .get(url(`/messages?workspaceId=${tenantC.workspaceId}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .expect(200);
      expect(ids(resA)).toEqual([]);
      const all = await request(h.app.getHttpServer())
        .get(url('/messages?limit=100'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId)
        .expect(200);
      for (const m of all.body.data) expect(m.orgId).toBe(tenantA.orgId);
      expect(ids(all)).not.toEqual(expect.arrayContaining([seeded[0]]));

      const forged = await request(h.app.getHttpServer())
        .get(url('/messages'))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantC.orgId);
      expect(forged.status).toBe(403);
    });

    it('7. responses conform to the OpenAPI document', async () => {
      const validator = new OpenApiValidator(
        JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.v1.json'), 'utf8')),
      );
      const problems: string[] = [];
      for (const query of ['', 'limit=2', 'status=failed', 'status=delivered']) {
        const path = `/messages${query ? `?${query}` : ''}`;
        problems.push(...validator.check('GET', url(path), await list(query)));
      }
      problems.push(...validator.check('GET', url('/messages'), await list('', noReadToken)));
      expect(problems).toEqual([]);
    });

    it('8. enforces permanent recipient masking on both list and detail endpoints (F2)', async () => {
      // 1. List endpoint: every row has permanently masked recipientAddress
      const res = await list().expect(200);
      for (const item of res.body.data) {
        expect(item.recipientAddress).toMatch(/^\+[0-9]+ •••• [0-9]{4}$/);
      }
      const rawDump = JSON.stringify(res.body);
      for (let i = 0; i < 4; i++) {
        expect(rawDump).not.toContain(`+120255577${10 + i}`);
      }

      // 2. Detail endpoint: GET /messages/:id permanently masks recipientAddress
      const detailRes = await request(h.app.getHttpServer())
        .get(url(`/messages/${seeded[0]}`))
        .set('Authorization', `Bearer ${tokenC}`)
        .expect(200);
      expect(detailRes.body.data.recipientAddress).toBe('+1 •••• 7710');
      expect(JSON.stringify(detailRes.body)).not.toContain('+12025557710');

      // 3. Tenant-scoped access: tenant A cannot view tenant C message
      const crossTenantRes = await request(h.app.getHttpServer())
        .get(url(`/messages/${seeded[0]}`))
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Acc-Organization', tenantA.orgId);
      expect(crossTenantRes.status).toBe(404);
    });
  });
});
