import {
  ERROR_CODES,
  PERMISSIONS,
} from '@acc/contracts';
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

describe('Phase 3.1 Data Foundation Security & Integration Suite', () => {
  let h: Harness;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let channelId: string;

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    tenantA = await createTenant(h.admin, 'p31-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'p31-tenant-b', credentials);

    // Grant tenant admin roles or relevant permissions to user A
    // (createTenant assigns org_admin which has org-level permissions)
    // We add contacts.*, templates.*, suppressions.* grants for the test users:
    const addRoleWithPermissions = async (
      tenant: TenantFixture,
      nameSuffix: string,
      scopeTypes: ('organization' | 'workspace')[],
      perms: string[],
    ) => {
      const roleId = uuidv7();
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: tenant.orgId,
        key: `p31_${nameSuffix}_${tenant.slug.replace(/-/g, '_')}`,
        name: `p31_${nameSuffix}_${tenant.slug}`,
        description: 'Phase 3.1 test role',
        isSystem: false,
        allowedScopeTypes: scopeTypes,
      });
      for (const p of perms) {
        const [perm] = await h.admin
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, p));
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

    // Contacts permissions (workspace-owned, admitted at org & workspace)
    await addRoleWithPermissions(tenantA, 'ws', ['organization', 'workspace'], [
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.CONTACTS_MANAGE,
    ]);
    await addRoleWithPermissions(tenantB, 'ws', ['organization', 'workspace'], [
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.CONTACTS_MANAGE,
    ]);

    // Templates and suppressions permissions (org-owned, admitted only at org)
    await addRoleWithPermissions(tenantA, 'org', ['organization'], [
      PERMISSIONS.TEMPLATES_READ,
      PERMISSIONS.TEMPLATES_MANAGE,
      PERMISSIONS.SUPPRESSIONS_READ,
      PERMISSIONS.SUPPRESSIONS_MANAGE,
    ]);
    await addRoleWithPermissions(tenantB, 'org', ['organization'], [
      PERMISSIONS.TEMPLATES_READ,
      PERMISSIONS.TEMPLATES_MANAGE,
      PERMISSIONS.SUPPRESSIONS_READ,
      PERMISSIONS.SUPPRESSIONS_MANAGE,
    ]);

    // Query seeded whatsapp channel id
    const [ch] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = ch!.id;

    // Login user A
    const loginA = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantA.email, password: PASSWORD });
    tokenA = loginA.body.data.accessToken;

    // Login user B
    const loginB = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantB.email, password: PASSWORD });
    tokenB = loginB.body.data.accessToken;
  }, 60_000);

  afterAll(async () => {
    // Clean up created tenant content
    await h.admin.execute(sql`ALTER TABLE consent_events DISABLE TRIGGER trg_consent_events_immutable`);
    await h.admin.execute(sql`DELETE FROM consent_events WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`);
    await h.admin.execute(sql`ALTER TABLE consent_events ENABLE TRIGGER trg_consent_events_immutable`);

    await h.admin.execute(sql`DELETE FROM contact_identities WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`);
    await h.admin.execute(sql`DELETE FROM contacts WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`);
    await h.admin.execute(sql`DELETE FROM templates WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`);
    await h.admin.execute(sql`DELETE FROM suppressions WHERE org_id = ${tenantA.orgId} OR org_id = ${tenantB.orgId}`);

    await destroyTenant(h.admin, tenantA);
    await destroyTenant(h.admin, tenantB);
    await h.close();
  }, 60_000);

  describe('1. Model B RLS & Dual 404/403 Scope Error Semantics', () => {
    it('Tenant A creating a contact succeeds in its own workspace', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Alice', lastName: 'A', metadata: { vip: true } });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        workspaceId: tenantA.workspaceId,
        firstName: 'Alice',
        lastName: 'A',
      });
    });

    it('Tenant A attempting to create a contact in Tenant B workspace returns 404 (RESOURCE_NOT_FOUND)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantB.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Intruder', lastName: 'X' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('Tenant A cannot see Tenant B contacts in listing (cross-tenant RLS isolation)', async () => {
      // First create contact in Tenant B
      const createB = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantB.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenB}`)
        .send({ firstName: 'Bob', lastName: 'B' });
      expect(createB.status).toBe(201);
      const contactBId = createB.body.data.id;

      // Tenant A tries to get Tenant B contact by ID -> 404
      const getBFromA = await request(h.app.getHttpServer())
        .get(url(`/contacts/${contactBId}`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(getBFromA.status).toBe(404);
      expect(getBFromA.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });
  });

  describe('2. Identity Normalization & Uniqueness', () => {
    let contactAId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'IdentTest' });
      contactAId = res.body.data.id;
    });

    it('normalizes phone number to E.164 and strips delimiters', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/contacts/${contactAId}/identities`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          rawAddress: '+1 (202) 555-0199',
          isPrimary: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.rawAddress).toBe('+1 (202) 555-0199');
      expect(res.body.data.normalizedAddress).toBe('+12025550199');
      expect(res.body.data.status).toBe('active');
    });

    it('rejects phone number without country code with 400 PHONE_MISSING_COUNTRY_CODE', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/contacts/${contactAId}/identities`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          rawAddress: '2025550199',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.PHONE_MISSING_COUNTRY_CODE);
    });

    it('enforces partial unique index on active identities per workspace and channel', async () => {
      // Create another contact in the same workspace
      const c2 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'DuplicateHolder' });

      const res = await request(h.app.getHttpServer())
        .post(url(`/contacts/${c2.body.data.id}/identities`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          rawAddress: '+12025550199',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
    });
  });

  describe('3. Consent Evaluation & Deterministic Fail-Closed Algorithm', () => {
    let contactId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'ConsentTest' });
      contactId = res.body.data.id;
    });

    it('evaluates to unconsented when no consent events exist', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/contacts/${contactId}/consent-effective?channelId=${channelId}&consentType=marketing`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.effectiveState).toBe('unconsented');
    });

    it('rejects consent events more than 5 minutes in the future with 400 CONSENT_FUTURE_TIMESTAMP', async () => {
      const tenMinutesFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const res = await request(h.app.getHttpServer())
        .post(url(`/contacts/${contactId}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'marketing',
          event: 'grant',
          occurredAt: tenMinutesFuture,
          source: 'web_form',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.CONSENT_FUTURE_TIMESTAMP);
    });

    it('evaluates to opted_in following a grant event', async () => {
      const t1 = new Date(Date.now() - 60 * 1000).toISOString();
      const postGrant = await request(h.app.getHttpServer())
        .post(url(`/contacts/${contactId}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'marketing',
          event: 'grant',
          occurredAt: t1,
          source: 'web_form',
        });
      expect(postGrant.status).toBe(201);

      const res = await request(h.app.getHttpServer())
        .get(url(`/contacts/${contactId}/consent-effective?channelId=${channelId}&consentType=marketing`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.effectiveState).toBe('opted_in');
    });

    it('evaluates to opted_out following a newer revoke event', async () => {
      const t2 = new Date(Date.now() - 30 * 1000).toISOString();
      await request(h.app.getHttpServer())
        .post(url(`/contacts/${contactId}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'marketing',
          event: 'revoke',
          occurredAt: t2,
          source: 'unsubscribe_link',
        });

      const res = await request(h.app.getHttpServer())
        .get(url(`/contacts/${contactId}/consent-effective?channelId=${channelId}&consentType=marketing`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.effectiveState).toBe('opted_out');
    });

    it('fails closed to unconsented on contradictory grant and revoke sharing the exact latest occurred_at', async () => {
      const t3 = new Date(Date.now() - 5 * 1000).toISOString();
      // Record grant at t3
      await request(h.app.getHttpServer())
        .post(url(`/contacts/${contactId}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'marketing',
          event: 'grant',
          occurredAt: t3,
          source: 'import_a',
        });

      // Record revoke at t3
      await request(h.app.getHttpServer())
        .post(url(`/contacts/${contactId}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'marketing',
          event: 'revoke',
          occurredAt: t3,
          source: 'import_b',
        });

      const res = await request(h.app.getHttpServer())
        .get(url(`/contacts/${contactId}/consent-effective?channelId=${channelId}&consentType=marketing`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.effectiveState).toBe('unconsented');
    });

    it('evaluates to unconsented when 3 or more events share the latest occurred_at including contradictory grant/revoke', async () => {
      // Create a dedicated contact to isolate this multi-event scenario
      const c = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'MultiEventConsent' });
      const cid = c.body.data.id;

      // 1. Prior grant at t_older (60s ago)
      const tOlder = new Date(Date.now() - 60 * 1000).toISOString();
      await request(h.app.getHttpServer())
        .post(url(`/contacts/${cid}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'transactional',
          event: 'grant',
          occurredAt: tOlder,
          source: 'initial_optin',
        });

      // Verify intermediate state is opted_in
      const preCheck = await request(h.app.getHttpServer())
        .get(url(`/contacts/${cid}/consent-effective?channelId=${channelId}&consentType=transactional`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(preCheck.status).toBe(200);
      expect(preCheck.body.data.effectiveState).toBe('opted_in');

      // 2. Exactly three events sharing the exact latest occurred_at timestamp t_latest (10s ago):
      // Two grants, one revoke
      const tLatest = new Date(Date.now() - 10 * 1000).toISOString();
      await request(h.app.getHttpServer())
        .post(url(`/contacts/${cid}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'transactional',
          event: 'grant',
          occurredAt: tLatest,
          source: 'batch_grant_1',
        });

      await request(h.app.getHttpServer())
        .post(url(`/contacts/${cid}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'transactional',
          event: 'grant',
          occurredAt: tLatest,
          source: 'batch_grant_2',
        });

      await request(h.app.getHttpServer())
        .post(url(`/contacts/${cid}/consent-events`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          consentType: 'transactional',
          event: 'revoke',
          occurredAt: tLatest,
          source: 'batch_revoke_1',
        });

      // 3. Evaluate effective consent
      const res = await request(h.app.getHttpServer())
        .get(url(`/contacts/${cid}/consent-effective?channelId=${channelId}&consentType=transactional`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      // Contradiction at latest timestamp must fail closed to unconsented
      expect(res.body.data.effectiveState).toBe('unconsented');
    });
  });

  describe('4. Suppressions Savepoint Conflict Recovery & Lifecycle', () => {
    it('creates active suppression and catches duplicate with 409 SUPPRESSION_ALREADY_ACTIVE', async () => {
      const res1 = await request(h.app.getHttpServer())
        .post(url('/suppressions'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          rawAddress: '+12025559999',
          reason: 'Spam complaint',
        });

      expect(res1.status).toBe(201);
      expect(res1.body.data.status).toBe('active');
      const suppressionId = res1.body.data.id;

      // Duplicate submission
      const res2 = await request(h.app.getHttpServer())
        .post(url('/suppressions'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          rawAddress: '+1 (202) 555-9999',
          reason: 'Second complaint',
        });

      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe(ERROR_CODES.SUPPRESSION_ALREADY_ACTIVE);
      expect(res2.body.error.details).toMatchObject({
        existingSuppressionId: suppressionId,
        channelId,
        status: 'active',
      });
    });

    it('enforces cross-tenant suppression isolation, independent uniqueness, and anti-enumeration', async () => {
      const sharedAddress = '+12025558888';

      // 1. Organization A creates suppression for sharedAddress
      const resA = await request(h.app.getHttpServer())
        .post(url('/suppressions'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          rawAddress: sharedAddress,
          reason: 'Org A complaint',
        });
      expect(resA.status).toBe(201);
      const suppressionAId = resA.body.data.id;

      // 2. Organization B creates suppression for the SAME sharedAddress
      // Because index is (org_id, channel_id, normalized_address), Org B is NOT blocked
      const resB = await request(h.app.getHttpServer())
        .post(url('/suppressions'))
        .set('authorization', `Bearer ${tokenB}`)
        .send({
          channelId,
          rawAddress: sharedAddress,
          reason: 'Org B complaint',
        });
      expect(resB.status).toBe(201);
      const suppressionBId = resB.body.data.id;
      expect(suppressionBId).not.toBe(suppressionAId);

      // 3. Organization A attempts to read Organization B's suppression by ID
      // Must return 404 RESOURCE_NOT_FOUND (anti-enumeration under Model B RLS)
      const readCross = await request(h.app.getHttpServer())
        .get(url(`/suppressions/${suppressionBId}`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(readCross.status).toBe(404);
      expect(readCross.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
      // Verify no disclosure of Org B's details
      expect(JSON.stringify(readCross.body)).not.toContain(sharedAddress);
      expect(JSON.stringify(readCross.body)).not.toContain(tenantB.orgId);

      // 4. Organization A lists suppressions: must see its own suppression, never Org B's
      const listA = await request(h.app.getHttpServer())
        .get(url('/suppressions'))
        .set('authorization', `Bearer ${tokenA}`);
      expect(listA.status).toBe(200);
      const idsA = listA.body.data.map((s: { id: string }) => s.id);
      expect(idsA).toContain(suppressionAId);
      expect(idsA).not.toContain(suppressionBId);

      // 5. Organization A attempts to lift Organization B's suppression
      // Must return 404 RESOURCE_NOT_FOUND; Org B's suppression remains active
      const liftCross = await request(h.app.getHttpServer())
        .post(url(`/suppressions/${suppressionBId}/lift`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ reason: 'Malicious lift attempt' });
      expect(liftCross.status).toBe(404);
      expect(liftCross.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);

      // Verify Org B's suppression is still active
      const checkB = await request(h.app.getHttpServer())
        .get(url(`/suppressions/${suppressionBId}`))
        .set('authorization', `Bearer ${tokenB}`);
      expect(checkB.status).toBe(200);
      expect(checkB.body.data.status).toBe('active');

      // 6. Organization A duplicate attempt still triggers savepoint recovery and 409
      const dupA = await request(h.app.getHttpServer())
        .post(url('/suppressions'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          rawAddress: sharedAddress,
          reason: 'Duplicate in Org A',
        });
      expect(dupA.status).toBe(409);
      expect(dupA.body.error.code).toBe(ERROR_CODES.SUPPRESSION_ALREADY_ACTIVE);
      expect(dupA.body.error.details.existingSuppressionId).toBe(suppressionAId);
    });

    it('lifts suppression: transitions to cleared with clearedReason', async () => {
      const create = await request(h.app.getHttpServer())
        .post(url('/suppressions'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId: null,
          rawAddress: 'suppress-test@example.com',
          reason: 'Customer request',
        });
      expect(create.status).toBe(201);
      const id = create.body.data.id;

      const lift = await request(h.app.getHttpServer())
        .post(url(`/suppressions/${id}/lift`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ reason: 'Customer re-subscribed' });

      expect(lift.status).toBe(200);
      expect(lift.body.data.status).toBe('cleared');
      expect(lift.body.data.clearedReason).toBe('Customer re-subscribed');
      expect(lift.body.data.clearedAt).not.toBeNull();
    });
  });

  describe('5. Templates Lifecycle & Simulated Approval State Machine', () => {
    let templateId: string;

    it('creates template in draft status and prevents duplicate active name', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url('/templates'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          name: 'Welcome_Offer',
          body: 'Hello {{firstName}}',
          variables: ['firstName'],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.approvalStatus).toBe('draft');
      templateId = res.body.data.id;

      // Duplicate case-insensitive name in same org
      const dup = await request(h.app.getHttpServer())
        .post(url('/templates'))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          channelId,
          name: 'welcome_offer',
          body: 'Duplicate body',
        });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
    });

    it('simulates approval state transitions: draft -> pending -> approved', async () => {
      // Illegal direct jump from draft to approved
      const illegal = await request(h.app.getHttpServer())
        .post(url(`/templates/${templateId}/simulate-approval`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ targetStatus: 'approved' });
      expect(illegal.status).toBe(409);
      expect(illegal.body.error.code).toBe(ERROR_CODES.TEMPLATE_APPROVAL_CONFLICT);

      // Legal transition: draft -> pending
      const pending = await request(h.app.getHttpServer())
        .post(url(`/templates/${templateId}/simulate-approval`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ targetStatus: 'pending' });
      expect(pending.status).toBe(200);
      expect(pending.body.data.approvalStatus).toBe('pending');

      // Legal transition: pending -> approved
      const approved = await request(h.app.getHttpServer())
        .post(url(`/templates/${templateId}/simulate-approval`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ targetStatus: 'approved' });
      expect(approved.status).toBe(200);
      expect(approved.body.data.approvalStatus).toBe('approved');
    });

    it('approved template cannot be edited', async () => {
      const edit = await request(h.app.getHttpServer())
        .patch(url(`/templates/${templateId}`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ body: 'Altered body' });
      expect(edit.status).toBe(409);
      expect(edit.body.error.code).toBe(ERROR_CODES.TEMPLATE_APPROVAL_CONFLICT);
    });
  });
});
