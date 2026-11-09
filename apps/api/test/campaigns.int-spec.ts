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
  let templateNoVarsWaA: string;
  let templatePendingWaA: string;

  let contact1Id: string;
  let contact2Id: string;
  let contact3Id: string;
  let contactSuppressedId: string;
  let contactRevokedId: string;
  let contactOptInId: string;
  let contactWs2Id: string;
  let contactTenantBId: string;

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
      [
        PERMISSIONS.CAMPAIGNS_READ,
        PERMISSIONS.CAMPAIGNS_MANAGE,
        PERMISSIONS.CONTACTS_READ,
        PERMISSIONS.CONTACTS_MANAGE,
      ],
    );
    await createRole(
      tenantA,
      'suppressions',
      ['organization'],
      [PERMISSIONS.SUPPRESSIONS_READ, PERMISSIONS.SUPPRESSIONS_MANAGE],
    );

    await createRole(
      tenantB,
      'campaigns',
      ['organization', 'workspace'],
      [
        PERMISSIONS.CAMPAIGNS_READ,
        PERMISSIONS.CAMPAIGNS_MANAGE,
        PERMISSIONS.CONTACTS_READ,
        PERMISSIONS.CONTACTS_MANAGE,
      ],
    );
    await createRole(
      tenantB,
      'suppressions',
      ['organization'],
      [PERMISSIONS.SUPPRESSIONS_READ, PERMISSIONS.SUPPRESSIONS_MANAGE],
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

    const [tplNoVars] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: whatsappChannelId,
        name: 'No Vars Wa Template',
        body: 'Hello everyone!',
        variables: [],
        approvalStatus: 'approved',
      })
      .returning({ id: schema.templates.id });
    templateNoVarsWaA = tplNoVars!.id;

    const [tplPending] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenantA.orgId,
        channelId: whatsappChannelId,
        name: 'Pending Wa Template',
        body: 'Hello {{name}}',
        variables: ['name'],
        approvalStatus: 'pending',
      })
      .returning({ id: schema.templates.id });
    templatePendingWaA = tplPending!.id;

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

    // Seed contacts for Tenant A in primary workspace
    // Contact 1: VIP + Promo
    const c1 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Alice', metadata: { tags: ['vip', 'promo'] } });
    contact1Id = c1.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contact1Id}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110001', isPrimary: true });

    // Contact 2: VIP only
    const c2 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Bob', metadata: { tags: ['vip'] } });
    contact2Id = c2.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contact2Id}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110002', isPrimary: true });

    // Contact 3: Newsletter only
    const c3 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Charlie', metadata: { tags: ['newsletter'] } });
    contact3Id = c3.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contact3Id}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110003', isPrimary: true });

    // Contact 4: VIP + Suppressed
    const c4 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Dave', metadata: { tags: ['vip'] } });
    contactSuppressedId = c4.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactSuppressedId}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110004', isPrimary: true });
    await h.admin.insert(schema.suppressions).values({
      id: uuidv7(),
      orgId: tenantA.orgId,
      channelId: whatsappChannelId,
      rawAddress: '+15551110004',
      normalizedAddress: '+15551110004',
      reason: 'complaint',
      status: 'active',
    });

    // Contact 5: VIP + Revoked Consent
    const c5 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Eve', metadata: { tags: ['vip'] } });
    contactRevokedId = c5.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactRevokedId}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110005', isPrimary: true });
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactRevokedId}/consent-events`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        channelId: whatsappChannelId,
        consentType: 'marketing',
        event: 'revoke',
        occurredAt: new Date().toISOString(),
        source: 'sms_stop_keyword',
      });

    // Contact 6: VIP + Granted Consent (Opt-in)
    const c6 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Frank', metadata: { tags: ['vip'] } });
    contactOptInId = c6.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactOptInId}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110006', isPrimary: true });
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactOptInId}/consent-events`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        channelId: whatsappChannelId,
        consentType: 'marketing',
        event: 'grant',
        occurredAt: new Date().toISOString(),
        source: 'web_opt_in',
      });

    // Contact 7 in Tenant A secondary workspace
    const c7 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${workspace2A}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Grace', metadata: { tags: ['vip'] } });
    contactWs2Id = c7.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${workspace2A}/contacts/${contactWs2Id}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110007', isPrimary: true });

    // Contact 8 in Tenant B workspace
    const c8 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantB.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenB}`)
      .send({ firstName: 'Heidi', metadata: { tags: ['vip'] } });
    contactTenantBId = c8.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantB.workspaceId}/contacts/${contactTenantBId}/identities`))
      .set('authorization', `Bearer ${tokenB}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110008', isPrimary: true });
  });

  afterAll(async () => {
    if (h) {
      if (tenantA && tenantB) {
        await h.admin.execute(
          sql`DELETE FROM campaign_recipients WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`,
        );
        await h.admin.execute(
          sql`DELETE FROM campaigns WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`,
        );
        await h.admin.execute(
          sql`ALTER TABLE consent_events DISABLE TRIGGER trg_consent_events_immutable`,
        );
        await h.admin.execute(
          sql`DELETE FROM consent_events WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`,
        );
        await h.admin.execute(
          sql`ALTER TABLE consent_events ENABLE TRIGGER trg_consent_events_immutable`,
        );
        await h.admin.execute(
          sql`DELETE FROM contact_identities WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`,
        );
        await h.admin.execute(
          sql`DELETE FROM contacts WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`,
        );
        await h.admin.execute(
          sql`DELETE FROM suppressions WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`,
        );
        await destroyTenant(h.admin, tenantA);
        await destroyTenant(h.admin, tenantB);
      }
      await h.close();
    }
  }, 60_000);

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

  describe('Phase 8B.2: Audience Preview & Authoritative Counts', () => {
    let previewCampaignId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Preview Target Campaign',
          channel: 'whatsapp',
          templateId: templateWaA,
          templateVariables: { name: 'Preview User' },
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      previewCampaignId = res.body.data.id;
    });

    it('returns exact totalCount for all_contacts excluding suppressed and revoked contacts', async () => {
      const res = await request(h.app.getHttpServer())
        .post(
          url(`/workspaces/${tenantA.workspaceId}/campaigns/${previewCampaignId}/audience-preview`),
        )
        .set('authorization', `Bearer ${tokenA}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(4); // Alice, Bob, Charlie, Frank. Dave (suppressed) & Eve (revoked) excluded
      expect(res.body.data).toHaveLength(4);
      const contactIds = res.body.data.map((m: { contactId: string }) => m.contactId);
      expect(contactIds).toContain(contact1Id);
      expect(contactIds).toContain(contact2Id);
      expect(contactIds).toContain(contact3Id);
      expect(contactIds).toContain(contactOptInId);
      expect(contactIds).not.toContain(contactSuppressedId);
      expect(contactIds).not.toContain(contactRevokedId);
      expect(contactIds).not.toContain(contactWs2Id);
      expect(contactIds).not.toContain(contactTenantBId);
    });

    it('returns filtered preview when tags criteria is overridden in request', async () => {
      const res = await request(h.app.getHttpServer())
        .post(
          url(`/workspaces/${tenantA.workspaceId}/campaigns/${previewCampaignId}/audience-preview`),
        )
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['vip'] });

      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(3); // Alice, Bob, Frank (VIP only, unsuppressed, non-revoked)
      const contactIds = res.body.data.map((m: { contactId: string }) => m.contactId);
      expect(contactIds).toContain(contact1Id);
      expect(contactIds).toContain(contact2Id);
      expect(contactIds).toContain(contactOptInId);
      expect(contactIds).not.toContain(contact3Id); // Charlie is newsletter only
    });

    it('supports tagMatchMode all to require all specified tags', async () => {
      const res = await request(h.app.getHttpServer())
        .post(
          url(`/workspaces/${tenantA.workspaceId}/campaigns/${previewCampaignId}/audience-preview`),
        )
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['vip', 'promo'], tagMatchMode: 'all' });

      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(1); // Alice only has both vip and promo
      expect(res.body.data[0].contactId).toBe(contact1Id);
    });

    it('respects requireOptIn to return only explicitly granted contacts', async () => {
      const res = await request(h.app.getHttpServer())
        .post(
          url(`/workspaces/${tenantA.workspaceId}/campaigns/${previewCampaignId}/audience-preview`),
        )
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['vip'], requireOptIn: true });

      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(1); // Frank only has explicit grant
      expect(res.body.data[0].contactId).toBe(contactOptInId);
    });

    it('returns 404 on preview for non-existent campaign', async () => {
      const missingId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${missingId}/audience-preview`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({});

      expect(res.status).toBe(404);
    });
  });

  describe('Phase 8B.2: Audience Materialisation & Database Deduplication', () => {
    let matCampaignId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Materialize Test Campaign',
          channel: 'whatsapp',
          templateId: templateWaA,
          templateVariables: { name: 'VIP Customer' },
          recipientSource: { type: 'tag_segment', tag: 'vip' },
          scheduleMode: 'immediate',
        });
      matCampaignId = res.body.data.id;
    });

    it('eagerly materializes matching audience into campaign_recipients and updates metrics', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${matCampaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.campaignId).toBe(matCampaignId);
      expect(res.body.data.totalRecipients).toBe(3);
      expect(res.body.data.materialized).toBe(3);

      // Verify campaign table updated
      const [campaign] = await h.admin
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, matCampaignId));
      expect((campaign!.metrics as { totalRecipients: number }).totalRecipients).toBe(3);

      // Verify campaign_recipients rows
      const recipients = await h.admin
        .select()
        .from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.campaignId, matCampaignId));
      expect(recipients).toHaveLength(3);
      recipients.forEach((r) => {
        expect(r.status).toBe('pending');
        expect(r.orgId).toBe(tenantA.orgId);
        expect(r.workspaceId).toBe(tenantA.workspaceId);
      });
      const storedContactIds = recipients.map((r) => r.contactId);
      expect(storedContactIds).toContain(contact1Id);
      expect(storedContactIds).toContain(contact2Id);
      expect(storedContactIds).toContain(contactOptInId);
    });

    it('enforces database deduplication on repeated materialization (ON CONFLICT DO NOTHING)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${matCampaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalRecipients).toBe(3);
      expect(res.body.data.materialized).toBe(0); // 0 new rows inserted

      // Verify no duplicate rows exist in database
      const recipients = await h.admin
        .select()
        .from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.campaignId, matCampaignId));
      expect(recipients).toHaveLength(3);
    });

    it('prevents materialisation from adding recipients after a campaign has transitioned to scheduled', async () => {
      const tag1 = `freeze_${uuidv7().slice(0, 8)}`;
      for (let i = 1; i <= 2; i++) {
        const c = await request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ firstName: `FreezeUser${i}`, metadata: { tags: [tag1] } });
        await request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${c.body.data.id}/identities`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ channelId: whatsappChannelId, rawAddress: `+1555777000${i}`, isPrimary: true });
      }

      // 1. Create a campaign with tag1
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Freeze Snapshot Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'tag_segment', tag: tag1 },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      // 2. Materialize audience in draft
      const matRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(matRes.status).toBe(200);
      expect(matRes.body.data.totalRecipients).toBe(2);
      expect(matRes.body.data.materialized).toBe(2);

      // 3. Schedule the campaign
      const validFuture = new Date(Date.now() + 3600_000).toISOString();
      const schedRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });
      expect(schedRes.status).toBe(200);
      expect(schedRes.body.data.status).toBe('scheduled');
      expect(schedRes.body.data.metrics.totalRecipients).toBe(2);

      // 4. Add a brand new contact with tag1 and active WhatsApp identity into Tenant A workspace
      const newContactRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Latecomer', metadata: { tags: [tag1] } });
      const lateContactId = newContactRes.body.data.id;
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${lateContactId}/identities`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ channelId: whatsappChannelId, rawAddress: '+15559990099', isPrimary: true });

      // 5. Attempt repeated materialisation on the scheduled campaign
      const postSchedMatRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(postSchedMatRes.status).toBe(200);
      expect(postSchedMatRes.body.data.totalRecipients).toBe(2); // strictly frozen at 2
      expect(postSchedMatRes.body.data.materialized).toBe(0); // 0 added

      // 6. Direct database verification: campaign_recipients has exactly 2 rows, latecomer is absent
      const recipients = await h.admin
        .select()
        .from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.campaignId, campaignId));
      expect(recipients).toHaveLength(2);
      expect(recipients.map((r) => r.contactId)).not.toContain(lateContactId);

      // 7. GET /recipients verification
      const listRec = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/recipients`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(listRec.body.data).toHaveLength(2);
      expect(listRec.body.data.map((r: { contactId: string }) => r.contactId)).not.toContain(
        lateContactId,
      );
    });

    it('scheduling uses the authoritative materialised snapshot and does not re-query dynamic audience', async () => {
      const tag2 = `snapshot_${uuidv7().slice(0, 8)}`;
      for (let i = 1; i <= 2; i++) {
        const c = await request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ firstName: `SnapUser${i}`, metadata: { tags: [tag2] } });
        await request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${c.body.data.id}/identities`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ channelId: whatsappChannelId, rawAddress: `+1555888000${i}`, isPrimary: true });
      }

      // 1. Create a campaign with tag2
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Authoritative Snapshot Schedule Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'tag_segment', tag: tag2 },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      // 2. Materialize audience in draft
      const matRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(matRes.status).toBe(200);
      expect(matRes.body.data.totalRecipients).toBe(2);

      // 3. Add another matching contact
      const newContact = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'PostMatPreSched', metadata: { tags: [tag2] } });
      const newContactId = newContact.body.data.id;
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${newContactId}/identities`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ channelId: whatsappChannelId, rawAddress: '+15559990088', isPrimary: true });

      // 4. Schedule campaign
      const validFuture = new Date(Date.now() + 3600_000).toISOString();
      const schedRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });
      expect(schedRes.status).toBe(200);
      expect(schedRes.body.data.metrics.totalRecipients).toBe(2); // snapshot count preserved!

      // 5. Database check: campaign_recipients count equals 2, not incremented
      const recipients = await h.admin
        .select()
        .from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.campaignId, campaignId));
      expect(recipients).toHaveLength(2);
      expect(recipients.map((r) => r.contactId)).not.toContain(newContactId);
    });
  });

  describe('Phase 8B.2: List Campaign Recipients', () => {
    let listCampaignId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Recipient Listing Campaign',
          channel: 'whatsapp',
          templateId: templateWaA,
          templateVariables: { name: 'Recipients Test' },
          recipientSource: { type: 'tag_segment', tag: 'vip' },
          scheduleMode: 'immediate',
        });
      listCampaignId = res.body.data.id;

      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${listCampaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);
    });

    it('lists materialized recipients with pagination', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/campaigns/${listCampaignId}/recipients`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
      expect(res.body.page).toBeDefined();
      expect(res.body.data[0].status).toBe('pending');
      expect(res.body.data[0].contactId).toBeDefined();
    });

    it('filters recipients by status', async () => {
      const pendingRes = await request(h.app.getHttpServer())
        .get(
          url(
            `/workspaces/${tenantA.workspaceId}/campaigns/${listCampaignId}/recipients?status=pending`,
          ),
        )
        .set('authorization', `Bearer ${tokenA}`);
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.data).toHaveLength(3);

      const sentRes = await request(h.app.getHttpServer())
        .get(
          url(
            `/workspaces/${tenantA.workspaceId}/campaigns/${listCampaignId}/recipients?status=sent`,
          ),
        )
        .set('authorization', `Bearer ${tokenA}`);
      expect(sentRes.status).toBe(200);
      expect(sentRes.body.data).toHaveLength(0);
    });
  });

  describe('Phase 8B.2: Campaign Scheduling Validation & Timing Guards', () => {
    it('refuses scheduling when scheduledAt is missing and not on campaign (400)', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'No Schedule Date Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({});

      expect(scheduleRes.status).toBe(400);
      expect(scheduleRes.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('refuses scheduling when scheduledAt is in the past (422)', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Past Schedule Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: '2020-01-01T00:00:00.000Z' });

      expect(scheduleRes.status).toBe(422);
      expect(scheduleRes.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(scheduleRes.body.error.message).toContain('at least 60 seconds from now');
    });

    it('refuses scheduling when scheduledAt is less than 60s in future (422)', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Near Schedule Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const nearFuture = new Date(Date.now() + 20_000).toISOString();
      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: nearFuture });

      expect(scheduleRes.status).toBe(422);
      expect(scheduleRes.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(scheduleRes.body.error.message).toContain('at least 60 seconds from now');
    });

    it('refuses scheduling when template channel does not match campaign channel (422)', async () => {
      // Create campaign on WhatsApp channel but reference SMS template
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'SMS Mismatch Campaign',
          channel: 'sms',
          templateId: templateSmsA,
          templateVariables: { code: '123456' },
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      // Force campaign channelId to WhatsApp in DB to simulate mismatch
      await h.admin
        .update(schema.campaigns)
        .set({ channelId: whatsappChannelId })
        .where(eq(schema.campaigns.id, campaignId));

      const validFuture = new Date(Date.now() + 3600_000).toISOString();
      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });

      expect(scheduleRes.status).toBe(422);
      expect(scheduleRes.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(scheduleRes.body.error.message).toContain('Template channel does not match');
    });

    it('refuses scheduling when template is unapproved (422)', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Unapproved Template Campaign',
          channel: 'whatsapp',
          templateId: templatePendingWaA,
          templateVariables: { name: 'Customer' },
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const validFuture = new Date(Date.now() + 3600_000).toISOString();
      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });

      expect(scheduleRes.status).toBe(422);
      expect(scheduleRes.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(scheduleRes.body.error.message).toContain('Template must be approved');
    });

    it('refuses scheduling when required template variables are missing (422)', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Missing Variables Campaign',
          channel: 'whatsapp',
          templateId: templateWaA, // requires {{name}}
          templateVariables: {}, // missing name!
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const validFuture = new Date(Date.now() + 3600_000).toISOString();
      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });

      expect(scheduleRes.status).toBe(422);
      expect(scheduleRes.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(scheduleRes.body.error.message).toContain('Missing required template variables: name');
    });

    it('refuses scheduling when audience resolves to 0 recipients (422 / CAMPAIGN_AUDIENCE_EMPTY)', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Empty Audience Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'tag_segment', tag: 'nonexistent_tag_xyz' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const validFuture = new Date(Date.now() + 3600_000).toISOString();
      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });

      expect(scheduleRes.status).toBe(422);
      expect(scheduleRes.body.error.code).toBe(ERROR_CODES.CAMPAIGN_AUDIENCE_EMPTY);
      expect(scheduleRes.body.error.message).toContain('Campaign audience is empty');
    });

    it('successfully schedules a valid campaign and materializes recipients', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Ready to Schedule Campaign',
          channel: 'whatsapp',
          templateId: templateWaA,
          templateVariables: { name: 'VIP Member' },
          recipientSource: { type: 'tag_segment', tag: 'vip' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const validFuture = new Date(Date.now() + 7200_000).toISOString();
      const scheduleRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });

      expect(scheduleRes.status).toBe(200);
      expect(scheduleRes.body.data.status).toBe('scheduled');
      expect(scheduleRes.body.data.scheduleMode).toBe('scheduled');
      expect(scheduleRes.body.data.metrics.totalRecipients).toBe(3);
      expect(scheduleRes.body.data.scheduledAt).toBeDefined();

      // Check database
      const recipients = await h.admin
        .select()
        .from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.campaignId, campaignId));
      expect(recipients).toHaveLength(3);
    });
  });

  describe('Phase 8B.2: Campaign Lifecycle Transitions & Terminal Immutability', () => {
    let lifecycleCampaignId: string;

    beforeEach(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Lifecycle Transition Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'tag_segment', tag: 'vip' },
          scheduleMode: 'immediate',
        });
      lifecycleCampaignId = res.body.data.id;
    });

    it('transitions draft -> scheduled -> cancelled', async () => {
      const validFuture = new Date(Date.now() + 3600_000).toISOString();
      const schedRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });
      expect(schedRes.status).toBe(200);
      expect(schedRes.body.data.status).toBe('scheduled');

      const cancelRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/cancel`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('cancelled');
    });

    it('enforces terminal immutability on cancelled campaigns (409)', async () => {
      // Cancel campaign
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/cancel`))
        .set('authorization', `Bearer ${tokenA}`);

      // Cannot cancel again
      const cancelAgain = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/cancel`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(cancelAgain.status).toBe(409);
      expect(cancelAgain.body.error.code).toBe(ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT);

      // Cannot schedule
      const schedCancelled = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      expect(schedCancelled.status).toBe(409);
      expect(schedCancelled.body.error.code).toBe(ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT);

      // Cannot materialize
      const matCancelled = await request(h.app.getHttpServer())
        .post(
          url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/materialize`),
        )
        .set('authorization', `Bearer ${tokenA}`);
      expect(matCancelled.status).toBe(409);

      // Cannot update
      const updateCancelled = await request(h.app.getHttpServer())
        .patch(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ name: 'Changed Name' });
      expect(updateCancelled.status).toBe(409);
    });

    it('guards pause and resume lifecycle transitions', async () => {
      // Pause on draft campaign returns 409
      const pauseDraft = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/pause`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(pauseDraft.status).toBe(409);

      // Set status to running directly in database
      await h.admin
        .update(schema.campaigns)
        .set({ status: 'running' })
        .where(eq(schema.campaigns.id, lifecycleCampaignId));

      // Pause on running campaign succeeds
      const pauseRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/pause`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.data.status).toBe('paused');

      // Pause again on paused campaign returns 409
      const pauseAgain = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/pause`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(pauseAgain.status).toBe(409);

      // Resume on paused campaign succeeds
      const resumeRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/resume`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.data.status).toBe('running');

      // Resume on running campaign returns 409
      const resumeAgain = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/resume`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(resumeAgain.status).toBe(409);

      // Cancel on running campaign succeeds
      const cancelRunning = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${lifecycleCampaignId}/cancel`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(cancelRunning.status).toBe(200);
      expect(cancelRunning.body.data.status).toBe('cancelled');
    });

    it('concurrent schedule and cancel requests execute atomically without overwriting cancellation', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Concurrent Schedule-Cancel Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'tag_segment', tag: 'vip' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      // Materialize first so schedule has a snapshot
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);

      const validFuture = new Date(Date.now() + 3600_000).toISOString();

      // Fire schedule and cancel concurrently
      const [schedRes, cancelRes] = await Promise.all([
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ scheduledAt: validFuture }),
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/cancel`))
          .set('authorization', `Bearer ${tokenA}`),
      ]);

      // Cancel is valid from draft or scheduled, so cancelRes succeeds
      expect([200, 409]).toContain(schedRes.status);
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('cancelled');

      // Regardless of which request completed first, the database status must be cancelled
      const [dbRow] = await h.admin
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId));
      expect(dbRow!.status).toBe('cancelled');

      // And once cancelled, a subsequent schedule is guaranteed to be refused with 409
      const subsequentSched = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/schedule`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ scheduledAt: validFuture });
      expect(subsequentSched.status).toBe(409);
      expect(subsequentSched.body.error.code).toBe(ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT);
    });

    it('concurrent cancel requests on the same campaign result in exactly one winner and one 409 conflict', async () => {
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Concurrent Double Cancel Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'tag_segment', tag: 'vip' },
          scheduleMode: 'immediate',
        });
      const campaignId = createRes.body.data.id;

      const [res1, res2] = await Promise.all([
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/cancel`))
          .set('authorization', `Bearer ${tokenA}`),
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/cancel`))
          .set('authorization', `Bearer ${tokenA}`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.error.code).toBe(ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT);

      const [dbRow] = await h.admin
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId));
      expect(dbRow!.status).toBe('cancelled');
    });
  });

  describe('Phase 8B.2: Recipient Identity Channel Eligibility', () => {
    it('excludes contacts who have identities on other channels but none on the campaign channel', async () => {
      const uniqueTag = `chan_eligibility_${uuidv7().slice(0, 8)}`;

      // 1. Contact with SMS identity ONLY (no WhatsApp identity)
      const cSmsOnly = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'SmsOnlyUser', metadata: { tags: [uniqueTag] } });
      const smsOnlyContactId = cSmsOnly.body.data.id;
      const smsIdentityRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${smsOnlyContactId}/identities`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ channelId: smsChannelId, rawAddress: '+15554440001', isPrimary: true });
      const smsIdentityId = smsIdentityRes.body.data.id;

      // 2. Contact with WhatsApp identity
      const cWaOnly = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'WaUser', metadata: { tags: [uniqueTag] } });
      const waContactId = cWaOnly.body.data.id;
      const waIdentityRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${waContactId}/identities`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ channelId: whatsappChannelId, rawAddress: '+15554440002', isPrimary: true });
      const waIdentityId = waIdentityRes.body.data.id;

      // 3. Create a WhatsApp campaign targeting the unique tag
      const campRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'WhatsApp Channel Eligibility Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'tag_segment', tag: uniqueTag },
          scheduleMode: 'immediate',
        });
      const campaignId = campRes.body.data.id;

      // 4. Test audience preview: must exclude the SMS-only contact
      const previewRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/audience-preview`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({});
      expect(previewRes.status).toBe(200);
      expect(previewRes.body.totalCount).toBe(1);
      expect(previewRes.body.data).toHaveLength(1);
      expect(previewRes.body.data[0].contactId).toBe(waContactId);

      // 5. Test materialization: must only materialize the WhatsApp contact
      const matRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/materialize`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(matRes.status).toBe(200);
      expect(matRes.body.data.totalRecipients).toBe(1);
      expect(matRes.body.data.materialized).toBe(1);

      // 6. Inspect database: verify identity_id matches WhatsApp identity and NOT SMS identity
      const dbRecipients = await h.admin
        .select()
        .from(schema.campaignRecipients)
        .where(eq(schema.campaignRecipients.campaignId, campaignId));
      expect(dbRecipients).toHaveLength(1);
      expect(dbRecipients[0]!.contactId).toBe(waContactId);
      expect(dbRecipients[0]!.identityId).toBe(waIdentityId);
      expect(dbRecipients[0]!.identityId).not.toBe(smsIdentityId);

      // 7. GET /recipients verification
      const listRec = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/campaigns/${campaignId}/recipients`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(listRec.body.data).toHaveLength(1);
      expect(listRec.body.data[0].contactId).toBe(waContactId);
      expect(listRec.body.data[0].identityId).toBe(waIdentityId);
    });
  });

  describe('Phase 8B.2: Cross-Tenant Isolation Across All Endpoints', () => {
    let isolateCampaignId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/campaigns`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Tenant Isolation Campaign',
          channel: 'whatsapp',
          templateId: templateNoVarsWaA,
          recipientSource: { type: 'all_contacts' },
          scheduleMode: 'immediate',
        });
      isolateCampaignId = res.body.data.id;
    });

    it('Tenant B token cannot access Tenant A campaign endpoints (returns 404)', async () => {
      const endpoints = [
        {
          method: 'post',
          path: `/workspaces/${tenantA.workspaceId}/campaigns/${isolateCampaignId}/audience-preview`,
        },
        {
          method: 'post',
          path: `/workspaces/${tenantA.workspaceId}/campaigns/${isolateCampaignId}/materialize`,
        },
        {
          method: 'post',
          path: `/workspaces/${tenantA.workspaceId}/campaigns/${isolateCampaignId}/schedule`,
        },
        {
          method: 'post',
          path: `/workspaces/${tenantA.workspaceId}/campaigns/${isolateCampaignId}/cancel`,
        },
        {
          method: 'post',
          path: `/workspaces/${tenantA.workspaceId}/campaigns/${isolateCampaignId}/pause`,
        },
        {
          method: 'post',
          path: `/workspaces/${tenantA.workspaceId}/campaigns/${isolateCampaignId}/resume`,
        },
        {
          method: 'get',
          path: `/workspaces/${tenantA.workspaceId}/campaigns/${isolateCampaignId}/recipients`,
        },
      ];

      for (const ep of endpoints) {
        const req =
          ep.method === 'post'
            ? request(h.app.getHttpServer())
                .post(url(ep.path))
                .set('authorization', `Bearer ${tokenB}`)
                .send({})
            : request(h.app.getHttpServer())
                .get(url(ep.path))
                .set('authorization', `Bearer ${tokenB}`);
        const res = await req;
        expect([403, 404]).toContain(res.status);
      }
    });

    it('Tenant A secondary workspace path cannot access primary workspace campaign (returns 404)', async () => {
      const endpoints = [
        {
          method: 'post',
          path: `/workspaces/${workspace2A}/campaigns/${isolateCampaignId}/audience-preview`,
        },
        {
          method: 'post',
          path: `/workspaces/${workspace2A}/campaigns/${isolateCampaignId}/materialize`,
        },
        {
          method: 'post',
          path: `/workspaces/${workspace2A}/campaigns/${isolateCampaignId}/schedule`,
        },
        {
          method: 'get',
          path: `/workspaces/${workspace2A}/campaigns/${isolateCampaignId}/recipients`,
        },
      ];

      for (const ep of endpoints) {
        const req =
          ep.method === 'post'
            ? request(h.app.getHttpServer())
                .post(url(ep.path))
                .set('authorization', `Bearer ${tokenA}`)
                .send({})
            : request(h.app.getHttpServer())
                .get(url(ep.path))
                .set('authorization', `Bearer ${tokenA}`);
        const res = await req;
        expect(res.status).toBe(404);
      }
    });
  });
});
