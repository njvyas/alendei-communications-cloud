import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
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

describe('Phase 8A.1: Saved Segments & Audience Resolution Integration Suite', () => {
  let h: Harness;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let workspace2A: string;
  let tokenReadOnlyA: string;

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
      key: `seg_${keySuffix}_${tenant.slug.replace(/-/g, '_')}`,
      name: `Segments ${keySuffix} ${tenant.slug}`,
      description: 'Segments test role',
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
    return roleId;
  };

  const createUserWithRole = async (
    tenant: TenantFixture,
    email: string,
    roleId: string,
    scopeType: 'organization' | 'workspace',
    scopeId: string,
  ) => {
    const credentials = h.app.get(CredentialService);
    const userId = uuidv7();
    const digest = await credentials.hash(PASSWORD);

    await h.admin.insert(schema.users).values({
      id: userId,
      orgId: tenant.orgId,
      email,
      passwordHash: digest,
      status: 'active',
    });

    await h.admin.insert(schema.userRoles).values({
      id: uuidv7(),
      userId,
      roleId,
      scopeType,
      scopeId,
      orgId: tenant.orgId,
    });

    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD });
    return res.body.data.accessToken as string;
  };

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    tenantA = await createTenant(h.admin, 'seg-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'seg-tenant-b', credentials);

    // Grant contacts permissions to tenant A
    const adminRoleIdA = await createRole(
      tenantA,
      'admin',
      ['organization', 'workspace'],
      [PERMISSIONS.CONTACTS_READ, PERMISSIONS.CONTACTS_MANAGE, PERMISSIONS.WORKSPACES_READ],
    );
    await h.admin.insert(schema.userRoles).values({
      orgId: tenantA.orgId,
      userId: tenantA.userId,
      roleId: adminRoleIdA,
      scopeType: 'organization',
      scopeId: tenantA.orgId,
    });

    // Grant contacts permissions to tenant B
    const adminRoleIdB = await createRole(
      tenantB,
      'admin',
      ['organization', 'workspace'],
      [PERMISSIONS.CONTACTS_READ, PERMISSIONS.CONTACTS_MANAGE, PERMISSIONS.WORKSPACES_READ],
    );
    await h.admin.insert(schema.userRoles).values({
      orgId: tenantB.orgId,
      userId: tenantB.userId,
      roleId: adminRoleIdB,
      scopeType: 'organization',
      scopeId: tenantB.orgId,
    });

    // Login tokens
    const loginA = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantA.email, password: PASSWORD });
    tokenA = loginA.body.data.accessToken;

    const loginB = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenantB.email, password: PASSWORD });
    tokenB = loginB.body.data.accessToken;

    // Read-only role for Tenant A
    const readOnlyRoleIdA = await createRole(
      tenantA,
      'reader',
      ['organization', 'workspace'],
      [PERMISSIONS.CONTACTS_READ, PERMISSIONS.WORKSPACES_READ],
    );
    tokenReadOnlyA = await createUserWithRole(
      tenantA,
      `reader@${tenantA.slug}.com`,
      readOnlyRoleIdA,
      'workspace',
      tenantA.workspaceId,
    );

    // Sibling workspace in Tenant A
    workspace2A = uuidv7();
    await h.admin.insert(schema.workspaces).values({
      id: workspace2A,
      orgId: tenantA.orgId,
      name: 'Secondary Workspace A',
      slug: `secondary-${tenantA.slug}`,
      status: 'active',
    });
  });

  afterAll(async () => {
    if (h) {
      if (tenantA) {
        await h.admin.execute(sql`DELETE FROM segments WHERE org_id = ${tenantA.orgId}`);
        await h.admin
          .execute(sql`DELETE FROM contact_identities WHERE org_id = ${tenantA.orgId}`)
          .catch(() => {});
        await h.admin
          .execute(sql`DELETE FROM contacts WHERE org_id = ${tenantA.orgId}`)
          .catch(() => {});
        await destroyTenant(h.admin, tenantA);
      }
      if (tenantB) {
        await h.admin.execute(sql`DELETE FROM segments WHERE org_id = ${tenantB.orgId}`);
        await h.admin
          .execute(sql`DELETE FROM contact_identities WHERE org_id = ${tenantB.orgId}`)
          .catch(() => {});
        await h.admin
          .execute(sql`DELETE FROM contacts WHERE org_id = ${tenantB.orgId}`)
          .catch(() => {});
        await destroyTenant(h.admin, tenantB);
      }
      await h.close();
    }
  });

  describe('Segment Lifecycle (CRUD)', () => {
    let createdSegmentId: string;

    it('creates a saved segment with name, description and valid criteria', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'High-Value Enterprise Customers',
          description: 'Contacts with enterprise plan and seats >= 10',
          criteria: {
            tags: ['vip'],
            tagMatchMode: 'any',
            customFieldFilters: [
              { field: 'plan', operator: 'equals', value: 'enterprise' },
              { field: 'seats', operator: 'exists' },
            ],
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe('High-Value Enterprise Customers');
      expect(res.body.data.description).toBe('Contacts with enterprise plan and seats >= 10');
      expect(res.body.data.criteria.tags).toEqual(['vip']);
      expect(res.body.data.criteria.customFieldFilters).toHaveLength(2);

      createdSegmentId = res.body.data.id;
    });

    it('retrieves the segment by id', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/segments/${createdSegmentId}`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdSegmentId);
      expect(res.body.data.name).toBe('High-Value Enterprise Customers');
    });

    it('lists segments with workspace isolation and pagination', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/segments?limit=10`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.some((s: { id: string }) => s.id === createdSegmentId)).toBe(true);
      expect(res.body.page).toBeDefined();
    });

    it('refuses creating a duplicate segment name within the same workspace (case-insensitive)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'high-value enterprise customers', // same name, different casing
          description: 'Duplicate attempt',
          criteria: {},
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ERROR_CODES.SEGMENT_NAME_EXISTS);
    });

    it('updates segment name, description and criteria', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/workspaces/${tenantA.workspaceId}/segments/${createdSegmentId}`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Updated Enterprise VIPs',
          description: 'Updated description',
          criteria: {
            tags: ['vip', 'enterprise'],
            tagMatchMode: 'all',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated Enterprise VIPs');
      expect(res.body.data.description).toBe('Updated description');
      expect(res.body.data.criteria.tagMatchMode).toBe('all');
    });

    it('soft-deletes a segment', async () => {
      const delRes = await request(h.app.getHttpServer())
        .delete(url(`/workspaces/${tenantA.workspaceId}/segments/${createdSegmentId}`))
        .set('authorization', `Bearer ${tokenA}`);

      expect(delRes.status).toBe(204);

      // Subsequent get returns 404
      const getRes = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/segments/${createdSegmentId}`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(getRes.status).toBe(404);

      // Name can now be reused because previous segment is deleted
      const recreateRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Updated Enterprise VIPs',
          criteria: {},
        });
      expect(recreateRes.status).toBe(201);
    });
  });

  describe('Criteria Validation & Allowlisting', () => {
    it('refuses segment criteria targeting reserved custom field names (tags, id, orgId, workspaceId)', async () => {
      for (const forbidden of ['tags', 'tag_list', 'id', 'workspaceId', 'orgId']) {
        const res = await request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({
            name: `Test Reserved ${forbidden}`,
            criteria: {
              customFieldFilters: [{ field: forbidden, operator: 'exists' }],
            },
          });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe(ERROR_CODES.SEGMENT_CRITERIA_INVALID);
      }
    });

    it('refuses invalid operator in customFieldFilters', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Invalid Operator Segment',
          criteria: {
            customFieldFilters: [
              { field: 'industry', operator: 'regex_match' as never, value: 'tech' },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect([ERROR_CODES.SEGMENT_CRITERIA_INVALID, ERROR_CODES.VALIDATION_FAILED]).toContain(
        res.body.error.code,
      );
    });

    it('refuses operator that requires a value when value is missing', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Missing Value Segment',
          criteria: {
            customFieldFilters: [{ field: 'industry', operator: 'equals' }],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.SEGMENT_CRITERIA_INVALID);
    });
  });

  describe('Audience Preview & Custom Field Operators', () => {
    const runTag = `cf_test_${uuidv7().replace(/-/g, '')}`;
    let c1Id: string;
    let c2Id: string;
    let c3Id: string;
    let c4Id: string;

    beforeAll(async () => {
      // Seed 4 contacts with various custom fields in metadata
      // Contact 1: VIP, Enterprise, 50 seats, active: true, city: 'London'
      const c1 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          firstName: 'Alice',
          metadata: {
            tags: [runTag, 'vip'],
            plan: 'enterprise',
            seats: 50,
            active: true,
            city: 'London',
          },
        });
      c1Id = c1.body.data.id;

      // Contact 2: VIP, Starter, 5 seats, active: false, city: 'New York'
      const c2 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          firstName: 'Bob',
          metadata: {
            tags: [runTag, 'vip'],
            plan: 'starter',
            seats: 5,
            active: false,
            city: 'New York',
          },
        });
      c2Id = c2.body.data.id;

      // Contact 3: Beta, Enterprise, 20 seats, active: true, city: 'Londonderry'
      const c3 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          firstName: 'Charlie',
          metadata: {
            tags: [runTag, 'beta'],
            plan: 'enterprise',
            seats: 20,
            active: true,
            city: 'Londonderry',
          },
        });
      c3Id = c3.body.data.id;

      // Contact 4: Lead, Pro, active: true (no seats, no city)
      const c4 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          firstName: 'David',
          metadata: {
            tags: [runTag, 'lead'],
            plan: 'pro',
            active: true,
          },
        });
      c4Id = c4.body.data.id;
    });

    const createAndPreview = async (criteria: Record<string, unknown>) => {
      const segRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: `Preview Test ${uuidv7()}`,
          criteria: {
            tags: [runTag],
            ...criteria,
          },
        });
      expect(segRes.status).toBe(201);
      const segId = segRes.body.data.id;

      const prevRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments/${segId}/preview`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({});
      return prevRes;
    };

    it('evaluates exists operator correctly', async () => {
      const res = await createAndPreview({
        customFieldFilters: [{ field: 'seats', operator: 'exists' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(3);
      const ids = res.body.data.map((c: { contactId: string }) => c.contactId);
      expect(ids).toContain(c1Id);
      expect(ids).toContain(c2Id);
      expect(ids).toContain(c3Id);
      expect(ids).not.toContain(c4Id);
    });

    it('evaluates does_not_exist operator correctly', async () => {
      const res = await createAndPreview({
        customFieldFilters: [{ field: 'seats', operator: 'does_not_exist' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(1);
      expect(res.body.data[0].contactId).toBe(c4Id);
    });

    it('evaluates equals operator on strings (case-insensitively)', async () => {
      const res = await createAndPreview({
        customFieldFilters: [{ field: 'plan', operator: 'equals', value: 'ENTERPRISE' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(2);
      const ids = res.body.data.map((c: { contactId: string }) => c.contactId);
      expect(ids).toContain(c1Id);
      expect(ids).toContain(c3Id);
    });

    it('evaluates equals operator on numbers', async () => {
      const res = await createAndPreview({
        customFieldFilters: [{ field: 'seats', operator: 'equals', value: 50 }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(1);
      expect(res.body.data[0].contactId).toBe(c1Id);
    });

    it('evaluates equals operator on booleans', async () => {
      const res = await createAndPreview({
        customFieldFilters: [{ field: 'active', operator: 'equals', value: false }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(1);
      expect(res.body.data[0].contactId).toBe(c2Id);
    });

    it('evaluates not_equals operator correctly', async () => {
      const res = await createAndPreview({
        customFieldFilters: [{ field: 'plan', operator: 'not_equals', value: 'enterprise' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(2);
      const ids = res.body.data.map((c: { contactId: string }) => c.contactId);
      expect(ids).toContain(c2Id);
      expect(ids).toContain(c4Id);
    });

    it('evaluates contains operator (substring matching)', async () => {
      const res = await createAndPreview({
        customFieldFilters: [{ field: 'city', operator: 'contains', value: 'london' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(2);
      const ids = res.body.data.map((c: { contactId: string }) => c.contactId);
      expect(ids).toContain(c1Id); // 'London'
      expect(ids).toContain(c3Id); // 'Londonderry'
    });

    it('evaluates combined tagMatchMode and customFieldFilters', async () => {
      const res = await createAndPreview({
        tags: [runTag, 'vip'],
        tagMatchMode: 'all',
        customFieldFilters: [{ field: 'plan', operator: 'equals', value: 'enterprise' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(1);
      expect(res.body.data[0].contactId).toBe(c1Id);
    });
  });

  describe('Tenant & Workspace Isolation', () => {
    let segmentAId: string;

    beforeAll(async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({
          name: `Isolated Segment ${uuidv7()}`,
          criteria: {},
        });
      segmentAId = res.body.data.id;
    });

    it('Tenant B token cannot access Tenant A segment (returns 404)', async () => {
      const getRes = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/segments/${segmentAId}`))
        .set('authorization', `Bearer ${tokenB}`);
      expect(getRes.status).toBe(404);

      const updateRes = await request(h.app.getHttpServer())
        .patch(url(`/workspaces/${tenantA.workspaceId}/segments/${segmentAId}`))
        .set('authorization', `Bearer ${tokenB}`)
        .send({ name: 'Tampered Name' });
      expect(updateRes.status).toBe(404);

      const deleteRes = await request(h.app.getHttpServer())
        .delete(url(`/workspaces/${tenantA.workspaceId}/segments/${segmentAId}`))
        .set('authorization', `Bearer ${tokenB}`);
      expect(deleteRes.status).toBe(404);

      const prevRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments/${segmentAId}/preview`))
        .set('authorization', `Bearer ${tokenB}`)
        .send({});
      expect(prevRes.status).toBe(404);
    });

    it('Sibling workspace in Tenant A cannot access segment from primary workspace (returns 404)', async () => {
      const getRes = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${workspace2A}/segments/${segmentAId}`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(getRes.status).toBe(404);
    });

    it('fails closed when unauthenticated (401)', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/workspaces/${tenantA.workspaceId}/segments/${segmentAId}`),
      );
      expect(res.status).toBe(401);
    });

    it('fails closed when token has insufficient permissions (contacts.read cannot create)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenReadOnlyA}`)
        .send({ name: 'Forbidden Segment' });
      expect(res.status).toBe(403);
    });
  });

  describe('Idempotency & Replay', () => {
    it('returns identical result when replaying same idempotency key and same payload', async () => {
      const idempotencyKey = uuidv7();
      const payload = {
        name: `Idempotent Segment ${uuidv7()}`,
        criteria: { tags: ['newsletter'] },
      };

      const res1 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);
      const createdId = res1.body.data.id;

      const res2 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.body.data.id).toBe(createdId);
    });

    it('refuses replaying same idempotency key with changed name', async () => {
      const idempotencyKey = uuidv7();
      const res1 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', idempotencyKey)
        .send({ name: 'First Name' });
      expect(res1.status).toBe(201);

      const res2 = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .set('idempotency-key', idempotencyKey)
        .send({ name: 'Changed Name' });
      expect(res2.status).toBe(422);
    });
  });

  describe('Case-Insensitive Uniqueness & Concurrency', () => {
    it('concurrent case-variant creates cannot produce duplicates (one succeeds, one 409 SEGMENT_NAME_EXISTS)', async () => {
      const baseName = `Concurrent Segment ${uuidv7()}`;
      const nameUpper = baseName.toUpperCase();
      const nameLower = baseName.toLowerCase();

      const [res1, res2] = await Promise.all([
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ name: nameUpper, criteria: {} }),
        request(h.app.getHttpServer())
          .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ name: nameLower, criteria: {} }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.error.code).toBe(ERROR_CODES.SEGMENT_NAME_EXISTS);

      // Verify at the database level that exactly one row exists in this workspace
      const rows = await h.admin
        .select()
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.workspaceId, tenantA.workspaceId),
            sql`lower(${schema.segments.name}) = lower(${baseName})`,
            isNull(schema.segments.deletedAt),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it('concurrent case-variant renames cannot produce duplicates (one succeeds, one 409 SEGMENT_NAME_EXISTS)', async () => {
      // Create two distinct segments first
      const seg1Res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ name: `Rename Initial 1 ${uuidv7()}`, criteria: {} });
      expect(seg1Res.status).toBe(201);
      const seg1Id = seg1Res.body.data.id;

      const seg2Res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ name: `Rename Initial 2 ${uuidv7()}`, criteria: {} });
      expect(seg2Res.status).toBe(201);
      const seg2Id = seg2Res.body.data.id;

      const targetBase = `Target Rename ${uuidv7()}`;
      const targetUpper = targetBase.toUpperCase();
      const targetLower = targetBase.toLowerCase();

      // Attempt concurrent renames to case variants of the same name
      const [patch1, patch2] = await Promise.all([
        request(h.app.getHttpServer())
          .patch(url(`/workspaces/${tenantA.workspaceId}/segments/${seg1Id}`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ name: targetUpper }),
        request(h.app.getHttpServer())
          .patch(url(`/workspaces/${tenantA.workspaceId}/segments/${seg2Id}`))
          .set('authorization', `Bearer ${tokenA}`)
          .send({ name: targetLower }),
      ]);

      const patchStatuses = [patch1.status, patch2.status].sort();
      expect(patchStatuses).toEqual([200, 409]);

      const patchConflict = patch1.status === 409 ? patch1 : patch2;
      expect(patchConflict.body.error.code).toBe(ERROR_CODES.SEGMENT_NAME_EXISTS);

      // Verify at the database level that exactly one active row has the target name
      const rows = await h.admin
        .select()
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.workspaceId, tenantA.workspaceId),
            sql`lower(${schema.segments.name}) = lower(${targetBase})`,
            isNull(schema.segments.deletedAt),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it('allows soft-deleted name reuse with case-variant name', async () => {
      const reuseBase = `Reuse Base ${uuidv7()}`;
      // Create segment
      const createRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ name: reuseBase.toUpperCase(), criteria: {} });
      expect(createRes.status).toBe(201);
      const segId = createRes.body.data.id;

      // Soft-delete it
      const delRes = await request(h.app.getHttpServer())
        .delete(url(`/workspaces/${tenantA.workspaceId}/segments/${segId}`))
        .set('authorization', `Bearer ${tokenA}`);
      expect(delRes.status).toBe(204);

      // Recreate with lowercase name
      const recreateRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/segments`))
        .set('authorization', `Bearer ${tokenA}`)
        .send({ name: reuseBase.toLowerCase(), criteria: {} });
      expect(recreateRes.status).toBe(201);
      expect(recreateRes.body.data.name).toBe(reuseBase.toLowerCase());

      // Verify both rows exist in DB (1 soft-deleted, 1 active)
      const allRows = await h.admin
        .select()
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.workspaceId, tenantA.workspaceId),
            sql`lower(${schema.segments.name}) = lower(${reuseBase})`,
          ),
        );
      expect(allRows).toHaveLength(2);
      expect(allRows.filter((r) => r.deletedAt !== null)).toHaveLength(1);
      expect(allRows.filter((r) => r.deletedAt === null)).toHaveLength(1);
    });
  });
});
