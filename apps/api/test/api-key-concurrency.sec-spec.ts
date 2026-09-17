/**
 * API-key administration under concurrency (Phase 1B.6.2, `TESTING.md` §6n).
 *
 * **Every case asserts the final database state**, not the status codes. A
 * credential surface that returns plausible answers while reaching a forbidden
 * state has failed, and the states worth naming are: no duplicate key from one
 * idempotency key, no key resurrected after revocation, and no path that leaves
 * a usable credential behind a control that was supposed to stop it.
 *
 * The 1B.6.1 lesson is applied throughout: where the implementation guarantees
 * exactly one winner it is asserted as exactly one, and where it does not, the
 * test says what actually holds rather than pinning a scheduling accident.
 * Revocation *is* exactly-one here — the conditional `WHERE revoked_at IS NULL`
 * makes the row lock decide it — which is why that case may assert it.
 */
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

interface KeyBody {
  id: string;
  prefix: string;
  status: string;
  secret?: string | null;
}

describe('api-key administration under concurrency', () => {
  let h: Harness;
  let credentials: CredentialService;
  let orgA: TenantFixture;
  let adminToken: string;
  const plantedUsers: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'akc', credentials);

    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const key of [
        PERMISSIONS.API_KEYS_READ,
        PERMISSIONS.API_KEYS_CREATE,
        PERMISSIONS.API_KEYS_REVOKE,
        PERMISSIONS.USERS_DISABLE,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.WORKSPACES_READ,
      ]) {
        const [p] = await tx
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, key));
        if (p) {
          await tx
            .insert(schema.rolePermissions)
            .values({ roleId: orgA.roleId, permissionId: p.id })
            .onConflictDoNothing();
        }
      }
    });

    adminToken = await tokenFor(orgA.email);
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await destroyTenant(h.admin, orgA);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(cleanup);

  async function cleanup(): Promise<void> {
    await purgeAudit(h.admin, sql`true`);
    await h.admin.execute(sql`DELETE FROM idempotency_keys WHERE true`);
    await h.admin.execute(sql`DELETE FROM api_keys WHERE org_id = ${orgA.orgId}`);
    if (plantedUsers.length > 0) {
      const ids = plantedUsers.splice(0);
      for (const id of ids) {
        await h.admin.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
        await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
        await h.admin.execute(sql`DELETE FROM users WHERE id = ${id}`);
      }
    }
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const create = (body: unknown, key?: string, token = adminToken) => {
    const r = request(h.app.getHttpServer())
      .post(url('/api-keys'))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', orgA.orgId);
    if (key) r.set('idempotency-key', key);
    return r.send(body as object);
  };

  const revoke = (id: string, token = adminToken) =>
    request(h.app.getHttpServer())
      .post(url(`/api-keys/${id}/revoke`))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', orgA.orgId);

  const me = (credential: string) =>
    request(h.app.getHttpServer())
      .get(url('/auth/me'))
      .set('authorization', `Bearer ${credential}`);

  const body = (label: string) => ({
    name: `${label}-${uuidv7().replace(/-/g, '').slice(-8)}`,
    scopeType: 'organization' as const,
    scopeId: orgA.orgId,
    scopes: [PERMISSIONS.WORKSPACES_READ],
  });

  async function keyCount(): Promise<number> {
    const { rows } = await h.admin.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM api_keys WHERE org_id = ${orgA.orgId}`,
    );
    return Number(rows[0]!.c);
  }

  async function rowOf(id: string) {
    const [row] = await h.admin
      .select({
        revokedAt: schema.apiKeys.revokedAt,
        revokedReason: schema.apiKeys.revokedReason,
        expiresAt: schema.apiKeys.expiresAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id));
    return row!;
  }

  // ===========================================================================
  it('A — two concurrent creations with different names both succeed', async () => {
    const [a, b] = await Promise.all([
      create(body('conc-a')).then((r) => r.status),
      create(body('conc-b')).then((r) => r.status),
    ]);
    expect([a, b]).toEqual([201, 201]);
    expect(await keyCount()).toBe(2);

    // Two distinct credentials, not one duplicated.
    const { rows } = await h.admin.execute<{ c: string }>(
      sql`SELECT count(DISTINCT key_prefix)::text AS c FROM api_keys WHERE org_id = ${orgA.orgId}`,
    );
    expect(rows[0]!.c).toBe('2');
  });

  it('B — one idempotency key, identical requests: exactly one key, one secret', async () => {
    const key = `akc-same-${uuidv7()}`;
    const payload = body('conc-idem');

    const [a, b] = await Promise.all([
      create(payload, key).then((r) => ({ status: r.status, data: r.body?.data as KeyBody })),
      create(payload, key).then((r) => ({ status: r.status, data: r.body?.data as KeyBody })),
    ]);

    // The duplicate blocks on the original's row lock and then replays it, so
    // both see `201` — 1B.5.9 semantics, unchanged.
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.data.id).toBe(b.data.id);
    expect(await keyCount()).toBe(1);

    // **Exactly one of the two carries the secret**: the fresh execution. The
    // replay carries null, because nothing stored it (ADR-008).
    const withSecret = [a, b].filter((r) => typeof r.data.secret === 'string');
    const withoutSecret = [a, b].filter((r) => r.data.secret === null);
    expect(withSecret).toHaveLength(1);
    expect(withoutSecret).toHaveLength(1);

    // And the plaintext is absent from the stored snapshot. Asserted on the
    // parsed document rather than its text: PostgreSQL renders `jsonb` with its
    // own spacing, so a literal `"secret":null` match would be testing the
    // serializer instead of the property.
    const { rows } = await h.admin.execute<{ snapshot: { data: KeyBody }; snap: string }>(
      sql`SELECT response_snapshot AS snapshot, response_snapshot::text AS snap
          FROM idempotency_keys WHERE idempotency_key = ${key}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snapshot.data).toHaveProperty('secret');
    expect(rows[0]!.snapshot.data.secret).toBeNull();
    // The plaintext appears nowhere in the row, at any depth.
    expect(rows[0]!.snap).not.toContain(withSecret[0]!.data.secret as string);
  });

  it('C — one idempotency key, different requests: the second is refused', async () => {
    const key = `akc-diff-${uuidv7()}`;
    const first = await create(body('conc-x'), key).expect(201);
    expect(first.status).toBe(201);

    const second = await create(body('conc-y'), key);
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    // The mismatch created nothing.
    expect(await keyCount()).toBe(1);
  });

  it('D — concurrent revocations of one key produce exactly one winner', async () => {
    const created = await create(body('conc-rev')).expect(201);
    const id = (created.body.data as KeyBody).id;

    const results = await Promise.all([
      revoke(id).then((r) => ({ status: r.status, code: r.body?.error?.code })),
      revoke(id).then((r) => ({ status: r.status, code: r.body?.error?.code })),
    ]);

    // Deterministic, unlike the user lifecycle: the conditional
    // `WHERE revoked_at IS NULL` means the row lock decides, not arrival order.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 200)!;
    expect(loser.status).toBe(409);
    expect(loser.code).toBe(ERROR_CODES.API_KEY_LIFECYCLE_CONFLICT);

    const row = await rowOf(id);
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe('revoked_by_administrator');
  });

  it('E — no authentication succeeds after the revocation commits', async () => {
    const created = await create(body('conc-auth')).expect(201);
    const key = created.body.data as KeyBody;
    const credential = `${key.prefix}.${key.secret}`;
    await me(credential).expect(200);

    const [authStatus, revokeStatus] = await Promise.all([
      me(credential).then((r) => r.status),
      revoke(key.id).then((r) => r.status),
    ]);

    expect(revokeStatus).toBe(200);
    // The concurrent request may have been admitted or refused depending on
    // commit order — both are correct, and asserting one would assert a
    // scheduling accident.
    expect([200, 401]).toContain(authStatus);

    // What is not ambiguous: after the commit, never again.
    for (let i = 0; i < 3; i += 1) await me(credential).expect(401);
    expect((await rowOf(key.id)).revokedAt).not.toBeNull();
  });

  it('F — revocation racing expiry cannot resurrect the key', async () => {
    const created = await create({
      ...body('conc-exp'),
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    }).expect(201);
    const key = created.body.data as KeyBody;
    const credential = `${key.prefix}.${key.secret}`;

    // Expire it from underneath the revocation, concurrently.
    const [revokeStatus] = await Promise.all([
      revoke(key.id).then((r) => r.status),
      h.admin
        .update(schema.apiKeys)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.apiKeys.id, key.id)),
    ]);

    // Whichever landed first, the final state is terminal on both axes and the
    // credential is dead.
    expect([200, 409]).toContain(revokeStatus);
    const row = await rowOf(key.id);
    expect(row.revokedAt !== null || row.expiresAt!.getTime() <= Date.now()).toBe(true);
    await me(credential).expect(401);
  });

  it('G — a key created while its creator is being disabled confers nothing', async () => {
    const creator = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'organization',
      orgA.orgId,
      'akc-creator',
    );
    plantedUsers.push(creator.userId);
    const creatorToken = await tokenFor(creator.email);

    const disable = () =>
      request(h.app.getHttpServer())
        .post(url(`/users/${creator.userId}/disable`))
        .set('authorization', `Bearer ${adminToken}`)
        .set('x-acc-organization', orgA.orgId)
        .then((r) => r.status);

    const [createStatus, disableStatus] = await Promise.all([
      create(body('conc-race'), undefined, creatorToken).then((r) => ({
        status: r.status,
        data: r.body?.data as KeyBody | undefined,
      })),
      disable(),
    ]);

    expect(disableStatus).toBe(200);

    // The creation may have committed before the disable or been refused after
    // it — both are correct. What must hold is that **no usable credential
    // survives**: the intersection is recomputed per request against a creator
    // who can no longer sign in.
    if (createStatus.status === 201 && createStatus.data?.secret) {
      const credential = `${createStatus.data.prefix}.${createStatus.data.secret}`;
      const identity = await me(credential).expect(200);
      expect(identity.body.data.permissions).toEqual([]);
      await request(h.app.getHttpServer())
        .get(url('/api-keys'))
        .set('authorization', `Bearer ${credential}`)
        .expect(403);
    } else {
      expect(createStatus.status).toBeGreaterThanOrEqual(400);
    }
  });
});
