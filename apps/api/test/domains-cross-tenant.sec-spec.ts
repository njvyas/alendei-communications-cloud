/**
 * U12 organization-domain and branding routes: cross-tenant addressing (QA defect D-1).
 *
 * Before the fix every `/organizations/:id/domains…` and `/organizations/:id/branding`
 * route opened a tenant session for the PATH organization and asserted with the raw
 * principal. Under `@NoTenantContext()` an organization member has no resolved scope,
 * so its refusal could not be audited and the request failed with `500 INTERNAL_ERROR`
 * — while a nonexistent id answered `404`, revealing which organizations exist.
 *
 * The routes now address the organization exactly as `/organizations/:id` does
 * (`addressOrganization`): a caller not connected to it gets the same `404` as for an
 * organization that does not exist, before any tenant session is opened; a caller
 * connected to it is placed in it, so a refusal there is audited at the actor's own
 * scope. Every check runs over HTTP against the real database, with no stubbing.
 */
import { randomBytes } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  PLATFORM_ROLE_KEYS,
  TENANT_ROLE_KEYS,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, suffix, url, type Org, type Person } from './revocation-fixtures';

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Route {
  readonly name: string;
  readonly method: Method;
  readonly path: (orgId: string, domainId: string) => string;
  readonly body?: Record<string, unknown>;
}

/** Every per-organization U12 route (`domains.controller.ts`), reads and mutations. */
const ROUTES: readonly Route[] = [
  { name: 'list domains', method: 'get', path: (o) => `/organizations/${o}/domains` },
  {
    name: 'register domain',
    method: 'post',
    path: (o) => `/organizations/${o}/domains`,
    body: { domain: `probe-${suffix()}.example.com`, domainType: 'custom' },
  },
  {
    name: 'verification details',
    method: 'get',
    path: (o, d) => `/organizations/${o}/domains/${d}/verification`,
  },
  {
    name: 'regenerate challenge',
    method: 'post',
    path: (o, d) => `/organizations/${o}/domains/${d}/challenge`,
  },
  { name: 'verify', method: 'post', path: (o, d) => `/organizations/${o}/domains/${d}/verify` },
  {
    name: 'set primary',
    method: 'post',
    path: (o, d) => `/organizations/${o}/domains/${d}/primary`,
  },
  { name: 'remove', method: 'delete', path: (o, d) => `/organizations/${o}/domains/${d}` },
  {
    name: 'suspend',
    method: 'post',
    path: (o, d) => `/organizations/${o}/domains/${d}/suspend`,
    body: { reason: 'cross-tenant probe' },
  },
  {
    name: 'activate',
    method: 'post',
    path: (o, d) => `/organizations/${o}/domains/${d}/activate`,
    body: { reason: 'cross-tenant probe' },
  },
  { name: 'get branding', method: 'get', path: (o) => `/organizations/${o}/branding` },
  {
    name: 'update branding',
    method: 'patch',
    path: (o) => `/organizations/${o}/branding`,
    body: { brandName: 'Hijacked by A' },
  },
];

const SECRET_BRAND = `B-SECRET-BRAND-${suffix()}`;
const SECRET_DOMAIN = `b-private-${suffix()}.example.com`;
const SECRET_CHALLENGE = `acc-domain-verification=b-secret-${suffix()}`;

