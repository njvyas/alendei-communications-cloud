/**
 * Issue #30 (QAF-019): the console lists a workspace's contacts newest first
 * through the existing list contract, `sort=-createdAt` — no API change.
 *
 * Pins what the console now relies on: descending keyset pagination is total
 * and deterministic, a contact created after the first page was read appears
 * first, the default order (oldest first) is unchanged for other clients, and
 * the descending walk never crosses a workspace or an organization.
 */
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq } from 'drizzle-orm';
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

interface Page {
  readonly ids: string[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

describe('Issue #30: contacts listed newest first (sort=-createdAt)', () => {
  let h: Harness;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let otherWorkspaceA: string;
  /** Tenant A default-workspace contacts, in creation order. */
  const created: string[] = [];
  const otherWorkspaceContacts: string[] = [];

  const login = async (email: string) =>
    (
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;

  const createContact = async (token: string, workspaceId: string, firstName: string) =>
    (
      await request(h.app.getHttpServer())
        .post(url(`/workspaces/${workspaceId}/contacts`))
        .set('authorization', `Bearer ${token}`)
        .send({ firstName })
        .expect(201)
    ).body.data.id as string;

  const list = (
    token: string,
    workspaceId: string,
    query: { sort?: string; limit?: number; cursor?: string },
  ) =>
    request(h.app.getHttpServer())
      .get(url(`/workspaces/${workspaceId}/contacts`))
      .query(query)
      .set('authorization', `Bearer ${token}`);

  const page = async (
    token: string,
    workspaceId: string,
    query: { sort?: string; limit?: number; cursor?: string },
  ): Promise<Page> => {
    const res = await list(token, workspaceId, query).expect(200);
    return {
      ids: (res.body.data as { id: string }[]).map((c) => c.id),
      nextCursor: res.body.page.nextCursor,
      hasMore: res.body.page.hasMore,
    };
  };

  /** Every page of a listing, following `nextCursor` to the end. */
  const walk = async (token: string, workspaceId: string, sort: string, limit: number) => {
    const pages: Page[] = [];
    let cursor: string | undefined;
    do {
      const p = await page(token, workspaceId, { sort, limit, cursor });
      pages.push(p);
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    tenantA = await createTenant(h.admin, 'i30-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'i30-tenant-b', credentials);
    // The harness role carries no contacts permissions: grant contacts.read and
    // contacts.manage at organization scope, as the Phase 3.1 suite does.
    for (const tenant of [tenantA, tenantB]) {
      const roleId = uuidv7();
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: tenant.orgId,
        key: `i30_contacts_${tenant.slug.replace(/-/g, '_')}`,
        name: `i30_contacts_${tenant.slug}`,
        description: 'Issue 30 test role',
        isSystemRole: false,
        allowedScopeTypes: ['organization', 'workspace'],
      });
      for (const key of [PERMISSIONS.CONTACTS_READ, PERMISSIONS.CONTACTS_MANAGE]) {
        const [permission] = await h.admin
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, key));
        await h.admin
          .insert(schema.rolePermissions)
          .values({ roleId, permissionId: permission!.id });
      }
      await h.admin.insert(schema.userRoles).values({
        orgId: tenant.orgId,
        userId: tenant.userId,
        roleId,
        scopeType: 'organization',
        scopeId: tenant.orgId,
      });
    }
    const [ws] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: tenantA.orgId, name: 'Second', slug: 'i30-second' })
      .returning({ id: schema.workspaces.id });
    otherWorkspaceA = ws!.id;

    tokenA = await login(tenantA.email);
    tokenB = await login(tenantB.email);

    // Sequential, so creation order is id order (uuidv7).
    for (let i = 1; i <= 7; i++) {
      created.push(await createContact(tokenA, tenantA.workspaceId, `I30 A${i}`));
    }
    for (let i = 1; i <= 2; i++) {
      otherWorkspaceContacts.push(await createContact(tokenA, otherWorkspaceA, `I30 W${i}`));
    }
    await createContact(tokenB, tenantB.workspaceId, 'I30 B1');
  }, 60_000);

  afterAll(async () => {
    await destroyTenant(h.admin, tenantA);
    await destroyTenant(h.admin, tenantB);
    await h.close();
  }, 60_000);

  it('walks a workspace newest first: every contact exactly once, in descending creation order', async () => {
    const pages = await walk(tokenA, tenantA.workspaceId, '-createdAt', 3);

    expect(pages.map((p) => p.ids.length)).toEqual([3, 3, 1]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(pages.flatMap((p) => p.ids)).toEqual([...created].reverse());
  });

  it('is deterministic: re-reading a page with the same cursor returns the same contacts', async () => {
    const first = await page(tokenA, tenantA.workspaceId, { sort: '-createdAt', limit: 3 });
    const again = await page(tokenA, tenantA.workspaceId, { sort: '-createdAt', limit: 3 });
    expect(again).toEqual(first);

    const second = await page(tokenA, tenantA.workspaceId, {
      sort: '-createdAt',
      limit: 3,
      cursor: first.nextCursor!,
    });
    const secondAgain = await page(tokenA, tenantA.workspaceId, {
      sort: '-createdAt',
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(secondAgain).toEqual(second);
  });

  it('shows a newly created contact first on the first page, even with more contacts than one page holds', async () => {
    const before = await page(tokenA, tenantA.workspaceId, { sort: '-createdAt', limit: 3 });
    const fresh = await createContact(tokenA, tenantA.workspaceId, 'I30 A-new');
    created.push(fresh);

    const after = await page(tokenA, tenantA.workspaceId, { sort: '-createdAt', limit: 3 });
    expect(before.ids).not.toContain(fresh);
    expect(after.ids[0]).toBe(fresh);
    expect(after.ids.slice(1)).toEqual(before.ids.slice(0, 2));
  });

  it('leaves the default order unchanged for other clients (oldest first)', async () => {
    const pages = await walk(tokenA, tenantA.workspaceId, 'createdAt', 4);
    expect(pages.flatMap((p) => p.ids)).toEqual(created);

    const unsorted = await page(tokenA, tenantA.workspaceId, { limit: 100 });
    expect(unsorted.ids).toEqual(created);
  });

  it('refuses a cursor issued for the other direction instead of mixing orders', async () => {
    const asc = await page(tokenA, tenantA.workspaceId, { sort: 'createdAt', limit: 3 });
    const res = await list(tokenA, tenantA.workspaceId, {
      sort: '-createdAt',
      limit: 3,
      cursor: asc.nextCursor!,
    }).expect(400);
    expect(res.body.error.code).toBe(ERROR_CODES.PAGINATION_CURSOR_INVALID);
  });

  it('stays inside the workspace: another workspace of the same organization is listed separately', async () => {
    const main = (await walk(tokenA, tenantA.workspaceId, '-createdAt', 3)).flatMap((p) => p.ids);
    for (const id of otherWorkspaceContacts) expect(main).not.toContain(id);

    const other = (await walk(tokenA, otherWorkspaceA, '-createdAt', 3)).flatMap((p) => p.ids);
    expect(other).toEqual([...otherWorkspaceContacts].reverse());
  });

  it('stays inside the organization: another tenant cannot list this workspace newest first', async () => {
    const res = await list(tokenB, tenantA.workspaceId, { sort: '-createdAt', limit: 3 }).expect(
      404,
    );
    expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(res.body.data).toBeUndefined();

    const own = (await walk(tokenB, tenantB.workspaceId, '-createdAt', 3)).flatMap((p) => p.ids);
    expect(own).toHaveLength(1);
    for (const id of created) expect(own).not.toContain(id);
  });
});
