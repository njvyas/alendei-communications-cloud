/**
 * U14.1b — `messages_org_id_created_at_idx (org_id, created_at)` serves the statements
 * with a `created_at` range, and changes nothing else.
 *
 * No API, DTO, OpenAPI, ordering or cursor change: `GET /messages` with
 * `createdFrom`/`createdTo` still pages newest first by the UUIDv7 id (the createdAt
 * sort key IS id), with the same cursor; `GET /usage/messages` counts are unchanged;
 * tenants stay isolated. The EXACT statements the services send — captured on the wire,
 * explained on the same connection inside the request transaction (application role,
 * tenant settings, RLS) — use the new index for a sparse tenant's date window, and the
 * default listing (no window) still uses U14.1a's index, not this one.
 *
 * The plan assertions depend on the planner choosing the index for a sparse tenant's narrow window
 * (a plain or bitmap index scan is accepted); the cost-based comparison is recorded as evidence.
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
const INDEX = 'messages_org_id_created_at_idx';
const DENSE = 12_000;
const SPARSE_EVERY = 30; // ~400 sparse rows interleaved in time
const DAYS = 360;
const DAY = 86_400_000;
const END = Date.parse('2026-11-01T00:00:00.000Z');
const START = END - DAYS * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}
interface Captured {
  readonly text: string;
  readonly plan: PlanNode;
}
interface Seeded {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: number;
  readonly status: 'accepted' | 'failed';
}

const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
const messageScans = (plan: PlanNode) =>
  nodes(plan).filter((n) => n['Relation Name'] === 'messages');

describe('U14.1b: created_at range statements on (org_id, created_at) — behaviour unchanged, plan uses the index', () => {
  let h: Harness;
  let dense: TenantFixture;
  let sparse: TenantFixture;
  const tokens = new Map<string, string>();
  const rows: Seeded[] = [];
  const captured: Captured[] = [];
  /** The organization whose created_at-range statements are captured, or false. */
  let capture: string | false = false;
  const original = Client.prototype.query;

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    dense = await createTenant(h.admin, 'u141b-dense', credentials);
    sparse = await createTenant(h.admin, 'u141b-sparse', credentials);
    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'))
      .limit(1);
    if (!c) throw new Error('whatsapp channel missing from the seeded catalogue');
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
        key: `u141b_${randomBytes(4).toString('hex')}`,
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
        displayName: 'U14.1b',
      });
      contactOf.set(tenant.orgId, contactId);
    }

    // created_at spread over 360 days, monotonic with the UUIDv7 id (as in production).
    const total = DENSE + DENSE / SPARSE_EVERY;
    const inserts: (typeof schema.messages.$inferInsert)[] = [];
    for (let i = 0; i < total; i += 1) {
      const tenant = i % (SPARSE_EVERY + 1) === SPARSE_EVERY ? sparse : dense;
      const id = uuidv7();
      const createdAt = START + Math.floor((i * DAYS * DAY) / total);
      const status = i % 4 === 0 ? 'failed' : 'accepted';
      rows.push({ id, orgId: tenant.orgId, createdAt, status });
      inserts.push({
        id,
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        contactId: contactOf.get(tenant.orgId)!,
        channelId: c.id,
        status,
        failureReason: status === 'failed' ? 'NO_ELIGIBLE_PROVIDER' : null,
        recipientAddress: '+12025550100',
        correlationId: id,
        createdAt: new Date(createdAt),
      });
    }
    for (let i = 0; i < inserts.length; i += 1000) {
      await h.admin.insert(schema.messages).values(inserts.slice(i, i + 1000));
    }
    await h.admin.execute(sql`ANALYZE public.messages`);
    for (const tenant of [dense, sparse]) {
      await h.clearRateLimits();
      tokens.set(
        tenant.orgId,
        (
          await request(h.app.getHttpServer())
            .post(url('/auth/login'))
            .send({ email: tenant.email, password: PASSWORD })
            .expect(200)
        ).body.data.accessToken,
      );
    }

    jest.spyOn(Client.prototype, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const config = args[0] as QueryConfig | string;
      const text = typeof config === 'string' ? config : config?.text;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (original as any).apply(this, args);
      const values = (args[1] as unknown[] | undefined) ?? [];
      if (
        !capture ||
        typeof text !== 'string' ||
        !/(from "messages"|FROM messages m)/.test(text) ||
        !/(order by|GROUP BY)/.test(text) ||
        !values.includes(capture) ||
        typeof args[args.length - 1] === 'function'
      ) {
        return result;
      }
      return (async () => {
        const out = await result;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const explained = await (original as any).call(this, {
          text: `EXPLAIN (FORMAT JSON) ${text}`,
          values,
        });
        captured.push({ text, plan: explained.rows[0]['QUERY PLAN'][0].Plan });
        return out;
      })();
    });
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (!h) return;
    // destroyTenant deletes each organization; its roles, role permissions and grants cascade with it.
    const orgIds = [dense?.orgId, sparse?.orgId].filter(Boolean) as string[];
    if (orgIds.length > 0) {
      await h.admin.delete(schema.messages).where(inArray(schema.messages.orgId, orgIds));
      await h.admin.delete(schema.contacts).where(inArray(schema.contacts.orgId, orgIds));
    }
    for (const tenant of [dense, sparse]) if (tenant) await destroyTenant(h.admin, tenant);
    await h.close();
  });

  const get = (orgId: string, path: string, query: Record<string, string | number>) =>
    request(h.app.getHttpServer())
      .get(url(path))
      .query(query)
      .set('Authorization', `Bearer ${tokens.get(orgId)!}`)
      .expect(200);

  /** Expected listing: the tenant's rows in [from, to), newest first by id. */
  const expectedIds = (orgId: string, from: number, to: number) =>
    rows
      .filter((r) => r.orgId === orgId && r.createdAt >= from && r.createdAt < to)
      .map((r) => r.id)
      .reverse();

  const walk = async (orgId: string, from: number, to: number, limit: number) => {
    const ids: string[] = [];
    const orgs = new Set<string>();
    let cursor: string | undefined;
    do {
      const res = await get(orgId, '/messages', {
        limit,
        createdFrom: iso(from),
        createdTo: iso(to),
        ...(cursor ? { cursor } : {}),
      });
      const page = res.body.data as { id: string; orgId: string }[];
      expect(page.length).toBeLessThanOrEqual(limit);
      ids.push(...page.map((m) => m.id));
      page.forEach((m) => orgs.add(m.orgId));
      expect(res.body.page.hasMore).toBe(res.body.page.nextCursor !== null);
      cursor = res.body.page.nextCursor ?? undefined;
    } while (cursor);
    return { ids, orgs };
  };

  it('the index exists next to the U14.1a index and messages_org_id_idx', async () => {
    const { rows: found } = await h.admin.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'messages'
            AND indexname IN (${INDEX}, 'messages_org_id_id_desc_idx', 'messages_org_id_idx') ORDER BY indexname`,
    );
    expect(found.map((r) => r.indexname)).toEqual([
      'messages_org_id_created_at_idx',
      'messages_org_id_id_desc_idx',
      'messages_org_id_idx',
    ]);
  });

  it.each([
    ['sparse', 'recent 30 days', 30, 0, 4],
    ['sparse', '30 days, 200 days back', 230, 200, 4],
    ['dense', '3 days, 300 days back', 303, 300, 25],
    ['dense', 'recent 2 days', 2, 0, 25],
  ] as const)(
    '%s tenant, date window %s: newest first by id, gap-free, repeat-free, tenant-bound',
    async (who, _label, fromDaysBack, toDaysBack, limit) => {
      const tenant = who === 'sparse' ? sparse : dense;
      const from = END - fromDaysBack * DAY;
      const to = END - toDaysBack * DAY;
      const want = expectedIds(tenant.orgId, from, to);
      expect(want.length).toBeGreaterThan(limit); // more than one page
      const { ids, orgs } = await walk(tenant.orgId, from, to, limit);
      expect(ids).toEqual(want);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...orgs]).toEqual([tenant.orgId]);
    },
    60_000,
  );

  it.each([
    ['sparse', 31, 0],
    ['sparse', 187, 180],
    ['dense', 7, 0],
    ['dense', 366, 0],
  ] as const)(
    'usage report (%s tenant, %i → %i days back): totals equal the seeded rows of that tenant only',
    async (who, fromDaysBack, toDaysBack) => {
      const tenant = who === 'sparse' ? sparse : dense;
      const from = END - fromDaysBack * DAY;
      const to = END - toDaysBack * DAY;
      const mine = rows.filter(
        (r) => r.orgId === tenant.orgId && r.createdAt >= from && r.createdAt < to,
      );
      const res = await get(tenant.orgId, '/usage/messages', { from: iso(from), to: iso(to) });
      expect(res.body.data.totals.total).toBe(mine.length);
      expect(res.body.data.totals.failed).toBe(mine.filter((r) => r.status === 'failed').length);
    },
  );

  it('the exact statements: a sparse date window (list and usage) uses the new index; the default listing does not', async () => {
    captured.length = 0;
    capture = sparse.orgId;
    try {
      await get(sparse.orgId, '/messages', {
        limit: 10,
        createdFrom: iso(END - 230 * DAY),
        createdTo: iso(END - 200 * DAY),
      });
      await get(sparse.orgId, '/usage/messages', {
        from: iso(END - 187 * DAY),
        to: iso(END - 180 * DAY),
      });
      await get(sparse.orgId, '/messages', { limit: 10 });
    } finally {
      capture = false;
    }
    const list = captured.filter((c) => /order by "messages"\."id" desc/.test(c.text));
    const usage = captured.filter((c) => /GROUP BY/.test(c.text));
    expect(list).toHaveLength(2);
    expect(usage).toHaveLength(2); // grouped counts and failure reasons
    const [windowed, unfiltered] = list as [Captured, Captured];

    // Ordering and cursor shape unchanged: still id DESC, id DESC.
    expect(windowed.text).toMatch(/"messages"\."created_at" >= \$\d+/);
    expect(windowed.text).toMatch(/order by "messages"\."id" desc, "messages"\."id" desc limit/);
    for (const c of [windowed, ...usage]) {
      // One access to messages, through the new index — a plain index scan or a bitmap scan over it.
      expect(messageScans(c.plan)).toHaveLength(1);
      const viaIndex = nodes(c.plan).filter((n) => n['Index Name'] === INDEX);
      expect(viaIndex).toHaveLength(1);
      expect(viaIndex[0]!['Index Cond']).toMatch(/org_id = .*created_at >= .*created_at </);
    }
    // The default listing (no window) is U14.1a's, untouched.
    expect(unfiltered.text).not.toMatch(/"created_at" [<>]=?/); // no window predicate
    expect(messageScans(unfiltered.plan)[0]).toMatchObject({
      'Node Type': 'Index Scan',
      'Index Name': 'messages_org_id_id_desc_idx',
    });
  });
});