describe('U12 domains and branding — cross-tenant addressing (D-1)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let A: Org;
  let B: Org;
  let adminA: Person;
  let readerA: Person;
  let adminB: Person;
  let support: Person;
  let superAdmin: Person;
  const token: Record<string, string> = {};
  let domainB: string;

  const call = (
    who: string,
    route: Route,
    orgId: string,
    domainId: string,
    header?: string | null,
  ) => {
    let req = request(h.app.getHttpServer())
      [route.method](url(route.path(orgId, domainId)))
      .set('authorization', `Bearer ${token[who]}`)
      .set('idempotency-key', `d1-${uuidv7()}`);
    if (header !== undefined && header !== null) req = req.set('x-acc-organization', header);
    return route.body ? req.send(route.body) : req;
  };

  const snapshotB = async () => {
    const domains = await h.admin
      .select({
        id: schema.organizationDomains.id,
        domain: schema.organizationDomains.domain,
        status: schema.organizationDomains.status,
        verificationValue: schema.organizationDomains.verificationValue,
        verificationStatus: schema.organizationDomains.verificationStatus,
        isPrimary: schema.organizationDomains.isPrimary,
        updatedAt: schema.organizationDomains.updatedAt,
      })
      .from(schema.organizationDomains)
      .where(eq(schema.organizationDomains.orgId, B.orgId));
    const [org] = await h.admin
      .select({ brandConfig: schema.organizations.brandConfig })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, B.orgId));
    return { domains, brandConfig: org!.brandConfig };
  };

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('d1-domains');
    A = await w.org('d1-a');
    B = await w.org('d1-b');
    adminA = await w.admin(A, 'd1-admin-a');
    adminB = await w.admin(B, 'd1-admin-b');
    readerA = await w.person('d1-reader-a');
    await w.grant(readerA.userId, A.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', A.orgId);
    support = await w.person('d1-support');
    await w.grant(
      support.userId,
      await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    superAdmin = await w.superAdmin('d1-super');

    await h.admin
      .update(schema.organizations)
      .set({ brandConfig: { brandName: SECRET_BRAND } })
      .where(eq(schema.organizations.id, B.orgId));
    const [d] = await h.admin
      .insert(schema.organizationDomains)
      .values({
        orgId: B.orgId,
        domain: SECRET_DOMAIN,
        domainType: 'custom',
        status: 'pending_verification',
        verificationMethod: 'dns_txt',
        verificationValue: SECRET_CHALLENGE,
        verificationStatus: 'pending',
      })
      .returning({ id: schema.organizationDomains.id });
    domainB = d!.id;

    for (const [k, p] of Object.entries({ adminA, readerA, adminB, support, superAdmin })) {
      token[k] = await w.login(p.email);
    }
  }, 120_000);

  afterAll(async () => {
    const orgs = [A?.orgId, B?.orgId].filter(Boolean) as string[];
    if (orgs.length > 0) {
      await h.admin
        .delete(schema.organizationDomains)
        .where(inArray(schema.organizationDomains.orgId, orgs));
    }
    await purgeAudit(h.admin, sql`org_id IN (${A.orgId}, ${B.orgId})`);
    await w.teardown();
    await h.close();
  }, 120_000);

  it('1. every route: a member of A addressing B gets the same 404 as a nonexistent organization — never 500', async () => {
    const before = await snapshotB();
    const missing = uuidv7();
    for (const route of ROUTES) {
      const cross = await call('adminA', route, B.orgId, domainB);
      const absent = await call('adminA', route, missing, uuidv7());
      expect({ route: route.name, status: cross.status, code: cross.body.error?.code }).toEqual({
        route: route.name,
        status: 404,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
      });
      // Indistinguishable from an organization that does not exist.
      expect({ route: route.name, status: absent.status, code: absent.body.error?.code }).toEqual({
        route: route.name,
        status: cross.status,
        code: cross.body.error?.code,
      });
      expect(absent.body.error?.message).toBe(cross.body.error?.message);
      const text = JSON.stringify(cross.body);
      for (const secret of [SECRET_BRAND, SECRET_DOMAIN, SECRET_CHALLENGE, domainB]) {
        expect({ route: route.name, leaked: text.includes(secret) }).toEqual({
          route: route.name,
          leaked: false,
        });
      }
    }
    // Nothing in B changed, and nothing was written in B's audit trail by A.
    expect(await snapshotB()).toEqual(before);
    const rowsInB = await h.admin
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.orgId, B.orgId),
          inArray(schema.auditLogs.actorUserId, [adminA.userId, readerA.userId]),
        ),
      );
    expect(rowsInB).toEqual([]);
  });

  it('2. the X-Acc-Organization header changes nothing: absent, own, target, unknown or malformed', async () => {
    const list = ROUTES[0]!;
    const branding = ROUTES.find((r) => r.name === 'get branding')!;
    for (const route of [list, branding]) {
      for (const header of [null, A.orgId, B.orgId, uuidv7(), 'not-a-uuid', '']) {
        const res = await call('adminA', route, B.orgId, domainB, header);
        expect({ route: route.name, header, status: res.status }).toEqual({
          route: route.name,
          header,
          status: 404,
        });
        expect(JSON.stringify(res.body)).not.toContain(SECRET_BRAND);
      }
    }
  });

  it('3. a malformed organization id in the path is 400, not 500', async () => {
    for (const route of ROUTES) {
      const res = await call('adminA', route, 'not-a-uuid', domainB);
      expect({ route: route.name, status: res.status }).toEqual({ route: route.name, status: 400 });
    }
  });

  it('4. a refusal inside the actor’s own organization is 403 and audited at that organization', async () => {
    const correlation: string[] = [];
    for (const route of ROUTES.filter(
      (r) => r.name === 'update branding' || r.name === 'register domain',
    )) {
      const res = await call('readerA', route, A.orgId, uuidv7());
      expect({ route: route.name, status: res.status, code: res.body.error?.code }).toEqual({
        route: route.name,
        status: 403,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
      });
      correlation.push(res.headers['x-correlation-id'] as string);
    }
    const rows = await h.admin
      .select({
        scopeType: schema.auditLogs.scopeType,
        scopeId: schema.auditLogs.scopeId,
        orgId: schema.auditLogs.orgId,
        actorUserId: schema.auditLogs.actorUserId,
        outcome: schema.auditLogs.outcome,
      })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, AUDIT_ACTIONS.AUTHORIZATION_DENIED),
          inArray(schema.auditLogs.correlationId, correlation),
        ),
      );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual({
        scopeType: 'organization',
        scopeId: A.orgId,
        orgId: A.orgId,
        actorUserId: readerA.userId,
        outcome: 'denied',
      });
    }
  });

  // QA defect D-2 fixed by migration 0041: acc_app holds UPDATE (brand_config) on organizations.
  it('5. legitimate same-tenant access still works: reads, a registration, a challenge rotation and branding update', async () => {
    const get = (p: string) =>
      request(h.app.getHttpServer()).get(url(p)).set('authorization', `Bearer ${token.adminB}`);
    const list = await get(`/organizations/${B.orgId}/domains`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((d: { domain: string }) => d.domain)).toContain(SECRET_DOMAIN);
    const brand = await get(`/organizations/${B.orgId}/branding`);
    expect(brand.status).toBe(200);
    expect(JSON.stringify(brand.body)).toContain(SECRET_BRAND);
    const verification = await get(`/organizations/${B.orgId}/domains/${domainB}/verification`);
    expect(verification.status).toBe(200);

    const reg = await request(h.app.getHttpServer())
      .post(url(`/organizations/${A.orgId}/domains`))
      .set('authorization', `Bearer ${token.adminA}`)
      .set('idempotency-key', `d1-${uuidv7()}`)
      .send({ domain: `a-own-${suffix()}.example.com`, domainType: 'custom' });
    expect(reg.status).toBe(201);
    const ownDomain = reg.body.data.id as string;
    const rotate = await request(h.app.getHttpServer())
      .post(url(`/organizations/${A.orgId}/domains/${ownDomain}/challenge`))
      .set('authorization', `Bearer ${token.adminA}`)
      .set('idempotency-key', `d1-${uuidv7()}`);
    expect(rotate.status).toBe(200);
    // With D-2 resolved (migration 0041 granted UPDATE (brand_config) to acc_app),
    // a same-tenant branding UPDATE now succeeds.
    const brandPatch = await request(h.app.getHttpServer())
      .patch(url(`/organizations/${A.orgId}/branding`))
      .set('authorization', `Bearer ${token.adminA}`)
      .send({ brandName: 'A New Brand Name' });
    expect(brandPatch.status).toBe(200);
    expect(brandPatch.body.data.brandName).toBe('A New Brand Name');
  });

  it('6. platform principals keep their reach: super admin and support read B; support cannot mutate', async () => {
    for (const who of ['superAdmin', 'support']) {
      const res = await request(h.app.getHttpServer())
        .get(url(`/organizations/${B.orgId}/domains`))
        .set('authorization', `Bearer ${token[who]}`);
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
    }
    const before = await snapshotB();
    const res = await call(
      'support',
      ROUTES.find((r) => r.name === 'update branding')!,
      B.orgId,
      domainB,
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    expect(await snapshotB()).toEqual(before);
    // The support principal selects B as any platform-grant holder may; its refusal is filed there.
    const [row] = await h.admin
      .select({ scopeType: schema.auditLogs.scopeType, scopeId: schema.auditLogs.scopeId })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, AUDIT_ACTIONS.AUTHORIZATION_DENIED),
          eq(schema.auditLogs.correlationId, res.headers['x-correlation-id'] as string),
        ),
      );
    expect(row).toEqual({ scopeType: 'organization', scopeId: B.orgId });
  });

  it('7. an API key and reseller administrators are bounded the same way', async () => {
    // An organization API key of A, carrying organizations.read.
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${randomBytes(16).toString('hex')}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: A.orgId,
      name: `d1-${suffix()}`,
      keyPrefix: prefix,
      keyHash: await h.app.get(CredentialService).hash(secret),
      scopes: [PERMISSIONS.ORGANIZATIONS_READ],
      createdBy: adminA.userId,
    });
    const asKey = (p: string) =>
      request(h.app.getHttpServer()).get(url(p)).set('authorization', `Bearer ${prefix}.${secret}`);
    expect((await asKey(`/organizations/${A.orgId}/domains`)).status).toBe(200);
    expect((await asKey(`/organizations/${A.orgId}/branding`)).status).toBe(200);
    for (const p of [`/organizations/${B.orgId}/domains`, `/organizations/${B.orgId}/branding`]) {
      const res = await asKey(p);
      expect({ p, status: res.status, code: res.body.error?.code }).toEqual({
        p,
        status: 404,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
      });
      for (const secret of [SECRET_BRAND, SECRET_DOMAIN, SECRET_CHALLENGE, domainB]) {
        expect(JSON.stringify(res.body)).not.toContain(secret);
      }
    }

    // A reseller administrator of B's reseller reads B; one of another reseller does not.
    const own = await w.resellerAdmin(w.resellerId, 'd1-reseller-own');
    const otherReseller = await w.reseller('d1-other');
    const other = await w.resellerAdmin(otherReseller, 'd1-reseller-other');
    const asUser = async (email: string, p: string) =>
      request(h.app.getHttpServer())
        .get(url(p))
        .set('authorization', `Bearer ${await w.login(email)}`);
    const ownRead = await asUser(own.email, `/organizations/${B.orgId}/domains`);
    expect(ownRead.status).toBe(200);
    expect(ownRead.body.data.map((d: { domain: string }) => d.domain)).toContain(SECRET_DOMAIN);
    const otherRead = await asUser(other.email, `/organizations/${B.orgId}/domains`);
    expect({ status: otherRead.status, code: otherRead.body.error?.code }).toEqual({
      status: 404,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
    });
    for (const secret of [SECRET_BRAND, SECRET_DOMAIN, SECRET_CHALLENGE, domainB]) {
      expect(JSON.stringify(otherRead.body)).not.toContain(secret);
    }
    const otherBrand = await asUser(other.email, `/organizations/${B.orgId}/branding`);
    expect(otherBrand.status).toBe(404);
    expect(JSON.stringify(otherBrand.body)).not.toContain(SECRET_BRAND);
  });

  afterEach(async () => {
    await h.clearRateLimits();
  });
});
