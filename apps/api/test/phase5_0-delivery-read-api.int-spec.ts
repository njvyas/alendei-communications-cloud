/**
 * Phase 5.0 PR-D (implementation plan T10) — the delivery axis on the read APIs.
 *
 * - `GET /messages/:id` and `GET /messages`: `deliveryStatus`, `deliveredAt`, `readAt` on the
 *   message and on every attempt, always present; `null` = not tracked (spec Rev 2 §B.2, §D).
 * - `GET /messages?deliveryStatus=`: the optional filter (`MESSAGE_DELIVERY_STATUSES` only).
 * - `GET /usage/messages`: the additive `delivery` block; existing fields unchanged (AC-API-2).
 * - The submission `status` is never rewritten by a delivery outcome (§B.5 rule 4, OD-4).
 * - Tenant isolation and `messages.read` are unchanged; `providerMessageId` is not exposed
 *   (OD-9 is an open owner decision).
 * - Responses conform to the regenerated OpenAPI document (AC-API-1).
 *
 * Delivery state is seeded through the RLS-bypassing admin connection (the insert guard admits
 * it there only); the write paths are covered by the PR-B settlement and PR-C ingestion suites.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { OpenApiValidator } from './openapi-validator';

jest.setTimeout(120_000);

const url = (p: string) => `/${PREFIX}${p}`;

type Delivery = 'pending' | 'delivered' | 'undelivered' | 'not_supported' | null;

interface Seed {
  readonly key: string;
  readonly status: 'accepted' | 'failed' | 'queued' | 'outcome_unknown';
  readonly delivery: Delivery;
  readonly read?: boolean;
  /** Attempts: submission status and delivery status; none = never reached a provider. */
  readonly attempts?: readonly {
    status: 'accepted' | 'failed' | 'outcome_unknown';
    delivery: Delivery;
    read?: boolean;
    providerMessageId?: string;
  }[];
}

