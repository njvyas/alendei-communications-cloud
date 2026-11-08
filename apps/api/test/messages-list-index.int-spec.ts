/**
 * U14.1a — `GET /messages` on `messages_org_id_id_desc_idx (org_id, id DESC)`.
 *
 * No API, DTO, OpenAPI or cursor change: this suite pins that the listing is
 * behaviourally identical (order, cursor continuation, page size, `hasMore`,
 * UUIDv7 ids, tenant isolation) on a dense and a sparse tenant, and that the
 * EXACT statement `MessagesService.listMessages` sends — captured on the wire,
 * then explained on the same connection, inside the same request transaction,
 * as the application role with the request's tenant settings and RLS — is
 * served by the new index with no sort, for the first page and a cursor page.
 *
 * The cost-based comparison (before/after, custom vs generic plans, buffers)
 * is recorded as evidence outside the suite; this test is structural.
 */
import { randomBytes } from 'node:crypto';
import { PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { Client, type QueryConfig } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;
const INDEX = 'messages_org_id_id_desc_idx';
const DENSE = 12_000;
// One sparse message per 30 dense ones, interleaved in time (~400 rows). With only a few dozen
// rows a bitmap scan plus a top-N sort is the cheaper plan, and the planner rightly picks it.
const SPARSE_EVERY = 30;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Scan Direction'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}
interface Captured {
  readonly text: string;
  readonly values: unknown[];
  readonly plan: PlanNode;
}

const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
/** Scans of `messages` in the main plan (the select-list sub-queries scan `message_attempts`). */
const messageScans = (plan: PlanNode) =>
  nodes(plan).filter((n) => n['Relation Name'] === 'messages');

describe('U14.1a: GET /messages on (org_id, id DESC) — behaviour unchanged, plan uses the index', () => {
  let h: Harness;
  let dense: TenantFixture;
  let sparse: TenantFixture;
  let denseToken: string;
  let sparseToken: string;
  let channelId: string;
  /** Expected listings, newest first (UUIDv7 order = creation order). */
  let denseIds: string[] = [];
  let sparseIds: string[] = [];

  /**
   * Captures the list statement on the wire. After the application's own query
   * returns, the same text and values are explained on the same client — still
   * inside the request's tenant transaction, as the application role.
   */
  const captured: Captured[] = [];
  /** The organization whose list statements are captured, or false. */
  let capture: string | false = false;
  const original = Client.prototype.query;

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    dense = await createTenant(h.admin, 'u141a-dense', credentials);
    sparse = await createTenant(h.admin, 'u141a-sparse', credentials);

    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'))
      .limit(1);
    if (!c) throw new Error('whatsapp channel missing from the seeded catalogue');
    channelId = c.id;

    const [perm] = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.MESSAGES_READ));
    const contactOf = new Map<string, string>();
    for (const tenant of [dense, sparse]) {
      const roleId = uuidv7();
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: tenant.orgId,
        key: `u141a_${randomBytes(4).toString('hex')}`,
        name: 'Messages Reader',
        description: 'messages.read only',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      });
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId: perm!.id, orgId: tenant.orgId });
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.insert(schema.userRoles).values({
          userId: tenant.userId,
          roleId,
          scopeType: 'organization',
          scopeId: tenant.orgId,
        });
      });
      const contactId = uuidv7();
      await h.admin.insert(schema.contacts).values({
        id: contactId,
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        displayName: 'U14.1a',
      });
      contactOf.set(tenant.orgId, contactId);
    }

    // Interleaved in time: a backward primary-key scan for the sparse tenant
    // would have to step over ~30 dense rows per sparse row.
    const rows: (typeof schema.messages.$inferInsert)[] = [];
    for (let i = 0; i < DENSE + DENSE / SPARSE_EVERY; i += 1) {
      const tenant = i % (SPARSE_EVERY + 1) === SPARSE_EVERY ? sparse : dense;
      rows.push({
        id: uuidv7(),
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        contactId: contactOf.get(tenant.orgId)!,
        channelId,
        status: 'accepted',
        recipientAddress: '+12025550100',
        correlationId: uuidv7(),
      });
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await h.admin.insert(schema.messages).values(rows.slice(i, i + 1000));
    }
    await h.admin.execute(sql`ANALYZE public.messages`);
    const newestFirst = (orgId: string) =>
      rows
        .filter((r) => r.orgId === orgId)
        .map((r) => r.id!)
        .reverse();
    denseIds = newestFirst(dense.orgId);
    sparseIds = newestFirst(sparse.orgId);

    const login = async (email: string) => {
      await h.clearRateLimits();
      return (
        await request(h.app.getHttpServer())
          .post(url('/auth/login'))
          .send({ email, password: PASSWORD })
          .expect(200)
      ).body.data.accessToken as string;
    };
    denseToken = await login(dense.email);
    sparseToken = await login(sparse.email);

    jest.spyOn(Client.prototype, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const config = args[0] as QueryConfig | string;
      const text = typeof config === 'string' ? config : config?.text;
      // drizzle's node-postgres driver calls `query(config, params)`; a callback form is never captured.
      const isList =
        capture &&
        typeof text === 'string' &&
        /from "messages"/.test(text) &&
        /order by/.test(text) &&
        typeof args[args.length - 1] !== 'function';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (original as any).apply(this, args);
      const values = (args[1] as unknown[] | undefined) ?? (config as QueryConfig).values ?? [];
      if (!isList || values[0] !== capture) return result;
      return (async () => {
        const out = await result;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const explained = await (original as any).call(this, {
          text: `EXPLAIN (FORMAT JSON) ${text}`,
          values,
        });
        captured.push({ text, values, plan: explained.rows[0]['QUERY PLAN'][0].Plan });
        return out;
      })();
    });
  }, 120_000);

  // destroyTenant deletes each organization; its roles, role permissions and grants cascade with it.
  // Phase 7 PR 7-1: each deleted message is now checked against the ledger's RESTRICT FKs
  // across every monthly partition, so the bulk teardown needs more than the 5 s default.
  afterAll(async () => {
    jest.restoreAllMocks();
    if (!h) return;
    const orgIds = [dense?.orgId, sparse?.orgId].filter(Boolean) as string[];
    if (orgIds.length > 0) {
      await h.admin.delete(schema.messages).where(inArray(schema.messages.orgId, orgIds));
      await h.admin.delete(schema.contacts).where(inArray(schema.contacts.orgId, orgIds));
    }
    for (const tenant of [dense, sparse]) if (tenant) await destroyTenant(h.admin, tenant);
    await h.close();
  }, 120_000);

  const page = async (token: string, query: Record<string, string | number>) => {
    const res = await request(h.app.getHttpServer())
      .get(url('/messages'))
      .query(query)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return {
      ids: (res.body.data as { id: string; orgId: string }[]).map((m) => m.id),
      orgs: new Set((res.body.data as { orgId: string }[]).map((m) => m.orgId)),
      page: res.body.page as { nextCursor: string | null; hasMore: boolean; limit?: number },
    };
  };

  const walk = async (token: string, limit: number) => {
    const all: string[] = [];
    const orgs = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await page(token, cursor ? { limit, cursor } : { limit });
      all.push(...p.ids);
      p.orgs.forEach((o) => orgs.add(o));
      expect(p.ids.length).toBeLessThanOrEqual(limit);
      expect(p.page.hasMore).toBe(p.page.nextCursor !== null);
      cursor = p.page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    return { all, orgs, pages };
  };

  it('the index exists exactly once, next to messages_org_id_idx', async () => {
    const { rows } = await h.admin.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'messages' AND indexname IN (${INDEX}, 'messages_org_id_idx') ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'messages_org_id_id_desc_idx',
      'messages_org_id_idx',
    ]);
  });

  it('sparse tenant: the full walk is newest first, gap-free, repeat-free and tenant-bound', async () => {
    const { all, orgs, pages } = await walk(sparseToken, 7);
    expect(all).toEqual(sparseIds);
    expect(new Set(all).size).toBe(all.length);
    expect(pages).toBe(Math.ceil(sparseIds.length / 7));
    expect([...orgs]).toEqual([sparse.orgId]);
    for (const id of all) expect(id).toMatch(UUIDV7);
  }, 60_000);

  it('dense tenant: first page, a deep page and the last page match id DESC exactly', async () => {
    const first = await page(denseToken, { limit: 100 });
    expect(first.ids).toEqual(denseIds.slice(0, 100));
    expect(first.page.hasMore).toBe(true);
    // Follow the cursor 30 pages deep.
    let cursor = first.page.nextCursor!;
    let offset = 100;
    for (let i = 0; i < 29; i += 1) {
      const p = await page(denseToken, { limit: 100, cursor });
      expect(p.ids).toEqual(denseIds.slice(offset, offset + 100));
      expect([...p.orgs]).toEqual([dense.orgId]);
      offset += 100;
      cursor = p.page.nextCursor!;
    }
    const rest = await walk(denseToken, 100);
    expect(rest.all).toEqual(denseIds);
    expect([...rest.orgs]).toEqual([dense.orgId]);
  }, 180_000);

  it('the sparse tenant never sees a dense message and vice versa', async () => {
    const s = await page(sparseToken, { limit: 100 });
    const d = await page(denseToken, { limit: 100 });
    expect(s.ids.filter((id) => denseIds.includes(id))).toEqual([]);
    expect(d.ids.filter((id) => sparseIds.includes(id))).toEqual([]);
  });

  it('the exact listMessages statement (first page and cursor page) is served by the index, with no sort', async () => {
    captured.length = 0;
    capture = sparse.orgId;
    try {
      const first = await page(sparseToken, { limit: 5 });
      await page(sparseToken, { limit: 5, cursor: first.page.nextCursor! });
    } finally {
      capture = false;
    }
    expect(captured).toHaveLength(2);
    const [firstPage, cursorPage] = captured as [Captured, Captured];

    // The helper's compound cursor predicate is unchanged: the cursor page adds
    // `(id < $v OR (id = $v AND id < $i))` on top of the first page's statement.
    expect(firstPage.text).toMatch(/order by "messages"\."id" desc, "messages"\."id" desc/);
    expect(cursorPage.text).toMatch(
      /\("messages"\."id" < \$\d+ or \("messages"\."id" = \$\d+ and "messages"\."id" < \$\d+\)\)/,
    );

    for (const { plan } of [firstPage, cursorPage]) {
      expect(nodes(plan).map((n) => n['Node Type'])).not.toContain('Sort');
      const scans = messageScans(plan);
      expect(scans).toHaveLength(1);
      expect(scans[0]).toMatchObject({ 'Node Type': 'Index Scan', 'Index Name': INDEX });
      expect(scans[0]!['Index Cond']).toMatch(/org_id = /);
    }
    // Custom plan: the cursor folds to a seek on the index.
    expect(messageScans(cursorPage.plan)[0]!['Index Cond']).toMatch(/id < /);
  });
});
