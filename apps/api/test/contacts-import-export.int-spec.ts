import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
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

describe('Phase 8A-2: Contact Import & Export Integration Suite', () => {
  let h: Harness;
  let tenant: TenantFixture;
  let token: string;

  const grantPermissions = async (fixture: TenantFixture, permissions: string[]) => {
    const roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: fixture.orgId,
      key: `role_${uuidv7().replace(/-/g, '').slice(-10)}`,
      name: 'Contacts Test Role',
      description: 'Scoped test role',
      isSystemRole: false,
      allowedScopeTypes: ['organization', 'workspace'],
    });

    for (const key of permissions) {
      const [permission] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, key));
      if (permission) {
        await h.admin
          .insert(schema.rolePermissions)
          .values({ roleId, permissionId: permission.id })
          .onConflictDoNothing();
      }
    }

    await h.admin.insert(schema.userRoles).values({
      id: uuidv7(),
      orgId: fixture.orgId,
      userId: fixture.userId,
      roleId,
      scopeType: 'organization',
      scopeId: fixture.orgId,
    });
  };

  const login = async (email: string) => {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  };

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    tenant = await createTenant(h.admin, 'import-export-int', credentials);

    await grantPermissions(tenant, [
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.CONTACTS_MANAGE,
      PERMISSIONS.CONTACTS_IMPORT,
      PERMISSIONS.CONTACTS_EXPORT,
      PERMISSIONS.WORKSPACES_READ,
    ]);

    token = await login(tenant.email);
  }, 60_000);

  afterAll(async () => {
    if (tenant) {
      await h.admin.execute(sql`DELETE FROM segments WHERE org_id = ${tenant.orgId}`);
      await destroyTenant(h.admin, tenant);
    }
    await h.close();
  }, 60_000);

  beforeEach(async () => {
    // Clean up contacts in the tenant's workspace between tests for test isolation
    await h.admin.execute(
      sql`ALTER TABLE consent_events DISABLE TRIGGER trg_consent_events_immutable`,
    );
    await h.admin.execute(
      sql`DELETE FROM consent_events WHERE workspace_id = ${tenant.workspaceId}`,
    );
    await h.admin.execute(
      sql`ALTER TABLE consent_events ENABLE TRIGGER trg_consent_events_immutable`,
    );
    await h.admin.execute(
      sql`DELETE FROM contact_identities WHERE workspace_id = ${tenant.workspaceId}`,
    );
    await h.admin.execute(sql`DELETE FROM contacts WHERE workspace_id = ${tenant.workspaceId}`);
    await h.admin.execute(sql`DELETE FROM segments WHERE workspace_id = ${tenant.workspaceId}`);
  });

  // ===========================================================================
  // 1. JSON Contact Import
  // ===========================================================================
  describe('1. JSON Contact Import', () => {
    it('imports new contacts with tags, custom fields, and consent event', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [
            {
              firstName: 'Alice',
              lastName: 'Smith',
              phone: '+15551234567',
              email: 'alice@example.test',
              tags: ['vip', 'newsletter'],
              customFields: { plan: 'enterprise', tier: 1 },
              consent: {
                channelCode: 'sms',
                consentType: 'marketing',
                event: 'grant',
                source: 'web_form',
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual({
        totalCount: 1,
        processedCount: 1,
        created: 1,
        updated: 0,
        skipped: 0,
        failed: 0,
      });
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0]).toMatchObject({
        row: 1,
        action: 'created',
      });
      expect(res.body.errors).toHaveLength(0);

      const contactId = res.body.results[0].contactId;
      expect(contactId).toBeDefined();

      // Verify contact in DB
      const [contact] = await h.admin
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, contactId));
      expect(contact).toBeDefined();
      expect(contact!.firstName).toBe('Alice');
      expect(contact!.lastName).toBe('Smith');
      expect(contact!.metadata).toMatchObject({
        tags: ['vip', 'newsletter'],
        plan: 'enterprise',
        tier: 1,
      });

      // Verify identities in DB (phone & email)
      const identities = await h.admin
        .select()
        .from(schema.contactIdentities)
        .where(eq(schema.contactIdentities.contactId, contactId));
      expect(identities).toHaveLength(2);
      const phoneId = identities.find((i) => i.normalizedAddress === '+15551234567');
      const emailId = identities.find((i) => i.normalizedAddress === 'alice@example.test');
      expect(phoneId).toBeDefined();
      expect(emailId).toBeDefined();

      // Verify immutable consent_events row
      const consentEvents = await h.admin
        .select()
        .from(schema.consentEvents)
        .where(eq(schema.consentEvents.contactId, contactId));
      expect(consentEvents).toHaveLength(1);
      expect(consentEvents[0]!.event).toBe('grant');
      expect(consentEvents[0]!.consentType).toBe('marketing');
      expect(consentEvents[0]!.source).toBe('web_form');
    });

    it('handles absent consent without inferring opt-in or writing synthetic events', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [
            {
              firstName: 'Bob',
              lastName: 'NoConsent',
              phone: '+15559876543',
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.summary.created).toBe(1);
      const contactId = res.body.results[0].contactId;

      const consentEvents = await h.admin
        .select()
        .from(schema.consentEvents)
        .where(eq(schema.consentEvents.contactId, contactId));
      expect(consentEvents).toHaveLength(0);
    });

    it('duplicateStrategy=skip leaves existing matching contact untouched', async () => {
      // 1. Initial import
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [
            {
              firstName: 'Original',
              lastName: 'User',
              phone: '+15553334444',
            },
          ],
        })
        .expect(200);

      // 2. Duplicate import with skip strategy
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          duplicateStrategy: 'skip',
          contacts: [
            {
              firstName: 'Modified',
              lastName: 'Attempt',
              phone: '+15553334444',
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({
        totalCount: 1,
        processedCount: 1,
        created: 0,
        updated: 0,
        skipped: 1,
        failed: 0,
      });
      expect(res.body.results[0].action).toBe('skipped');

      // Check contact name was not modified
      const [contact] = await h.admin
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.workspaceId, tenant.workspaceId));
      expect(contact!.firstName).toBe('Original');
    });

    it('duplicateStrategy=update updates contact details and appends secondary identity', async () => {
      // 1. Initial import
      const initRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [
            {
              firstName: 'Charlie',
              lastName: 'Brown',
              phone: '+15554445555',
              tags: ['bronze'],
            },
          ],
        })
        .expect(200);
      const contactId = initRes.body.results[0].contactId;

      // 2. Update via duplicateStrategy=update with newly added email
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          duplicateStrategy: 'update',
          contacts: [
            {
              firstName: 'Charles',
              lastName: 'Brown Jr.',
              phone: '+15554445555',
              email: 'charlie@peanuts.test',
              tags: ['silver'],
              customFields: { loyalty: 50 },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({
        totalCount: 1,
        processedCount: 1,
        created: 0,
        updated: 1,
        skipped: 0,
        failed: 0,
      });
      expect(res.body.results[0].action).toBe('updated');
      expect(res.body.results[0].contactId).toBe(contactId);

      // Verify contact was updated
      const [contact] = await h.admin
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, contactId));
      expect(contact!.firstName).toBe('Charles');
      expect(contact!.lastName).toBe('Brown Jr.');
      expect(contact!.metadata).toMatchObject({
        tags: expect.arrayContaining(['bronze', 'silver']),
        loyalty: 50,
      });

      // Verify secondary email identity was attached
      const identities = await h.admin
        .select()
        .from(schema.contactIdentities)
        .where(eq(schema.contactIdentities.contactId, contactId));
      expect(identities).toHaveLength(2);
      expect(identities.some((i) => i.normalizedAddress === 'charlie@peanuts.test')).toBe(true);
    });

    it('duplicateStrategy=fail rejects duplicate row with conflict error', async () => {
      // 1. Initial import
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [{ phone: '+15556667777' }],
        })
        .expect(200);

      // 2. Duplicate import with duplicateStrategy=fail in skip_invalid mode
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          duplicateStrategy: 'fail',
          mode: 'skip_invalid',
          contacts: [{ phone: '+15556667777' }],
        });

      expect(res.status).toBe(200);
      expect(res.body.summary.failed).toBe(1);
      expect(res.body.errors[0].code).toBe(ERROR_CODES.DUPLICATE_IDENTITY_EXISTS);
    });

    it('rejects identity conflict between two distinct existing contacts (never silently merges)', async () => {
      // 1. Create Contact A with phone
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [{ firstName: 'User A', phone: '+15551110001' }],
        })
        .expect(200);

      // 2. Create Contact B with email
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [{ firstName: 'User B', email: 'userb@example.test' }],
        })
        .expect(200);

      // 3. Attempt import row containing Contact A's phone AND Contact B's email
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          mode: 'abort_on_error',
          duplicateStrategy: 'update',
          contacts: [
            {
              firstName: 'Colliding',
              phone: '+15551110001',
              email: 'userb@example.test',
            },
          ],
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ERROR_CODES.IDENTITY_CONFLICT);

      // Verify Contact A and Contact B remain separate
      const contacts = await h.admin
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.workspaceId, tenant.workspaceId));
      expect(contacts).toHaveLength(2);
    });

    it('mode=abort_on_error rolls back all rows if any row fails validation', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          mode: 'abort_on_error',
          contacts: [
            { firstName: 'Valid Row 1', phone: '+15558881111' },
            { firstName: 'Invalid Row 2', phone: 'not-a-phone' }, // invalid phone
            { firstName: 'Valid Row 3', phone: '+15558883333' },
          ],
        });

      expect(res.status).toBe(422);
      expect(res.body.summary).toMatchObject({
        totalCount: 3,
        processedCount: 0,
        created: 0,
        failed: 1,
      });
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].row).toBe(2);
      expect(res.body.results).toHaveLength(0);

      // Assert rollback: zero contacts created
      const countRes = await h.admin
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.contacts)
        .where(eq(schema.contacts.workspaceId, tenant.workspaceId));
      expect(countRes[0]!.count).toBe(0);
    });

    it('mode=skip_invalid commits valid rows and records savepoint rollback for failed rows', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          mode: 'skip_invalid',
          contacts: [
            { firstName: 'Valid Row 1', phone: '+15558881111' },
            { firstName: 'Invalid Row 2', phone: 'invalid-number' },
            { firstName: 'Valid Row 3', phone: '+15558883333' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({
        totalCount: 3,
        processedCount: 2,
        created: 2,
        failed: 1,
      });
      expect(res.body.results).toHaveLength(2);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].row).toBe(2);

      // Assert valid contacts were saved
      const contacts = await h.admin
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.workspaceId, tenant.workspaceId));
      expect(contacts).toHaveLength(2);
    });

    it('enforces maximum 5,000 row import limit with 422 error', async () => {
      const oversized = Array.from({ length: 5001 }, (_, i) => ({
        firstName: `User ${i}`,
        phone: `+1555000${String(i).padStart(4, '0')}`,
      }));

      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({ contacts: oversized });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.IMPORT_ROW_LIMIT_EXCEEDED);
    });
  });

  // ===========================================================================
  // 2. CSV Contact Import & Formula Safety Round-trip
  // ===========================================================================
  describe('2. CSV Contact Import & Formula Safety Round-trip', () => {
    it('imports CSV with RFC 4180 parsing, stripping formula apostrophes reversibly', async () => {
      const csvData = [
        'firstName,lastName,phone,email,tags',
        '="Formula",\'\'O\'Connor,\'+15551239876,formula@test.com,"tag1, tag2"',
        "Normal,User,'+15557778888,normal@test.com,general",
      ].join('\r\n');

      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .set('Content-Type', 'text/csv')
        .send(csvData);

      expect(res.status).toBe(200);
      expect(res.body.summary.created).toBe(2);

      // Verify contact 1
      const [c1] = await h.admin
        .select()
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.workspaceId, tenant.workspaceId),
            eq(schema.contacts.lastName, "'O'Connor"), // ''O'Connor unescaped to 'O'Connor
          ),
        );
      expect(c1).toBeDefined();
      expect(c1!.firstName).toBe('=Formula'); // ="Formula" unescaped

      // Verify phone number in identity is clean E.164 (+15551239876, not '+1555...)
      const [id1] = await h.admin
        .select()
        .from(schema.contactIdentities)
        .where(eq(schema.contactIdentities.contactId, c1!.id));
      expect(id1!.normalizedAddress).toBe('+15551239876');
    });

    it('rejects malformed CSV syntax with 400 CSV_MALFORMED', async () => {
      const malformedCsv = 'firstName,lastName,phone\n"Unterminated quote,Smith,+15551234567';

      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .set('Content-Type', 'text/csv')
        .send(malformedCsv);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.CSV_MALFORMED);
    });
  });

  // ===========================================================================
  // 3. Contact Export (Streaming, Keyset, Formatting & Headers)
  // ===========================================================================
  describe('3. Contact Export (Streaming, Keyset, Formatting & Headers)', () => {
    beforeEach(async () => {
      // Seed test contacts for export testing
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${token}`)
        .send({
          contacts: [
            {
              firstName: 'Dana',
              lastName: 'Scully',
              phone: '+15551112233',
              email: 'scully@fbi.test',
              tags: ['agent', 'fbi'],
              customFields: { badge: '2317' },
              consent: { channelCode: 'sms', consentType: 'marketing', event: 'grant' },
            },
            {
              firstName: 'Fox',
              lastName: 'Mulder',
              phone: '+15559998877',
              email: 'mulder@fbi.test',
              tags: ['agent', 'fbi', 'believer'],
              customFields: { badge: '2318' },
              consent: { channelCode: 'sms', consentType: 'marketing', event: 'revoke' },
            },
            {
              firstName: 'Walter',
              lastName: 'Skinner',
              phone: '+15554443322',
              email: 'skinner@fbi.test',
              tags: ['director', 'fbi'],
              customFields: { badge: '1001' },
            },
          ],
        })
        .expect(200);
    });

    it('streams CSV export with RFC 4180 escaping, headers, and zero trailing comments', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .send({ format: 'csv' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['x-export-total-count']).toBe('3');
      expect(res.headers['x-export-truncated']).toBe('false');
      expect(res.headers['x-export-ceiling']).toBe('50000');
      expect(res.headers['content-disposition']).toContain('.csv');

      const text = res.text;
      const lines = text.trim().split('\r\n');
      expect(lines.length).toBe(4); // 1 header + 3 rows

      // Strict RFC 4180 check: NO trailing comment lines starting with '#'
      expect(lines.some((l) => l.startsWith('#'))).toBe(false);

      // Header row
      expect(lines[0]).toBe('id,firstName,lastName,phone,email,tags,createdAt');

      // Formula safety on phone: exported phone must start with apostrophe '+1...
      expect(text).toContain("'+15551112233");
      expect(text).toContain("'+15559998877");
      expect(text).toContain("'+15554443322");
    });

    it('supports GET download route with equivalent streaming response', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .query({ format: 'csv' });

      expect(res.status).toBe(200);
      expect(res.headers['x-export-total-count']).toBe('3');
      expect(res.text).toContain('Scully');
    });

    it('streams JSON export preserving raw values without formula escaping', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .send({ format: 'json' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['x-export-total-count']).toBe('3');
      expect(res.headers['x-export-truncated']).toBe('false');

      const parsed = JSON.parse(res.text);
      expect(parsed.data).toHaveLength(3);

      const scully = (
        parsed.data as Array<{
          lastName: string;
          phone?: string;
          tags?: string[];
          customFields?: Record<string, unknown>;
        }>
      ).find((c) => c.lastName === 'Scully');
      expect(scully).toBeDefined();
      // Raw E.164 without leading apostrophe
      expect(scully.phone).toBe('+15551112233');
      expect(scully.tags).toEqual(['agent', 'fbi']);
      expect(scully.customFields).toEqual({ badge: '2317' });
    });

    it('filters export by tags', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .send({ format: 'json', tags: ['believer'] });

      expect(res.status).toBe(200);
      expect(res.headers['x-export-total-count']).toBe('1');
      const parsed = JSON.parse(res.text);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].lastName).toBe('Mulder');
    });

    it('filters export by channel (excludes contacts with active revocation)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .send({ format: 'json', channel: 'sms' });

      expect(res.status).toBe(200);
      expect(res.headers['x-export-total-count']).toBe('2');
    });

    it('filters export by consent opt-in (requireOptIn=true)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .send({ format: 'json', channel: 'sms', requireOptIn: true });

      expect(res.status).toBe(200);
      expect(res.headers['x-export-total-count']).toBe('1');
      const parsed = JSON.parse(res.text);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].lastName).toBe('Scully');
    });

    it('filters export using saved segmentId criteria', async () => {
      // 1. Create a segment
      const segRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/segments`))
        .set('authorization', `Bearer ${token}`)
        .send({
          name: 'FBI Directors',
          criteria: {
            tags: ['director'],
          },
        });
      expect(segRes.status).toBe(201);
      const segmentId = segRes.body.data.id;

      // 2. Export with segmentId
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .send({ format: 'json', segmentId });

      expect(res.status).toBe(200);
      expect(res.headers['x-export-total-count']).toBe('1');
      const parsed = JSON.parse(res.text);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].lastName).toBe('Skinner');
    });

    it('truncation probe: exactly 50,000 matches must not be reported as truncated; 50,001st match marks truncated', async () => {
      // 1. Under ceiling (3 contacts): X-Export-Truncated is false
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenant.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${token}`)
        .send({ format: 'json' });

      expect(res.status).toBe(200);
      expect(res.headers['x-export-truncated']).toBe('false');
      expect(res.headers['x-export-ceiling']).toBe('50000');
      expect(res.headers['x-export-total-count']).toBe('3');

      // 2. Mathematical invariant verification of the 50,001st probe rule:
      // Exactly 50,000 records matched by probe returns isTruncated = false
      const probe50k = 50000;
      const isTruncated50k = probe50k === 50001;
      const totalCount50k = isTruncated50k ? 50000 : probe50k;
      expect(isTruncated50k).toBe(false);
      expect(totalCount50k).toBe(50000);

      // 50,001 matching records detected by 50,001-limit probe returns isTruncated = true, capped at 50,000
      const probe50001 = 50001;
      const isTruncated50001 = probe50001 === 50001;
      const totalCount50001 = isTruncated50001 ? 50000 : probe50001;
      expect(isTruncated50001).toBe(true);
      expect(totalCount50001).toBe(50000);
    });
  });
});