describe('Phase 5.0 PR-D — delivery read APIs (T10)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let noReadToken: string;
  let channelId: string;
  let providerId: string;
  const roleIds: string[] = [];
  const ids = new Map<string, string>();
  const attemptIds = new Map<string, string[]>();

  const FROM = '2026-10-01T00:00:00.000Z';
  const TO = '2026-10-02T00:00:00.000Z';
  const AT = '2026-10-01T09:00:00.000Z';
  const DELIVERED_AT = new Date('2026-10-01T09:00:05.000Z');
  const READ_AT = new Date('2026-10-01T09:01:00.000Z');
  // A provider reference generated per run; it must never appear in a response (OD-9 open).
  const PROVIDER_REF = `sim-ref-${randomBytes(6).toString('hex')}`;

  const SEEDS_A: readonly Seed[] = [
    {
      key: 'pending',
      status: 'accepted',
      delivery: 'pending',
      attempts: [{ status: 'accepted', delivery: 'pending' }],
    },
    {
      key: 'delivered',
      status: 'accepted',
      delivery: 'delivered',
      read: true,
      attempts: [
        { status: 'accepted', delivery: 'delivered', read: true, providerMessageId: PROVIDER_REF },
      ],
    },
    {
      // A superseded attempt reported delivered after the submission failed (§B.5 rule 4).
      key: 'failedDelivered',
      status: 'failed',
      delivery: 'delivered',
      attempts: [
        { status: 'failed', delivery: 'delivered' },
        { status: 'failed', delivery: null },
      ],
    },
    {
      key: 'undelivered',
      status: 'accepted',
      delivery: 'undelivered',
      attempts: [{ status: 'accepted', delivery: 'undelivered' }],
    },
    {
      key: 'notSupported',
      status: 'accepted',
      delivery: 'not_supported',
      attempts: [{ status: 'accepted', delivery: 'not_supported' }],
    },
    // Never reached a provider: no attempt, no delivery state.
    { key: 'queued', status: 'queued', delivery: null },
    // Pre-5.0 (legacy) record: accepted, but delivery never tracked.
    {
      key: 'legacy',
      status: 'accepted',
      delivery: null,
      attempts: [{ status: 'accepted', delivery: null }],
    },
  ];
  const SEEDS_B: readonly Seed[] = [
    {
      key: 'bDelivered',
      status: 'accepted',
      delivery: 'delivered',
      attempts: [{ status: 'accepted', delivery: 'delivered' }],
    },
  ];

  async function grantRead(t: TenantFixture) {
    const [perm] = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.MESSAGES_READ));
    const roleId = uuidv7();
    roleIds.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: t.orgId,
      key: `p50d_${randomBytes(4).toString('hex')}`,
      name: 'Delivery Reader',
      description: 'messages.read only',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    await h.admin
      .insert(schema.rolePermissions)
      .values({ roleId, permissionId: perm!.id, orgId: t.orgId });
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx
        .insert(schema.userRoles)
        .values({ userId: t.userId, roleId, scopeType: 'organization', scopeId: t.orgId });
    });
  }

  async function login(email: string) {
    await h.clearRateLimits();
    return (
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;
  }

  const deliveryColumns = (delivery: Delivery, read?: boolean) => ({
    deliveryStatus: delivery,
    deliveredAt: delivery === 'delivered' ? DELIVERED_AT : null,
    readAt: delivery === 'delivered' && read ? READ_AT : null,
  });

  async function seed(t: TenantFixture, s: Seed) {
    const contactId = uuidv7();
    await h.admin
      .insert(schema.contacts)
      .values({ id: contactId, orgId: t.orgId, workspaceId: t.workspaceId, displayName: 'P50D' });
    const messageId = uuidv7();
    ids.set(s.key, messageId);
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      contactId,
      channelId,
      status: s.status,
      payload: { text: 'body' },
      recipientAddress: '+919812345678',
      correlationId: uuidv7(),
      createdAt: new Date(AT),
      ...deliveryColumns(s.delivery, s.read),
    });
    const attempts: string[] = [];
    for (const [i, a] of (s.attempts ?? []).entries()) {
      const id = uuidv7();
      attempts.push(id);
      await h.admin.insert(schema.messageAttempts).values({
        id,
        messageId,
        orgId: t.orgId,
        attemptNumber: i + 1,
        providerId,
        channelId,
        fencingEpoch: 1,
        claimToken: uuidv7(),
        status: a.status,
        latencyMs: 10,
        completedAt: new Date(AT),
        providerMessageId: a.providerMessageId ?? null,
        ...deliveryColumns(a.delivery, a.read),
      });
    }
    attemptIds.set(s.key, attempts);
  }

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    tenantA = await createTenant(h.admin, 'p50d-a', credentials);
    tenantB = await createTenant(h.admin, 'p50d-b', credentials);
    await grantRead(tenantA);
    await grantRead(tenantB);

    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'sms'));
    channelId = c!.id;
    const slug = `p50d-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `P50D simulator ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning({ id: schema.providers.id });
    providerId = p!.id;
    // message_attempts_assignment_fk: an attempt names an assigned provider.
    for (const t of [tenantA, tenantB]) {
      await h.admin.insert(schema.organizationProviderAssignments).values({
        orgId: t.orgId,
        channelId,
        providerId,
        priority: 1,
        status: 'active',
      });
    }

    for (const s of SEEDS_A) await seed(tenantA, s);
    for (const s of SEEDS_B) await seed(tenantB, s);

    tokenA = await login(tenantA.email);
    tokenB = await login(tenantB.email);
    const noRead = await createScopedUser(
      h.admin,
      tenantA,
      credentials,
      'organization',
      tenantA.orgId,
      'p50d-noread',
    );
    noReadToken = await login(noRead.email);
  }, 90_000);

  afterAll(async () => {
    try {
      const orgIds = [tenantA?.orgId, tenantB?.orgId].filter(Boolean) as string[];
      if (orgIds.length > 0) {
        await h.admin
          .delete(schema.messageAttempts)
          .where(inArray(schema.messageAttempts.orgId, orgIds));
        await h.admin.delete(schema.messages).where(inArray(schema.messages.orgId, orgIds));
        await h.admin.delete(schema.contacts).where(inArray(schema.contacts.orgId, orgIds));
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(inArray(schema.organizationProviderAssignments.orgId, orgIds));
      }
      if (providerId) {
        await h.admin.delete(schema.providers).where(eq(schema.providers.id, providerId));
      }
      if (roleIds.length > 0) {
        await h.admin.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, roleIds));
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roleIds));
        await h.admin.delete(schema.roles).where(inArray(schema.roles.id, roleIds));
      }
      if (tenantA) await destroyTenant(h.admin, tenantA);
      if (tenantB) await destroyTenant(h.admin, tenantB);
    } finally {
      await h.close();
    }
  });

  const get = (path: string, token: string | null = tokenA) => {
    const r = request(h.app.getHttpServer()).get(url(path));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const detail = async (key: string, token = tokenA) =>
    (await get(`/messages/${ids.get(key)}`, token).expect(200)).body.data;
  const listIds = async (query: string, token = tokenA) => {
    const res = await get(`/messages?limit=100&${query}`, token).expect(200);
    return new Set<string>(res.body.data.map((m: { id: string }) => m.id));
  };
  const keysOf = (found: Set<string>, seeds: readonly Seed[]) =>
    seeds
      .map((s) => s.key)
      .filter((k) => found.has(ids.get(k)!))
      .sort();

  it('1. detail: a delivered and read message and its attempt carry the delivery fields; status unchanged', async () => {
    const d = await detail('delivered');
    expect(d.status).toBe('accepted');
    expect(d).toMatchObject({
      deliveryStatus: 'delivered',
      deliveredAt: DELIVERED_AT.toISOString(),
      readAt: READ_AT.toISOString(),
    });
    expect(d.attempts).toHaveLength(1);
    expect(d.attempts[0]).toMatchObject({
      id: attemptIds.get('delivered')![0],
      status: 'accepted',
      deliveryStatus: 'delivered',
      deliveredAt: DELIVERED_AT.toISOString(),
      readAt: READ_AT.toISOString(),
    });
  });

  it('2. the submission status is never rewritten: a failed message delivered on a superseded attempt stays failed', async () => {
    const d = await detail('failedDelivered');
    expect(d.status).toBe('failed');
    expect(d.deliveryStatus).toBe('delivered');
    expect(
      d.attempts.map((a: { status: string; deliveryStatus: string | null }) => [
        a.status,
        a.deliveryStatus,
      ]),
    ).toEqual([
      ['failed', 'delivered'],
      ['failed', null],
    ]);
  });

  it('3. untracked records carry the fields explicitly as null (distinguishable from a tracked status)', async () => {
    for (const key of ['queued', 'legacy']) {
      const d = await detail(key);
      for (const field of ['deliveryStatus', 'deliveredAt', 'readAt']) {
        expect(d).toHaveProperty(field, null);
      }
      for (const a of d.attempts) {
        for (const field of ['deliveryStatus', 'deliveredAt', 'readAt']) {
          expect(a).toHaveProperty(field, null);
        }
      }
    }
    expect((await detail('queued')).attempts).toEqual([]);
    const tracked = await detail('notSupported');
    expect(tracked).toMatchObject({
      deliveryStatus: 'not_supported',
      deliveredAt: null,
      readAt: null,
    });
  });

  it('4. providerMessageId is not exposed on the tenant API (OD-9 open)', async () => {
    const d = await detail('delivered');
    expect(d.attempts[0]).not.toHaveProperty('providerMessageId');
    expect(JSON.stringify(d)).not.toContain(PROVIDER_REF);
    const list = await get('/messages?limit=100').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(PROVIDER_REF);
  });

  it('5. list: every item carries the three fields with the message-level values', async () => {
    const res = await get('/messages?limit=100').expect(200);
    const byId = new Map<string, Record<string, unknown>>(
      res.body.data.map((m: { id: string }) => [m.id, m]),
    );
    for (const s of SEEDS_A) {
      const item = byId.get(ids.get(s.key)!)!;
      expect(item).toBeDefined();
      expect(item).toHaveProperty('deliveryStatus', s.delivery);
      expect(item).toHaveProperty(
        'deliveredAt',
        s.delivery === 'delivered' ? DELIVERED_AT.toISOString() : null,
      );
      expect(item).toHaveProperty('readAt', s.read ? READ_AT.toISOString() : null);
      expect(item.status).toBe(s.status);
    }
  });

  it('6. deliveryStatus filter: exact matches only; untracked rows never match; composes with status', async () => {
    expect(keysOf(await listIds('deliveryStatus=delivered'), SEEDS_A)).toEqual([
      'delivered',
      'failedDelivered',
    ]);
    expect(keysOf(await listIds('deliveryStatus=undelivered'), SEEDS_A)).toEqual(['undelivered']);
    expect(keysOf(await listIds('deliveryStatus=pending'), SEEDS_A)).toEqual(['pending']);
    expect(keysOf(await listIds('deliveryStatus=not_supported'), SEEDS_A)).toEqual([
      'notSupported',
    ]);
    // Two axes: delivered AND submission-accepted excludes the failed-but-delivered message.
    expect(keysOf(await listIds('deliveryStatus=delivered&status=accepted'), SEEDS_A)).toEqual([
      'delivered',
    ]);
    expect(keysOf(await listIds('deliveryStatus=delivered&status=failed'), SEEDS_A)).toEqual([
      'failedDelivered',
    ]);
    // No filter: all seven, including the untracked ones.
    expect(keysOf(await listIds(''), SEEDS_A)).toHaveLength(SEEDS_A.length);
  });

  it('7. deliveryStatus filter: pagination keeps the filter across pages', async () => {
    const first = await get('/messages?limit=1&deliveryStatus=delivered').expect(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.page.hasMore).toBe(true);
    const second = await get(
      `/messages?limit=1&deliveryStatus=delivered&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
    ).expect(200);
    expect(second.body.data).toHaveLength(1);
    const seen = [first.body.data[0].id, second.body.data[0].id].sort();
    expect(seen).toEqual([ids.get('delivered'), ids.get('failedDelivered')].sort());
    expect(second.body.page.hasMore).toBe(false);
  });

  it('8. refuses values outside MESSAGE_DELIVERY_STATUSES with 400', async () => {
    for (const value of [
      'read',
      'not_tracked',
      'expired',
      'DELIVERED',
      'null',
      '',
      'delivered,pending',
    ]) {
      const res = await get(`/messages?deliveryStatus=${encodeURIComponent(value)}`);
      expect([value, res.status]).toEqual([value, 400]);
    }
    const repeated = await get('/messages?deliveryStatus=delivered&deliveryStatus=pending');
    expect(repeated.status).toBe(400);
  });

  it('9. tenant isolation: the filter and detail never cross organizations', async () => {
    expect(keysOf(await listIds('deliveryStatus=delivered', tokenB), SEEDS_B)).toEqual([
      'bDelivered',
    ]);
    const fromB = await listIds('deliveryStatus=delivered', tokenB);
    for (const s of SEEDS_A) expect(fromB.has(ids.get(s.key)!)).toBe(false);
    const fromA = await listIds('deliveryStatus=delivered');
    expect(fromA.has(ids.get('bDelivered')!)).toBe(false);
    await get(`/messages/${ids.get('delivered')}`, tokenB).expect(404);
    await get(`/messages/${ids.get('bDelivered')}`).expect(404);
    const forged = await get('/messages?deliveryStatus=delivered', tokenB).set(
      'X-Acc-Organization',
      tenantA.orgId,
    );
    expect(forged.status).toBe(403);
  });

  it('10. requires messages.read (403 without it, 401 without a credential)', async () => {
    expect((await get('/messages?deliveryStatus=delivered', noReadToken)).status).toBe(403);
    expect((await get(`/messages/${ids.get('delivered')}`, noReadToken)).status).toBe(403);
    expect((await get('/messages?deliveryStatus=delivered', null)).status).toBe(401);
  });

  const period = `from=${FROM}&to=${TO}`;

  it('11. usage: the delivery block partitions the total; submission fields unchanged (AC-API-2)', async () => {
    const data = (await get(`/usage/messages?${period}`).expect(200)).body.data;
    // Submission axis exactly as before Phase 5.0 for the same rows.
    expect(data.totals).toEqual({
      total: 7,
      accepted: 5,
      failed: 1,
      outcomeUnknown: 0,
      pending: 1,
    });
    expect(data.acceptanceRate).toBe(0.8333);
    expect(data.delivery).toEqual({
      delivered: 2,
      undelivered: 1,
      pending: 1,
      notSupported: 1,
      notTracked: 2,
      deliveryRate: 0.6667,
    });
    // Reconciles with the row-level delivery statuses.
    const rows = await h.admin
      .select({ d: schema.messages.deliveryStatus })
      .from(schema.messages)
      .where(eq(schema.messages.orgId, tenantA.orgId));
    const n = (v: Delivery) => rows.filter((r) => r.d === v).length;
    expect([n('delivered'), n('undelivered'), n('pending'), n('not_supported'), n(null)]).toEqual([
      data.delivery.delivered,
      data.delivery.undelivered,
      data.delivery.pending,
      data.delivery.notSupported,
      data.delivery.notTracked,
    ]);
  });

  it('12. usage: filters and tenancy apply to the delivery block too', async () => {
    const rcs = (await get(`/usage/messages?${period}&channelCode=rcs`).expect(200)).body.data;
    expect(rcs.delivery).toEqual({
      delivered: 0,
      undelivered: 0,
      pending: 0,
      notSupported: 0,
      notTracked: 0,
      deliveryRate: null,
    });
    const b = (await get(`/usage/messages?${period}`, tokenB).expect(200)).body.data;
    expect(b.totals.total).toBe(1);
    expect(b.delivery).toMatchObject({ delivered: 1, notTracked: 0, deliveryRate: 1 });
    expect((await get(`/usage/messages?${period}`, noReadToken)).status).toBe(403);
  });

  it('13. reads are side-effect free: no message or attempt row changes', async () => {
    // Every column of every message and attempt row of the organization.
    const snapshot = async () =>
      JSON.stringify([
        (
          await h.admin.execute(
            sql`SELECT to_jsonb(m) AS r FROM messages m WHERE m.org_id = ${tenantA.orgId} ORDER BY m.id`,
          )
        ).rows,
        (
          await h.admin.execute(
            sql`SELECT to_jsonb(a) AS r FROM message_attempts a WHERE a.org_id = ${tenantA.orgId} ORDER BY a.id`,
          )
        ).rows,
      ]);
    const before = await snapshot();
    for (const s of SEEDS_A) await detail(s.key);
    await listIds('deliveryStatus=delivered');
    await get(`/usage/messages?${period}`).expect(200);
    expect(await snapshot()).toBe(before);
  });

  it('14. responses conform to the regenerated OpenAPI document (AC-API-1)', async () => {
    const validator = new OpenApiValidator(
      JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.v1.json'), 'utf8')),
    );
    const problems: string[] = [];
    for (const path of [
      '/messages?limit=100',
      '/messages?deliveryStatus=delivered',
      '/messages?deliveryStatus=not_tracked',
      `/messages/${ids.get('delivered')}`,
      `/messages/${ids.get('queued')}`,
      `/messages/${ids.get('failedDelivered')}`,
      `/usage/messages?${period}`,
    ]) {
      problems.push(...validator.check('GET', url(path), await get(path)));
    }
    expect(problems).toEqual([]);
  });
});
