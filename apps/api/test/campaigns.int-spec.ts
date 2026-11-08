import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { CredentialService } from '../src/iam/credential.service';

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 8B.1: Campaigns Foundation Integration Suite', () => {
  let h: Harness;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let workspace2A: string;
  let whatsappChannelId: string;
  let smsChannelId: string;
  let templateWaA: string;
  let templateSmsA: string;
  let templateWaB: string;

  const createRole = async (
    tenant: TenantFixture,
    keySuffix: string,
    scopeTypes: ('organization' | 'workspace')[],
    permissions: string[],
  ) => {
    const roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `cmp_${keySuffix}_${tenant.slug.replace(/-/g, '_')}`,
      name: `Campaigns ${keySuffix} ${tenant.slug}`,
      description: 'Campaigns test role',
      isSystemRole: false,
      allowedScopeTypes: scopeTypes,
    });

    for (const permKey of permissions) {
      const [perm] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, permKey));
      if (perm) {
        await h.admin.insert(schema.rolePermissions).values({
          roleId,
          permissionId: perm.id,
        });
      }
    }

    await h.admin.insert(schema.userRoles).values({
      orgId: tenant.orgId,
      userId: tenant.userId,
      roleId,
      scopeType: 'organization',
      scopeId: tenant.orgId,
    });
  };

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    tenantA = await createTenant(h.admin, 'cmp-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'cmp-tenant-b', credentials);

    await createRole(
      tenantA,
      'campaigns',
      ['organization', 'workspace'],
      [PERMISSIONS.CAMPAIGNS_READ, PERMISSIONS.CAMPAIGNS_MANAGE],
    );
    await createRole(
      tenantB,
      'campaigns',
      ['organization', 'workspace'],
      [PERMISSIONS.CAMPAIGNS_READ, PERMISSIONS.CAMPAIGNS_MANAGE],
    );

    // Create a second workspace in Tenant A
    const [ws2] = await h.admin
      .insert(schema.workspaces)
      .values({
        orgId: tenantA.orgId,
        name: 'Tenant A Secondary Workspace',
        slug: 'cmp-a-secondary',
      })
      .returning({ id: schema.workspaces.id });
    workspace2A = ws2!.id;

    // Resolve channels
    const [waCh] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    whatsappChannelId = waCh!.id;

    const [smsCh] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'sms'));
    smsChannelId = smsCh!.id;

    // Login tokens
    const loginA = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantA.email, password: PASSWORD });
    tokenA = loginA.body.data.accessToken;

    const loginB = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantB.email, password: PASSWORD });
    tokenB = loginB.body.data.accessToken;

    // Seed templates for Tenant A
    const [tplWa] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: whatsappChannelId,
        name: 'Promo WhatsApp Template',
        body: 'Hello {{name}}, enjoy 20% off!',
        variables: ['name'],
        approvalStatus: 'approved',
      })
      .returning({ id: schema.templates.id });
    templateWaA = tplWa!.id;

    const [tplSms] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: smsChannelId,
        name: 'Alert SMS Template',
        body: 'Your code is {{code}}',
        variables: ['code'],
        approvalStatus: 'approved',
      })
      .returning({ id: schema.templates.id });
    templateSmsA = tplSms!.id;

    // Seed template for Tenant B
    const [tplWaB] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantB.orgId,
        channelId: whatsappChannelId,
        name: 'Tenant B Template',
        body: 'Welcome to Tenant B!',
        variables: [],
        approvalStatus: 'approved',
      })
      .returning({ id: schema.templates.id });
    templateWaB = tplWaB!.id;
  });

  afterAll(async () => {
    if (h) {
      if (tenantA) {
        await h.admin.execute(sql`DELETE FROM campaigns WHERE org_id = ${tenantA.orgId}`);
        await destroyTenant(h.admin, tenantA);
      }
      if (tenantB) {
        await h.admin.execute(sql`DELETE FROM campaigns WHERE org_id = ${tenantB.orgId}`);
        await destroyTenant(h.admin, tenantB);
      }
      await h.close();
    }
  });

  describe('Campaign Lifecycle (CRUD)', () => {
    let createdCampaignId: string;

    it('creates a draft campaign with immediate scheduleMode', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Spring Flash Sale',
          description: 'Flash sale for loyal customers',
          channel: 'whatsapp',
          templateId: templateWaA,
          templateVariables: { name: 'Customer' },
          recipientSource: {
            type: 'all_contacts',
            contactCount: 100,
          },
          scheduleMode: 'immediate',
          throttling: {
            rateLimitPerSecond: 50,
            maxAttemptsPerRecipient: 2,
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      createdCampaignId = res.body.data.id;
      expect(res.body.data.name).toBe('Spring Flash Sale');
      expect(res.body.data.channel).toBe('whatsapp');
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.scheduleMode).toBe('immediate');
      expect(res.body.data.templateId).toBe(templateWaA);
      expect(res.body.data.templateName).toBe('Promo WhatsApp Template');
      expect(res.body.data.throttling.rateLimitPerSecond).toBe(50);
      expect(res.body.data.throttling.maxAttemptsPerRecipient).toBe(2);
      expect(
        (res.body.data.recipientSource as Record<string, unknown>).contactCount,
      ).toBeUndefined();
      expect(res.body.data.recipientSource.type).toBe('all_contacts');
      expect(res.body.data.metrics.totalRecipients).toBeNull();
      expect(res.body.data.isSimulatedPreview).toBe(false);

      // Verify contactCount was stripped and NOT stored in the database
      const [dbRow] = await h.admin
        .select({
          recipientSource: schema.campaigns.recipientSource,
          metrics: schema.campaigns.metrics,
        })
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, createdCampaignId));
      const dbRecipientSource = dbRow.recipientSource as Record<string, unknown>;
      expect(dbRecipientSource.contactCount).toBeUndefined();
      expect(dbRecipientSource.type).toBe('all_contacts');
      expect((dbRow.metrics as { totalRecipients: number | null }).totalRecipients).toBeNull();
    });

    it('retrieves the created campaign by id', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/campaigns/${createdCampaignId}`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdCampaignId);
      expect(res.body.data.name).toBe('Spring Flash Sale');
      expect(res.body.data.templateName).toBe('Promo WhatsApp Template');
      expect(res.body.data.channel).toBe('whatsapp');
      expect(
        (res.body.data.recipientSource as Record<string, unknown>).contactCount,
      ).toBeUndefined();
      expect(res.body.data.recipientSource.type).toBe('all_contacts');
      expect(res.body.data.metrics.totalRecipients).toBeNull();
    });

    it('updates draft campaign parameters and strips supplied contactCount on update', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/workspaces/${tenantA.workspaceId}/campaigns/${createdCampaignId}`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Updated Flash Sale',
          description: 'Updated sale description',
          recipientSource: {
            type: 'tag_segment',
            tags: ['vip'],
            tagMatchMode: 'any',
            contactCount: 250,
          },
          throttling: {
            rateLimitPerSecond: 30,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated Flash Sale');
      expect(res.body.data.description).toBe('Updated sale description');
      expect(res.body.data.throttling.rateLimitPerSecond).toBe(30);
      expect(res.body.data.throttling.maxAttemptsPerRecipient).toBe(2);
      expect(
        (res.body.data.recipientSource as Record<string, unknown>).contactCount,
      ).toBeUndefined();
      expect(res.body.data.recipientSource.type).toBe('tag_segment');
      expect(res.body.data.recipientSource.tags).toEqual(['vip']);
      expect(res.body.data.recipientSource.tagMatchMode).toBe('any');
      expect(res.body.data.metrics.totalRecipients).toBeNull();

      // Verify database update stripped contactCount
      const [updatedDbRow] = await h.admin
        .select({
          recipientSource: schema.campaigns.recipientSource,
          metrics: schema.campaigns.metrics,
        })
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, createdCampaignId));
      const updatedDbRecipientSource = updatedDbRow.recipientSource as Record<string, unknown>;
      expect(updatedDbRecipientSource.contactCount).toBeUndefined();
      expect(updatedDbRecipientSource.tags).toEqual(['vip']);
      expect(
        (updatedDbRow.metrics as { totalRecipients: number | null }).totalRecipients,
      ).toBeNull();
    });

    it('strips caller-supplied contactCount while preserving legitimate criteria and keeping metrics.totalRecipients null', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Audience Integrity Test Campaign',
          channel: 'sms',
          templateId: templateSmsA,
          recipientSource: {
            type: 'tag_segment',
            tags: ['priority_customers', 'tier1'],
            tagMatchMode: 'all',
            requireOptIn: true,
            segmentName: 'Tier 1 Priority',
            contactCount: 50000,
          },
        });

      expect(res.status).toBe(201);
      const data = res.body.data;
      expect((data.recipientSource as Record<string, unknown>).contactCount).toBeUndefined();
      expect(data.recipientSource.type).toBe('tag_segment');
      expect(data.recipientSource.tags).toEqual(['priority_customers', 'tier1']);
      expect(data.recipientSource.tagMatchMode).toBe('all');
      expect(data.recipientSource.requireOptIn).toBe(true);
      expect(data.recipientSource.segmentName).toBe('Tier 1 Priority');
      expect(data.metrics.totalRecipients).toBeNull();

      // Assert directly against persistent storage
      const [row] = await h.admin
        .select({
          recipientSource: schema.campaigns.recipientSource,
          metrics: schema.campaigns.metrics,
        })
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, data.id));
      const storedSource = row.recipientSource as Record<string, unknown>;
      expect(storedSource.contactCount).toBeUndefined();
      expect(storedSource.type).toBe('tag_segment');
      expect(storedSource.tags).toEqual(['priority_customers', 'tier1']);
      expect(storedSource.tagMatchMode).toBe('all');
      expect(storedSource.requireOptIn).toBe(true);
      expect(storedSource.segmentName).toBe('Tier 1 Priority');
      expect((row.metrics as { totalRecipients: number | null }).totalRecipients).toBeNull();
    });

    it('lists campaigns with workspace isolation and query filtering', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .query({ query: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.some((c: { id: string }) => c.id === createdCampaignId)).toBe(true);
      expect(res.body.page).toBeDefined();
    });

    it('soft-deletes a draft campaign', async () => {
      const delRes = await request(h.app.getHttpServer())
        .delete(url(`/workspaces/${tenantA.workspaceId}/campaigns/${createdCampaignId}`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      // Verify subsequent GET returns 404
      const getRes = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/campaigns/${createdCampaignId}`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(getRes.status).toBe(404);
    });
  });

  describe('Scheduling & Validation Rules', () => {
    it('creates a scheduled campaign with a valid future timestamp', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString(); // 1 day in the future

      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Scheduled SMS Blast',
          channel: 'sms',
          templateId: templateSmsA,
          recipientSource: {
            type: 'tag_segment',
            tag: 'VIP',
            contactCount: 42,
          },
          scheduleMode: 'scheduled',
          scheduledAt: futureDate,
        });

      if (res.status !== 201) {
        console.error('Campaign creation failed:', JSON.stringify(res.body, null, 2));
      }
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('scheduled');
      expect(res.body.data.scheduleMode).toBe('scheduled');
      expect(res.body.data.scheduledAt).toBe(futureDate);
      expect(
        (res.body.data.recipientSource as Record<string, unknown>).contactCount,
      ).toBeUndefined();
      expect(res.body.data.recipientSource.type).toBe('tag_segment');
      expect(res.body.data.recipientSource.tag).toBe('VIP');
      expect(res.body.data.metrics.totalRecipients).toBeNull();
    });

    it('refuses scheduled campaign without scheduledAt', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Invalid Scheduled Campaign',
          channel: 'sms',
          templateId: templateSmsA,
          recipientSource: {
            type: 'all_contacts',
          },
          scheduleMode: 'scheduled',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('refuses scheduled campaign with past timestamp', async () => {
      const pastDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago

      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Past Scheduled Campaign',
          channel: 'sms',
          templateId: templateSmsA,
          recipientSource: {
            type: 'all_contacts',
          },
          scheduleMode: 'scheduled',
          scheduledAt: pastDate,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('refuses creation when template channel does not match campaign channel', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Mismatched Channel Campaign',
          channel: 'sms', // Campaign requests SMS
          templateId: templateWaA, // Template is WhatsApp
          recipientSource: {
            type: 'all_contacts',
          },
          scheduleMode: 'immediate',
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('refuses creation when template belongs to another tenant', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Foreign Template Campaign',
          channel: 'whatsapp',
          templateId: templateWaB, // Tenant B template
          recipientSource: {
            type: 'all_contacts',
          },
          scheduleMode: 'immediate',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('Tenant & Workspace Isolation', () => {
    let campaignAId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Tenant A Isolation Test Campaign',
          channel: 'whatsapp',
          templateId: templateWaA,
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      campaignAId = res.body.data.id;
    });

    it('Tenant B cannot read Tenant A campaign', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignAId}`))
        .set('authorization', `Bearer ${tokenB}`);

      // Tenant B has no access to Tenant A's workspace -> 404
      expect(res.status).toBe(404);
    });

    it('Tenant B cannot update Tenant A campaign', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignAId}`))
        .set('authorization', `Bearer ${tokenB}`)
        .send({ name: 'Malicious Rename' });

      expect(res.status).toBe(404);
    });

    it('Tenant B cannot delete Tenant A campaign', async () => {
      const res = await request(h.app.getHttpServer())
        .delete(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignAId}`))
        .set('authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
    });

    it('Cannot access campaign via a different workspace in the same organization', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${workspace2A}/campaigns/${campaignAId}`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
    });

    it('Fails closed when unauthenticated', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/workspaces/${tenantA.workspaceId}/campaigns`),
      );

      expect(res.status).toBe(401);
    });
  });

  describe('Idempotency & Fingerprint Integrity', () => {
    const basePayload = () => ({
      name: `Idem Campaign ${uuidv7().slice(0, 8)}`,
      description: 'Idempotency test description',
      channel: 'whatsapp' as const,
      templateId: templateWaA,
      templateVariables: { promo: 'SPRING20' },
      recipientSource: {
        type: 'tag_segment' as const,
        tags: ['vip', 'newsletter'],
        tagMatchMode: 'all' as const,
        contactCount: 150,
      },
      scheduleMode: 'immediate' as const,
      throttling: {
        rateLimitPerSecond: 40,
        maxAttemptsPerRecipient: 2,
      },
    });

    it('same key + same request returns original result (replay)', async () => {
      const key = `idem-same-${uuidv7()}`;
      const payload = basePayload();

      const first = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);

      const second = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.name).toBe(payload.name);
      expect(second.body.data.metrics.totalRecipients).toBeNull();
      expect(
        (second.body.data.recipientSource as Record<string, unknown>).contactCount,
      ).toBeUndefined();
      expect(second.body.data.recipientSource.type).toBe('tag_segment');
      expect(second.body.data.recipientSource.tags).toEqual(['vip', 'newsletter']);
    });

    it('same key + changed name is refused with 422', async () => {
      const key = `idem-diff-name-${uuidv7()}`;
      const payload = basePayload();

      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);

      const changed = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send({ ...payload, name: 'Changed Name' });

      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('same key + changed recipientSource is refused with 422', async () => {
      const key = `idem-diff-source-${uuidv7()}`;
      const payload = basePayload();

      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);

      const changed = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send({
          ...payload,
          recipientSource: { type: 'all_contacts' },
        });

      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('same key + changed throttling is refused with 422', async () => {
      const key = `idem-diff-throttle-${uuidv7()}`;
      const payload = basePayload();

      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);

      const changed = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send({
          ...payload,
          throttling: { rateLimitPerSecond: 99, maxAttemptsPerRecipient: 3 },
        });

      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('same key + changed templateVariables is refused with 422', async () => {
      const key = `idem-diff-vars-${uuidv7()}`;
      const payload = basePayload();

      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send(payload)
        .expect(201);

      const changed = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', key)
        .send({
          ...payload,
          templateVariables: { promo: 'AUTUMN50' },
        });

      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('concurrent requests with the same idempotency key and identical payload both succeed with the same campaign id', async () => {
      const key = `idem-concurrent-${uuidv7()}`;
      const payload = basePayload();

      const [res1, res2] = await Promise.all([
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
          .set('authorization', `Bearer ${tokenA}`)
          .set('idempotency-key', key)
          .send(payload),
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
          .set('authorization', `Bearer ${tokenA}`)
          .set('idempotency-key', key)
          .send(payload),
      ]);

      expect([res1.status, res2.status]).toEqual([201, 201]);
      expect(res1.body.data.id).toBe(res2.body.data.id);
      expect(res1.body.data.name).toBe(payload.name);

      // Verify in database that exactly one campaign and one idempotency record exist
      const rows = await h.admin
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, res1.body.data.id));
      expect(rows).toHaveLength(1);

      const idemRows = await h.admin
        .select()
        .from(schema.idempotencyKeys)
        .where(eq(schema.idempotencyKeys.idempotencyKey, key));
      expect(idemRows).toHaveLength(1);
      expect(idemRows[0]!.status).toBe('completed');
      expect(idemRows[0]!.responseStatusCode).toBe(201);
    });
  });

  describe('Dispatch Endpoint Enforces Blocker Invariant', () => {
    let testCampaignId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Campaign to Dispatch',
          channel: 'whatsapp',
          templateId: templateWaA,
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      testCampaignId = res.body.data.id;
    });

    it('refuses dispatch with explicit blocker notice (400 / CAMPAIGN_DISPATCH_DISABLED)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${testCampaignId}/dispatch`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.CAMPAIGN_DISPATCH_DISABLED);
      expect(res.body.error.message).toContain(
        'Campaign dispatch remains disabled pending Phase 8B.2 and Phase 7 billing acceptance',
      );
    });

    it('returns 404 for dispatch on non-existent campaign', async () => {
      const missingId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${missingId}/dispatch`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
    });
  });
});
