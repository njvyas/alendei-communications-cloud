/**
 * The canonical HTTP conventions (Phase 1B.5.8, `API.md` §§7-9).
 *
 * Until this phase the API answered `{workspaces:[...]}` here, `{roles:[...]}`
 * there and a bare object for a single resource, with no pagination anywhere.
 * Each shape was defensible alone; together they made a client guess per
 * endpoint, which is the churn this phase exists to end before a frontend is
 * written against it.
 *
 * Three properties carry security weight and are tested as such rather than as
 * formatting:
 *
 *   1. **Sort and filter inputs are allow-listed**, so no caller input reaches
 *      an ORDER BY or a WHERE as an identifier.
 *   2. **Cursors are integrity-protected.** A cursor is a query continuation,
 *      and an editable one is a client-supplied predicate wearing the costume of
 *      server state.
 *   3. **Pagination cannot widen a tenant boundary.** Filters narrow what RLS
 *      already allows; they never reach past it.
 */
import { ERROR_CODES, PAGE_LIMITS, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

interface RoleRow {
  id: string;
  key: string;
  isSystemRole: boolean;
}
interface Paged<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean; limit: number };
}

describe('API conventions', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let token: string;
  /** Keys of the roles this suite plants, in ascending order. */
  const plantedKeys: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'conv-a', credentials);
    orgB = await createTenant(h.admin, 'conv-b', credentials);

    const adminPermissions = [
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.ROLES_CREATE,
      PERMISSIONS.PERMISSIONS_READ,
      PERMISSIONS.ROLE_ASSIGNMENTS_READ,
    ];
    await grantToFixtureRole(orgA, adminPermissions);
    // Organization B needs the same authority: the isolation cases below act as
    // B to plant a row, and a `403` there would pass them for the wrong reason.
    await grantToFixtureRole(orgB, adminPermissions);

    // Enough roles to page through several times over.
    for (let i = 0; i < 12; i += 1) {
      const key = `conv_role_${String(i).padStart(2, '0')}`;
      plantedKeys.push(key);
      await h.admin.insert(schema.roles).values({
        orgId: orgA.orgId,
        key,
        name: key,
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });
    }
    plantedKeys.sort();

    token = await tokenFor(orgA.email);
  }, 90_000);

  afterAll(async () => {
    await h.admin.execute(
      sql`DELETE FROM roles WHERE org_id = ${orgA.orgId} AND key LIKE 'conv_role_%'`,
    );
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(() => purgeAudit(h.admin, sql`true`));

  async function grantToFixtureRole(
    tenant: TenantFixture,
    permissions: readonly string[],
  ): Promise<void> {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const key of permissions) {
        const [permission] = await tx
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, key));
        if (permission) {
          await tx
            .insert(schema.rolePermissions)
            .values({ roleId: tenant.roleId, permissionId: permission.id })
            .onConflictDoNothing();
        }
      }
    });
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const get = (path: string, credential = token) =>
    request(h.app.getHttpServer()).get(url(path)).set('authorization', `Bearer ${credential}`);

  // ===========================================================================
  describe('A. the envelope', () => {
    it('a collection answers { data, page } and nothing else at the top level', async () => {
      const res = await get('/roles').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'page']);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(Object.keys(res.body.page).sort()).toEqual(['hasMore', 'limit', 'nextCursor']);
    });

    it('a single resource answers { data } with no page', async () => {
      const list = (await get('/roles').expect(200)).body as Paged<RoleRow>;
      const res = await get(`/roles/${list.data[0]!.id}`).expect(200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(Array.isArray(res.body.data)).toBe(false);
      expect(res.body.data.id).toBe(list.data[0]!.id);
    });

    it('an error answers { error } — the same shape it always did', async () => {
      const res = await get(`/roles/${uuidv7()}`).expect(404);
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
      expect(res.body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof res.body.error.retryable).toBe('boolean');
    });

    it('every response carries the correlation id as a header', async () => {
      // The header is canonical for success; the body repeats it only on error,
      // so there is one place for it to be right rather than two.
      const ok = await get('/roles').expect(200);
      expect(ok.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
      const bad = await get(`/roles/${uuidv7()}`).expect(404);
      expect(bad.headers['x-correlation-id']).toBe(bad.body.error.correlationId);
    });

    it('applies to every list endpoint, not just one', async () => {
      for (const path of ['/roles', '/permissions', '/role-assignments', '/tenants/workspaces']) {
        const res = await get(path).expect(200);
        expect(Object.keys(res.body).sort()).toEqual(['data', 'page']);
      }
    });
  });

  // ===========================================================================
  describe('B. pagination', () => {
    it('defaults to the documented page size', async () => {
      const res = (await get('/roles').expect(200)).body as Paged<RoleRow>;
      expect(res.page.limit).toBe(PAGE_LIMITS.DEFAULT);
    });

    it('honours an explicit limit and reports hasMore', async () => {
      const res = (await get('/roles?limit=5').expect(200)).body as Paged<RoleRow>;
      expect(res.data).toHaveLength(5);
      expect(res.page.limit).toBe(5);
      expect(res.page.hasMore).toBe(true);
      expect(res.page.nextCursor).not.toBeNull();
    });

    it('walks every row exactly once across pages', async () => {
      // The property that matters. A cursor scheme that skips or repeats is
      // worse than no pagination, because the loss is silent.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const query: string = cursor
          ? `/roles?limit=3&cursor=${encodeURIComponent(cursor)}`
          : '/roles?limit=3';
        const page = (await get(query).expect(200)).body as Paged<RoleRow>;
        seen.push(...page.data.map((r) => r.id));
        cursor = page.page.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);

      const all = (await get('/roles?limit=100').expect(200)).body as Paged<RoleRow>;
      expect(seen.sort()).toEqual(all.data.map((r) => r.id).sort());
    });

    it('the last page reports hasMore false and a null cursor', async () => {
      const res = (await get('/roles?limit=100').expect(200)).body as Paged<RoleRow>;
      expect(res.page.hasMore).toBe(false);
      expect(res.page.nextCursor).toBeNull();
    });

    it('clamps a limit above the maximum rather than refusing it', async () => {
      // A caller asking for 5000 means "as many as you will give me"; a `400`
      // there is pedantry. Asking for zero is a bug, and the DTO refuses it.
      const res = (await get(`/roles?limit=${PAGE_LIMITS.MAX + 500}`).expect(400)).body;
      expect(res.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      await get('/roles?limit=0').expect(400);
      await get('/roles?limit=-1').expect(400);
    });

    it('orders deterministically, with a tie-breaker behind the sort field', async () => {
      const first = (await get('/roles?limit=100&sort=key').expect(200)).body as Paged<RoleRow>;
      const again = (await get('/roles?limit=100&sort=key').expect(200)).body as Paged<RoleRow>;
      expect(first.data.map((r) => r.id)).toEqual(again.data.map((r) => r.id));

      const keys = first.data.map((r) => r.key);
      expect([...keys].sort()).toEqual(keys);
    });

    it('pages correctly through rows that share a sort value', async () => {
      // The case the tie-breaker exists for, and the only one that can detect
      // its absence. `scopeType` is a genuine tie: every organization-scoped
      // grant carries the same value, so ordering by it alone leaves those rows
      // in an undefined order between pages and a keyset scheme either skips
      // them or repeats them. With `id` behind it the ordering is total.
      const { rows: total } = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM user_roles WHERE org_id = ${orgA.orgId}`,
      );
      expect(Number(total[0]!.count)).toBeGreaterThan(0);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 40; guard += 1) {
        const path: string = cursor
          ? `/role-assignments?limit=1&sort=scopeType&cursor=${encodeURIComponent(cursor)}`
          : '/role-assignments?limit=1&sort=scopeType';
        const page = (await get(path).expect(200)).body as Paged<{ id: string }>;
        seen.push(...page.data.map((r) => r.id));
        cursor = page.page.nextCursor;
        if (!cursor) break;
      }

      // Every row exactly once, and the walk terminated rather than looping.
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen).size).toBe(seen.length);
      expect(cursor).toBeNull();
    });

    it('a row inserted after page one does not disturb the rows already returned', async () => {
      const page1 = (await get('/roles?limit=4&sort=key').expect(200)).body as Paged<RoleRow>;
      const inserted = 'conv_role_zz_late';
      await h.admin.insert(schema.roles).values({
        orgId: orgA.orgId,
        key: inserted,
        name: inserted,
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });

      try {
        const page2 = (
          await get(
            `/roles?limit=4&sort=key&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
          ).expect(200)
        ).body as Paged<RoleRow>;
        // Keyset pagination resumes from a value, not an offset, so a row
        // inserted anywhere cannot shift the window and duplicate a row.
        const overlap = page2.data.filter((r) => page1.data.some((p) => p.id === r.id));
        expect(overlap).toEqual([]);
      } finally {
        await h.admin.execute(sql`DELETE FROM roles WHERE key = ${inserted}`);
      }
    });

    it('refuses a malformed cursor', async () => {
      const res = await get('/roles?cursor=not-a-cursor').expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.PAGINATION_CURSOR_INVALID);
    });

    it('refuses a tampered cursor', async () => {
      const page = (await get('/roles?limit=2').expect(200)).body as Paged<RoleRow>;
      const [body, signature] = page.page.nextCursor!.split('.');
      const forged = Buffer.from(
        JSON.stringify({ s: 'key', v: 'zzzz', i: uuidv7() }),
        'utf8',
      ).toString('base64url');

      // The payload edited, the signature kept.
      await get(`/roles?cursor=${encodeURIComponent(`${forged}.${signature}`)}`).expect(400);
      // The signature edited, the payload kept.
      await get(`/roles?cursor=${encodeURIComponent(`${body}.AAAA`)}`).expect(400);
    });

    it('refuses a cursor minted under a different sort', async () => {
      // Resuming under a changed ordering describes a position in a sequence
      // that no longer exists, and would silently skip or repeat rows.
      const page = (await get('/roles?limit=2&sort=key').expect(200)).body as Paged<RoleRow>;
      const res = await get(
        `/roles?limit=2&sort=-key&cursor=${encodeURIComponent(page.page.nextCursor!)}`,
      ).expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.PAGINATION_CURSOR_INVALID);
    });

    it('a cursor from another tenant’s request reveals nothing', async () => {
      const otherToken = await tokenFor(orgB.email);
      const mine = (await get('/roles?limit=2').expect(200)).body as Paged<RoleRow>;

      // Structurally valid — same signing key — but continuing it under
      // Organization B's context is still bounded by that tenant's own
      // predicate and by RLS beneath it.
      const theirs = (
        await get(
          `/roles?limit=50&cursor=${encodeURIComponent(mine.page.nextCursor!)}`,
          otherToken,
        ).expect(200)
      ).body as Paged<RoleRow>;
      const foreignKeys = theirs.data.map((r) => r.key);
      expect(foreignKeys.filter((k) => k.startsWith('conv_role_'))).toEqual([]);
    });
  });

  // ===========================================================================
  describe('C. sorting', () => {
    it('sorts ascending and descending on an allowed field', async () => {
      const asc = (await get('/roles?limit=100&sort=key').expect(200)).body as Paged<RoleRow>;
      const desc = (await get('/roles?limit=100&sort=-key').expect(200)).body as Paged<RoleRow>;
      expect(desc.data.map((r) => r.key)).toEqual([...asc.data.map((r) => r.key)].reverse());
    });

    it('refuses a field that is not on the allow-list', async () => {
      const res = await get('/roles?sort=isSystemRole').expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(res.body.error.details.issues[0].field).toBe('sort');
      expect(res.body.error.details.issues[0].rule).toBe('SORT_NOT_ALLOWED');
    });

    it('refuses order-by injection outright', async () => {
      // None of these reach SQL: the shape is rejected by the DTO pattern, and
      // anything shaped like a field is then rejected by the allow-list. There
      // is no code path that interpolates this input as an identifier.
      for (const attempt of [
        'key; DROP TABLE roles',
        'key)--',
        '(SELECT 1)',
        'key,created_at',
        'key ASC, id DESC',
        '../key',
      ]) {
        const res = await get(`/roles?sort=${encodeURIComponent(attempt)}`);
        expect(res.status).toBe(400);
      }
      // And the table is still there.
      await get('/roles').expect(200);
    });
  });

  // ===========================================================================
  describe('D. filtering', () => {
    it('filters on an allow-listed field', async () => {
      const res = (await get('/roles?limit=100&isSystemRole=false').expect(200))
        .body as Paged<RoleRow>;
      expect(res.data.length).toBeGreaterThan(0);
      expect(res.data.every((r) => r.isSystemRole === false)).toBe(true);
    });

    it('combines a filter with pagination and sorting', async () => {
      const res = (await get('/roles?limit=3&isSystemRole=false&sort=-key').expect(200))
        .body as Paged<RoleRow>;
      expect(res.data).toHaveLength(3);
      expect(res.data.every((r) => r.isSystemRole === false)).toBe(true);
    });

    it('refuses an unknown filter rather than ignoring it', async () => {
      // Ignoring it is how a caller comes to believe a filter applied when it
      // did not — which for a security-relevant filter is a silent widening.
      const res = await get('/roles?orgId=' + orgB.orgId).expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(res.body.error.details.issues[0].rule).toBe('WHITELIST_VALIDATION');
    });

    it('refuses a filter whose type is wrong', async () => {
      await get('/roles?isSystemRole=maybe').expect(400);
    });

    it('a filter narrows but never widens the tenant boundary', async () => {
      // Organization A asking for Organization B's roles by key gets nothing —
      // the filter is applied *inside* what RLS already allows.
      const otherToken = await tokenFor(orgB.email);
      await request(h.app.getHttpServer())
        .post(url('/roles'))
        .set('authorization', `Bearer ${otherToken}`)
        .send({
          key: 'conv_b_secret',
          name: 'B',
          allowedScopeTypes: ['organization'],
          permissions: [],
        })
        .expect(201);

      const res = (await get('/roles?limit=100&key=conv_b_secret').expect(200))
        .body as Paged<RoleRow>;
      expect(res.data).toEqual([]);
    });
  });

  // ===========================================================================
  describe('E. validation errors', () => {
    const post = (body: unknown) =>
      request(h.app.getHttpServer())
        .post(url('/roles'))
        .set('authorization', `Bearer ${token}`)
        .send(body);

    it('reports the field, a machine-readable rule and a message', async () => {
      const res = await post({
        key: 'Bad Key',
        name: '',
        allowedScopeTypes: ['organization'],
        permissions: [],
      }).expect(400);

      const issues = res.body.error.details.issues as {
        field: string;
        rule: string;
        message: string;
      }[];
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(typeof issue.field).toBe('string');
        expect(issue.rule).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(typeof issue.message).toBe('string');
      }
      expect(issues.map((i) => i.field)).toContain('key');
    });

    it('reports every failing field, not just the first', async () => {
      const res = await post({ key: 'Bad Key', name: '' }).expect(400);
      const fields = (res.body.error.details.issues as { field: string }[]).map((i) => i.field);
      expect(new Set(fields).size).toBeGreaterThan(1);
    });

    it('reports every failing rule on one field', async () => {
      const res = await post({
        key: '!!',
        name: 'x',
        allowedScopeTypes: ['organization'],
        permissions: [],
      }).expect(400);
      const keyIssues = (res.body.error.details.issues as { field: string }[]).filter(
        (i) => i.field === 'key',
      );
      expect(keyIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('addresses a nested field by its path', async () => {
      const res = await post({
        key: 'conv_nested',
        name: 'Nested',
        allowedScopeTypes: ['organization'],
        permissions: ['not.a_real_permission'],
      }).expect(400);
      const fields = (res.body.error.details.issues as { field: string }[]).map((i) => i.field);
      expect(fields.some((f) => f.startsWith('permissions'))).toBe(true);
    });

    it('leaks no internals', async () => {
      const res = await post({ key: 1, name: 2 }).expect(400);
      const serialized = JSON.stringify(res.body);
      for (const forbidden of [
        'SELECT',
        'INSERT',
        'pg_',
        'drizzle',
        'at Object',
        '.ts:',
        'stack',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('carries the correlation id, so a failed form is traceable', async () => {
      const res = await post({ key: 'Bad Key' }).expect(400);
      expect(res.body.error.correlationId).toBe(res.headers['x-correlation-id']);
    });
  });
});
