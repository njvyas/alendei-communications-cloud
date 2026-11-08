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

describe('Phase 8A-S: Contact Audience Resolution Integration Suite', () => {
  let h: Harness;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let workspace2A: string;
  let whatsappChannelId: string;
  let smsChannelId: string;

  // Contact IDs created in tenant A default workspace
  let contactVipNewsletter: string;
  let contactVipOnly: string;
  let contactNewsletterOnly: string;
  let contactNoTags: string;
  let contactSuppressed: string;
  let contactRevokedConsent: string;
  let contactGrantedConsent: string;

  // Contact in workspace 2
  let contactWs2: string;

  // Contact in tenant B
  let contactTenantB: string;

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
      key: `audience_${keySuffix}_${tenant.slug.replace(/-/g, '_')}`,
      name: `Audience ${keySuffix} ${tenant.slug}`,
      description: 'Audience test role',
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
    tenantA = await createTenant(h.admin, 'aud-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'aud-tenant-b', credentials);

    // Create a second workspace in Tenant A
    const [ws2] = await h.admin
      .insert(schema.workspaces)
      .values({
        orgId: tenantA.orgId,
        name: 'Tenant A Secondary Workspace',
        slug: 'aud-a-secondary',
      })
      .returning({ id: schema.workspaces.id });
    workspace2A = ws2!.id;

    // Contacts roles for Tenant A and Tenant B (workspace and org scope)
    await createRole(
      tenantA,
      'contacts',
      ['organization', 'workspace'],
      [PERMISSIONS.CONTACTS_READ, PERMISSIONS.CONTACTS_MANAGE],
    );
    await createRole(
      tenantB,
      'contacts',
      ['organization', 'workspace'],
      [PERMISSIONS.CONTACTS_READ, PERMISSIONS.CONTACTS_MANAGE],
    );

    // Suppressions roles for Tenant A and Tenant B (org scope only)
    await createRole(
      tenantA,
      'suppressions',
      ['organization'],
      [PERMISSIONS.SUPPRESSIONS_READ, PERMISSIONS.SUPPRESSIONS_MANAGE],
    );
    await createRole(
      tenantB,
      'suppressions',
      ['organization'],
      [PERMISSIONS.SUPPRESSIONS_READ, PERMISSIONS.SUPPRESSIONS_MANAGE],
    );

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

    // Seed contacts for Tenant A in default workspace
    // 1. VIP + Newsletter contact (has active WhatsApp and SMS identities)
    const c1 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'Alice',
        lastName: 'BothTags',
        metadata: { tags: ['VIP', 'Newsletter'] },
      });
    contactVipNewsletter = c1.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactVipNewsletter}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110001', isPrimary: true });
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactVipNewsletter}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: smsChannelId, rawAddress: '+15551110001' });

    // 2. VIP only contact (has active WhatsApp identity)
    const c2 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'Bob',
        lastName: 'VipOnly',
        metadata: { tag_list: ['VIP'] },
      });
    contactVipOnly = c2.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactVipOnly}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110002', isPrimary: true });

    // 3. Newsletter only contact (has active WhatsApp identity)
    const c3 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'Charlie',
        lastName: 'NewsletterOnly',
        metadata: { tags: ['newsletter'] },
      });
    contactNewsletterOnly = c3.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactNewsletterOnly}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110003', isPrimary: true });

    // 4. Contact with no tags (has active WhatsApp identity)
    const c4 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'David',
        lastName: 'NoTags',
        metadata: {},
      });
    contactNoTags = c4.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactNoTags}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110004', isPrimary: true });

    // 5. Contact with suppressed address (+15551110005)
    const c5 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'Eve',
        lastName: 'Suppressed',
        metadata: { tags: ['VIP'] },
      });
    contactSuppressed = c5.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactSuppressed}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110005', isPrimary: true });
    // Add active suppression for Eve's address on whatsapp in tenant A
    await h.admin.insert(schema.suppressions).values({
      id: uuidv7(),
      orgId: tenantA.orgId,
      channelId: whatsappChannelId,
      rawAddress: '+15551110005',
      normalizedAddress: '+15551110005',
      reason: 'User unsubscribe complaint',
      status: 'active',
    });

    // 6. Contact who explicitly REVOKED consent on WhatsApp
    const c6 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'Frank',
        lastName: 'Revoked',
        metadata: { tags: ['VIP'] },
      });
    contactRevokedConsent = c6.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactRevokedConsent}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110006', isPrimary: true });
    await request(h.app.getHttpServer())
      .post(
        url(`/workspaces/${tenantA.workspaceId}/contacts/${contactRevokedConsent}/consent-events`),
      )
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        channelId: whatsappChannelId,
        consentType: 'marketing',
        event: 'revoke',
        occurredAt: new Date().toISOString(),
        source: 'sms_stop_keyword',
      });

    // 7. Contact who explicitly GRANTED consent on WhatsApp
    const c7 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'Grace',
        lastName: 'Granted',
        metadata: { tags: ['VIP'] },
      });
    contactGrantedConsent = c7.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantA.workspaceId}/contacts/${contactGrantedConsent}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110007', isPrimary: true });
    await request(h.app.getHttpServer())
      .post(
        url(`/workspaces/${tenantA.workspaceId}/contacts/${contactGrantedConsent}/consent-events`),
      )
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        channelId: whatsappChannelId,
        consentType: 'marketing',
        event: 'grant',
        occurredAt: new Date().toISOString(),
        source: 'web_form',
      });

    // Contact in Tenant A secondary workspace (ws2)
    const cWs2 = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${workspace2A}/contacts`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        firstName: 'Heidi',
        lastName: 'WorkspaceTwo',
        metadata: { tags: ['VIP'] },
      });
    contactWs2 = cWs2.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${workspace2A}/contacts/${contactWs2}/identities`))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15551110008', isPrimary: true });

    // Contact in Tenant B
    const cTenantB = await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantB.workspaceId}/contacts`))
      .set('authorization', `Bearer ${tokenB}`)
      .send({
        firstName: 'Ivan',
        lastName: 'TenantB',
        metadata: { tags: ['VIP'] },
      });
    contactTenantB = cTenantB.body.data.id;
    await request(h.app.getHttpServer())
      .post(url(`/workspaces/${tenantB.workspaceId}/contacts/${contactTenantB}/identities`))
      .set('authorization', `Bearer ${tokenB}`)
      .send({ channelId: whatsappChannelId, rawAddress: '+15552220001', isPrimary: true });
  }, 60_000);

  afterAll(async () => {
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
    await h.close();
  }, 60_000);

  describe('1. Scope & Isolation', () => {
    it('resolves all contacts in a specific workspace via POST', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);

      expect(res.body.totalCount).toBe(7);
      expect(res.body.data).toHaveLength(7);
      const contactIds = res.body.data.map((m: { contactId: string }) => m.contactId);
      expect(contactIds).toContain(contactVipNewsletter);
      expect(contactIds).toContain(contactVipOnly);
      expect(contactIds).toContain(contactNewsletterOnly);
      expect(contactIds).toContain(contactNoTags);
      expect(contactIds).not.toContain(contactWs2); // ws2 is isolated
      expect(contactIds).not.toContain(contactTenantB); // tenant B is isolated
    });

    it('resolves all contacts in a workspace via GET with query params', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.totalCount).toBe(7);
      expect(res.body.data).toHaveLength(7);
    });

    it('resolves contacts across all workspaces at organization scope when workspaceId is omitted', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/contacts/audience/resolve'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);

      // Default workspace (7) + Secondary workspace (1) = 8
      expect(res.body.totalCount).toBe(8);
      expect(res.body.data).toHaveLength(8);
      const contactIds = res.body.data.map((m: { contactId: string }) => m.contactId);
      expect(contactIds).toContain(contactWs2);
      expect(contactIds).not.toContain(contactTenantB);
    });

    it('fails closed (404) when attempting to resolve audience in another tenant workspace', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantB.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(404);

      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('fails closed (400) when organization context is missing', async () => {
      // Direct call without Bearer token or credentials
      const res = await request(h.app.getHttpServer())
        .post(url('/contacts/audience/resolve'))
        .send({})
        .expect(401);

      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_CREDENTIAL_REQUIRED);
    });
  });

  describe('2. Tag Segmentation (Any vs All, Case-Insensitive)', () => {
    it('resolves contacts matching a single tag case-insensitively', async () => {
      // Query "vip" in lowercase; database has "VIP"
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['vip'] })
        .expect(200);

      // Alice (VIP), Bob (VIP via tag_list), Eve (VIP), Frank (VIP), Grace (VIP) = 5
      expect(res.body.totalCount).toBe(5);
      const contactIds = res.body.data.map((m: { contactId: string }) => m.contactId);
      expect(contactIds).toContain(contactVipNewsletter);
      expect(contactIds).toContain(contactVipOnly);
      expect(contactIds).toContain(contactSuppressed);
      expect(contactIds).toContain(contactRevokedConsent);
      expect(contactIds).toContain(contactGrantedConsent);
      expect(contactIds).not.toContain(contactNewsletterOnly);
      expect(contactIds).not.toContain(contactNoTags);
    });

    it('resolves contacts matching ANY of multiple tags (tagMatchMode: any)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['VIP', 'Newsletter'], tagMatchMode: 'any' })
        .expect(200);

      // 5 VIPs + 1 Newsletter-only (Charlie) = 6 contacts (David has no tags)
      expect(res.body.totalCount).toBe(6);
      const contactIds = res.body.data.map((m: { contactId: string }) => m.contactId);
      expect(contactIds).toContain(contactNewsletterOnly);
      expect(contactIds).not.toContain(contactNoTags);
    });

    it('resolves contacts matching ALL of multiple tags (tagMatchMode: all)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['VIP', 'Newsletter'], tagMatchMode: 'all' })
        .expect(200);

      // Only Alice has BOTH VIP and Newsletter tags
      expect(res.body.totalCount).toBe(1);
      expect(res.body.data[0].contactId).toBe(contactVipNewsletter);
      expect(res.body.data[0].firstName).toBe('Alice');
      expect(res.body.data[0].tags).toEqual(expect.arrayContaining(['VIP', 'Newsletter']));
    });

    it('returns empty audience with totalCount: 0 when no contacts match tags', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['NonExistentTag'] })
        .expect(200);

      expect(res.body.totalCount).toBe(0);
      expect(res.body.data).toEqual([]);
      expect(res.body.page.hasMore).toBe(false);
      expect(res.body.page.nextCursor).toBeNull();
    });
  });

  describe('3. Deterministic Keyset Pagination & Accurate Counts', () => {
    it('paginates deterministically with limit and cursor without duplicates', async () => {
      const limit = 2;
      const pages: { contactId: string }[][] = [];
      let cursor: string | null = null;
      let totalCountObserved: number | null = null;

      do {
        const queryParams = new URLSearchParams();
        queryParams.set('limit', String(limit));
        if (cursor) queryParams.set('cursor', cursor);

        const res = await request(h.app.getHttpServer())
          .get(
            url(
              `/workspaces/${tenantA.workspaceId}/contacts/audience/resolve?${queryParams.toString()}`,
            ),
          )
          .set('authorization', `Bearer ${tokenA}`)
          .expect(200);

        if (totalCountObserved === null) {
          totalCountObserved = res.body.totalCount;
        } else {
          expect(res.body.totalCount).toBe(totalCountObserved);
        }

        pages.push(res.body.data);
        cursor = res.body.page.nextCursor;
      } while (cursor !== null);

      expect(totalCountObserved).toBe(7);
      // 7 contacts at limit 2 -> 4 pages (2, 2, 2, 1)
      expect(pages).toHaveLength(4);

      const allCollectedIds = pages.flatMap((p) => p.map((m) => m.contactId));
      expect(allCollectedIds).toHaveLength(7);
      // Zero duplicates
      expect(new Set(allCollectedIds).size).toBe(7);
    });

    it('never fabricates counts: totalCount matches exact count of matching records', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ limit: 1 })
        .expect(200);

      // Page limit is 1, but totalCount is the exact un-truncated audience count (7)
      expect(res.body.data).toHaveLength(1);
      expect(res.body.totalCount).toBe(7);
      expect(res.body.page.hasMore).toBe(true);
      expect(res.body.page.nextCursor).toBeTruthy();
    });
  });

  describe('4. Deduplication & Member Hydration', () => {
    it('prevents duplicate contacts even when contact has multiple identities', async () => {
      // Alice has both WhatsApp and SMS identities
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ tags: ['VIP', 'Newsletter'], tagMatchMode: 'all' })
        .expect(200);

      expect(res.body.totalCount).toBe(1);
      expect(res.body.data).toHaveLength(1);
      const alice = res.body.data[0];
      expect(alice.contactId).toBe(contactVipNewsletter);
      // Both identities are hydrated under identities array
      expect(alice.identities).toHaveLength(2);
      const channelCodes = alice.identities.map((id: { channelCode: string }) => id.channelCode);
      expect(channelCodes).toContain('whatsapp');
      expect(channelCodes).toContain('sms');
    });
  });

  describe('5. Channel Eligibility, Suppression & Consent Rules', () => {
    it('filters out contacts who have no active identity for the specified channel', async () => {
      // SMS channel: only Alice has an SMS identity in Tenant A workspace
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ channel: 'sms' })
        .expect(200);

      expect(res.body.totalCount).toBe(1);
      expect(res.body.data[0].contactId).toBe(contactVipNewsletter);
    });

    it('filters out contacts whose active identity is suppressed on the channel', async () => {
      // Query WhatsApp channel. Eve is suppressed on WhatsApp (+15551110005)
      // Frank revoked consent on WhatsApp
      // Out of 7 contacts:
      // - Alice: eligible
      // - Bob: eligible
      // - Charlie: eligible
      // - David: eligible
      // - Eve: suppressed -> EXCLUDED
      // - Frank: consent revoked -> EXCLUDED
      // - Grace: consent granted -> eligible
      // Eligible count = 5
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ channel: 'whatsapp' })
        .expect(200);

      expect(res.body.totalCount).toBe(5);
      const contactIds = res.body.data.map((m: { contactId: string }) => m.contactId);
      expect(contactIds).not.toContain(contactSuppressed);
      expect(contactIds).not.toContain(contactRevokedConsent);
      expect(contactIds).toContain(contactGrantedConsent);
    });

    it('strictly requires explicit grant when requireOptIn is true', async () => {
      // When requireOptIn: true, unconsented contacts (Alice, Bob, Charlie, David) are excluded
      // Eve is suppressed (excluded)
      // Frank is revoked (excluded)
      // Only Grace has an explicit grant event
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/audience/resolve`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ channel: 'whatsapp', requireOptIn: true })
        .expect(200);

      expect(res.body.totalCount).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].contactId).toBe(contactGrantedConsent);
      expect(res.body.data[0].consentState).toBe('opted_in');
    });
  });

  describe('6. Phase 8B Campaign Preview Endpoint Contract', () => {
    it('POST /workspaces/:workspaceId/audience/preview conforms to resolution response contract', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/audience/preview`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          tags: ['VIP'],
          channel: 'whatsapp',
        })
        .expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('totalCount');
      expect(res.body).toHaveProperty('page');
      expect(typeof res.body.totalCount).toBe('number');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.page).toMatchObject({
        hasMore: false,
        limit: 25,
      });

      // VIPs on WhatsApp minus Eve (suppressed) minus Frank (revoked) = Alice, Bob, Grace = 3
      expect(res.body.totalCount).toBe(3);
    });
  });
});
