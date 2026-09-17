/**
 * API-key administration (Phase 1B.6.2, `API.md` §3e, `RBAC.md` §5c/§8d).
 *
 * This surface mints credentials, so the questions worth asking are mostly about
 * the secret: where it goes, where it must never go, and whether anything can
 * get it back. The rest is the established administration shape — membership,
 * coherent-grant authorization, RLS beneath it, transactional audit — asserted
 * again here because a new surface is a new chance to get it wrong.
 *
 * The governing invariant, from ADR-008:
 *
 *   **An API-key plaintext secret must never be persisted in
 *   `idempotency_keys.response_snapshot`** — nor in `api_keys`, an audit row, an
 *   error, or anywhere else. It exists in the fresh HTTP response and nowhere
 *   else, ever.
 *
 * Authentication of API keys is *not* re-tested here; it is Phase 1B.3's and is
 * covered by `api-key.sec-spec.ts` and `api-key-binding-scope.sec-spec.ts`. What
 * this suite adds on that axis is the interaction between the new lifecycle and
 * the existing credential path: a revoked or expired key, and a disabled
 * creator, must all stop working.
 */
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
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
  name: string;
  prefix: string;
  status: string;
  scopeType: string;
  scopeId: string;
  orgId: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  secret?: string | null;
}

/** What the fixture role must hold for this surface to be exercised. */
const ADMIN_PERMISSIONS = [
  PERMISSIONS.API_KEYS_READ,
  PERMISSIONS.API_KEYS_CREATE,
  PERMISSIONS.API_KEYS_REVOKE,
  PERMISSIONS.WORKSPACES_READ,
  PERMISSIONS.USERS_READ,
  PERMISSIONS.USERS_DISABLE,
];

describe('api-key administration', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let adminToken: string;
  let orgBAdminToken: string;
  let workspaceTwoId: string;
  const plantedUsers: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);

    orgA = await createTenant(h.admin, 'ak-a', credentials);
    orgB = await createTenant(h.admin, 'ak-b', credentials);
    await addToFixtureRole(orgA, ADMIN_PERMISSIONS);
    await addToFixtureRole(orgB, ADMIN_PERMISSIONS);

    const [second] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: orgA.orgId, name: 'Second', slug: 'second' })
      .returning({ id: schema.workspaces.id });
    workspaceTwoId = second!.id;

    adminToken = await tokenFor(orgA.email);
    orgBAdminToken = await tokenFor(orgB.email);
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceTwoId}`);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(cleanup);

  async function cleanup(): Promise<void> {
    await purgeAudit(h.admin, sql`true`);
    await h.admin.execute(sql`DELETE FROM idempotency_keys WHERE true`);
    await h.admin.execute(sql`DELETE FROM api_keys WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})`);
    if (plantedUsers.length > 0) {
      const ids = plantedUsers.splice(0);
      for (const id of ids) {
        await h.admin.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
        await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
        await h.admin.execute(sql`DELETE FROM users WHERE id = ${id}`);
      }
    }
  }

  // --- fixtures ---------------------------------------------------------------

  async function addToFixtureRole(
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

  const api = (token: string, org?: string) => {
    const auth = <T extends request.Test>(r: T): T => {
      r.set('authorization', `Bearer ${token}`);
      if (org) r.set('x-acc-organization', org);
      return r;
    };
    return {
      list: (query = '') => auth(request(h.app.getHttpServer()).get(url(`/api-keys${query}`))),
      get: (id: string) => auth(request(h.app.getHttpServer()).get(url(`/api-keys/${id}`))),
      create: (body: unknown, key?: string) => {
        const r = auth(request(h.app.getHttpServer()).post(url('/api-keys')));
        if (key) r.set('idempotency-key', key);
        return r.send(body as object);
      },
      revoke: (id: string) =>
        auth(request(h.app.getHttpServer()).post(url(`/api-keys/${id}/revoke`))),
    };
  };

  const anonymous = {
    list: () => request(h.app.getHttpServer()).get(url('/api-keys')),
    get: (id: string) => request(h.app.getHttpServer()).get(url(`/api-keys/${id}`)),
    create: (body: unknown) =>
      request(h.app.getHttpServer())
        .post(url('/api-keys'))
        .send(body as object),
    revoke: (id: string) => request(h.app.getHttpServer()).post(url(`/api-keys/${id}/revoke`)),
  };

  /** A valid creation body bound to organization A. */
  const validCreate = (label: string, over: Record<string, unknown> = {}) => ({
    name: `${label}-${uuidv7().replace(/-/g, '').slice(-8)}`,
    scopeType: 'organization' as const,
    scopeId: orgA.orgId,
    scopes: [PERMISSIONS.WORKSPACES_READ],
    ...over,
  });

  async function createKey(
    label: string,
    over: Record<string, unknown> = {},
    token = adminToken,
  ): Promise<{ body: KeyBody; secret: string; credential: string }> {
    const res = await api(token).create(validCreate(label, over)).expect(201);
    const body = res.body.data as KeyBody;
    const secret = body.secret as string;
    return { body, secret, credential: `${body.prefix}.${secret}` };
  }

  async function auditRows(action: string) {
    const { rows } = await h.admin.execute<Record<string, unknown>>(
      sql`SELECT * FROM audit_logs WHERE action = ${action} ORDER BY created_at`,
    );
    return rows;
  }

  async function snapshotFor(key: string) {
    const { rows } = await h.admin.execute<{
      response_snapshot: unknown;
      response_status_code: number;
    }>(sql`SELECT response_snapshot, response_status_code FROM idempotency_keys
           WHERE idempotency_key = ${key}`);
    return rows[0];
  }

  const me = (credential: string) =>
    request(h.app.getHttpServer())
      .get(url('/auth/me'))
      .set('authorization', `Bearer ${credential}`);

  // ===========================================================================
  // The secret — where it goes, and everywhere it must not
  // ===========================================================================
  describe('secret handling', () => {
    it('case 1 — a fresh creation returns a non-null, usable secret', async () => {
      const { body, secret, credential } = await createKey('fresh');
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThanOrEqual(32);
      expect(body.prefix).toMatch(/^ak_(live|test)_[A-Za-z0-9]{16}$/);
      // The credential actually authenticates, so "a secret was returned" is not
      // satisfied by an arbitrary string.
      await me(credential).expect(200);
    });

    it('case 36 — the plaintext secret is never persisted in api_keys', async () => {
      const { body, secret } = await createKey('nostore');
      const { rows } = await h.admin.execute<Record<string, unknown>>(
        sql`SELECT * FROM api_keys WHERE id = ${body.id}`,
      );
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain(secret);
      // What *is* stored is an Argon2id digest, and nothing else credential-like.
      expect(rows[0]!.key_hash as string).toMatch(/^\$argon2id\$/);
      expect(rows[0]!.key_hash).not.toBe(secret);
    });

    it('cases 16/17 — the secret is absent from list and detail', async () => {
      const { body, secret } = await createKey('absent');

      const list = await api(adminToken).list().expect(200);
      const detail = await api(adminToken).get(body.id).expect(200);

      for (const res of [list, detail]) {
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(secret);
        expect(text).not.toContain('keyHash');
        expect(text).not.toContain('key_hash');
        expect(text).not.toMatch(/\$argon2/);
      }
      // `secret` is not even a field on the read model.
      expect(detail.body.data).not.toHaveProperty('secret');
      expect((list.body.data as KeyBody[])[0]).not.toHaveProperty('secret');
    });

    it('case 22 — the detail projection is exactly the published fields', async () => {
      const { body } = await createKey('shape');
      const res = await api(adminToken).get(body.id).expect(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual([
        'createdAt',
        'createdBy',
        'expiresAt',
        'id',
        'lastUsedAt',
        'name',
        'orgId',
        'prefix',
        'revokedAt',
        'revokedReason',
        'scopeId',
        'scopeType',
        'scopes',
        'status',
        'updatedAt',
      ]);
    });

    it('cases 17/20 — no endpoint can recover the secret after creation', async () => {
      const { body, secret } = await createKey('unrecoverable');

      // Every read path this surface offers, plus the filtered list.
      const attempts = [
        await api(adminToken).get(body.id).expect(200),
        await api(adminToken).list().expect(200),
        await api(adminToken)
          .list(`?name=${encodeURIComponent(body.name)}`)
          .expect(200),
      ];
      for (const res of attempts) expect(JSON.stringify(res.body)).not.toContain(secret);

      // And there is no route that could: nothing under the resource but revoke.
      await request(h.app.getHttpServer())
        .get(url(`/api-keys/${body.id}/secret`))
        .set('authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('case 18 — the audit record contains no secret and no digest', async () => {
      const { body, secret } = await createKey('audited');
      const rows = await auditRows('api_key.created');
      expect(rows).toHaveLength(1);

      const text = JSON.stringify(rows[0]);
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/\$argon2/);
      expect(text.toLowerCase()).not.toContain('keyhash');
      // The prefix *is* recorded: it is public, and it is what correlates this
      // row with later `api_key.authenticated` rows.
      expect(text).toContain(body.prefix);
      expect(rows[0]!.resource_id).toBe(body.id);
    });

    it('case 14 — a failing creation discloses no credential material', async () => {
      // Refused for exceeding the creator's authority, after validation but
      // before anything is minted.
      const res = await api(adminToken)
        .create(validCreate('failing', { scopes: [PERMISSIONS.PLATFORM_TENANTS_MANAGE] }))
        .expect(403);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/\$argon2/);
      expect(text).not.toMatch(/ak_(live|test)_/);
      expect(text.toLowerCase()).not.toContain('secret');
    });

    it('a refused creation mints nothing at all', async () => {
      const before = await h.admin.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM api_keys WHERE org_id = ${orgA.orgId}`,
      );
      await api(adminToken)
        .create(validCreate('nothing', { scopes: [PERMISSIONS.PLATFORM_TENANTS_MANAGE] }))
        .expect(403);
      const after = await h.admin.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM api_keys WHERE org_id = ${orgA.orgId}`,
      );
      expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
    });
  });

  // ===========================================================================
  // ADR-008 — the secret never reaches the idempotency snapshot
  // ===========================================================================
  describe('idempotency snapshot security (ADR-008)', () => {
    it('cases 3/4 — the persisted snapshot carries secret:null and no plaintext', async () => {
      const key = `ak-snap-${uuidv7()}`;
      const res = await api(adminToken).create(validCreate('snap'), key).expect(201);
      const secret = (res.body.data as KeyBody).secret as string;
      expect(secret).toBeTruthy();

      const record = await snapshotFor(key);
      expect(record).toBeDefined();
      const snapshot = record!.response_snapshot as { data: KeyBody };

      // The field is present and explicitly null — not omitted, so the shape a
      // client parses is the same fresh or replayed.
      expect(snapshot.data).toHaveProperty('secret');
      expect(snapshot.data.secret).toBeNull();

      // And the plaintext appears nowhere in the stored row, at any depth.
      expect(JSON.stringify(record)).not.toContain(secret);
    });

    it('case 5 — the fresh response and the snapshot differ only in `secret`', async () => {
      const key = `ak-diff-${uuidv7()}`;
      const res = await api(adminToken).create(validCreate('diff'), key).expect(201);
      const fresh = res.body.data as KeyBody;

      const record = await snapshotFor(key);
      const stored = (record!.response_snapshot as { data: KeyBody }).data;

      expect(Object.keys(stored).sort()).toEqual(Object.keys(fresh).sort());
      const differing = Object.keys(fresh).filter(
        (k) =>
          JSON.stringify((fresh as Record<string, unknown>)[k]) !==
          JSON.stringify((stored as Record<string, unknown>)[k]),
      );
      // Exactly one field differs, and it is the documented non-persistable one.
      expect(differing).toEqual(['secret']);
      expect(record!.response_status_code).toBe(201);
    });

    it('cases 6/7/8/18 — a replay returns secret:null, creates nothing, mints nothing', async () => {
      const key = `ak-replay-${uuidv7()}`;
      const body = validCreate('replay');

      const first = await api(adminToken).create(body, key).expect(201);
      const firstBody = first.body.data as KeyBody;
      const secret = firstBody.secret as string;

      const second = await api(adminToken).create(body, key).expect(201);
      const replayed = second.body.data as KeyBody;

      // The secret is not re-presented, and no new one was generated.
      expect(replayed.secret).toBeNull();
      expect(JSON.stringify(second.body)).not.toContain(secret);

      // Same resource: no second key exists.
      expect(replayed.id).toBe(firstBody.id);
      const { rows } = await h.admin.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM api_keys WHERE org_id = ${orgA.orgId}`,
      );
      expect(rows[0]!.c).toBe('1');

      // And exactly one creation was audited.
      expect(await auditRows('api_key.created')).toHaveLength(1);

      // The replay body is byte-identical to what was stored.
      const record = await snapshotFor(key);
      expect(second.body).toEqual(record!.response_snapshot);
    });

    it('case 18 — a discarded creation response means the credential is gone', async () => {
      const key = `ak-lost-${uuidv7()}`;
      const body = validCreate('lost');
      const first = await api(adminToken).create(body, key).expect(201);
      const lost = (first.body.data as KeyBody).secret as string;

      // The client "loses" the response and retries with the same key.
      const retry = await api(adminToken).create(body, key).expect(201);
      expect((retry.body.data as KeyBody).secret).toBeNull();

      // The original secret still authenticates — it was never invalidated —
      // but nothing in the system will hand it back.
      await me(`${(first.body.data as KeyBody).prefix}.${lost}`).expect(200);
      const { rows } = await h.admin.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM idempotency_keys
            WHERE response_snapshot::text LIKE ${'%' + lost + '%'}`,
      );
      expect(rows[0]!.c).toBe('0');
    });

    it('case 11 — the same key with a different request is refused', async () => {
      const key = `ak-mismatch-${uuidv7()}`;
      await api(adminToken).create(validCreate('mm-a'), key).expect(201);
      const res = await api(adminToken).create(validCreate('mm-b'), key).expect(422);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('case 9 — a different principal cannot replay and cannot obtain the secret', async () => {
      const key = `ak-principal-${uuidv7()}`;
      const body = validCreate('principal');
      const first = await api(adminToken).create(body, key).expect(201);
      const secret = (first.body.data as KeyBody).secret as string;

      const other = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'organization',
        orgA.orgId,
        'ak-other',
      );
      plantedUsers.push(other.userId);
      const otherToken = await tokenFor(other.email);

      const res = await api(otherToken).create(body, key).expect(422);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    });

    it('case 10 — a replay after authorization loss is refused, not served', async () => {
      const key = `ak-authz-${uuidv7()}`;
      const body = validCreate('authz');
      const first = await api(adminToken).create(body, key).expect(201);
      const secret = (first.body.data as KeyBody).secret as string;

      const [permission] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, PERMISSIONS.API_KEYS_CREATE));
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        await tx
          .delete(schema.rolePermissions)
          .where(
            and(
              eq(schema.rolePermissions.roleId, orgA.roleId),
              eq(schema.rolePermissions.permissionId, permission!.id),
            ),
          );
      });

      try {
        const res = await api(adminToken).create(body, key).expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
        expect(JSON.stringify(res.body)).not.toContain(secret);
      } finally {
        await addToFixtureRole(orgA, [PERMISSIONS.API_KEYS_CREATE]);
      }
    });

    it('case 12/26 — idempotency keys do not collide across tenants', async () => {
      const key = `ak-cross-${uuidv7()}`;
      const a = await api(adminToken).create(validCreate('cross-a'), key).expect(201);

      const bBody = {
        name: `cross-b-${uuidv7().replace(/-/g, '').slice(-8)}`,
        scopeType: 'organization' as const,
        scopeId: orgB.orgId,
        scopes: [PERMISSIONS.WORKSPACES_READ],
      };
      const b = await api(orgBAdminToken).create(bBody, key).expect(201);

      // Same key string, two organizations, two distinct keys and two secrets.
      expect((b.body.data as KeyBody).id).not.toBe((a.body.data as KeyBody).id);
      expect((b.body.data as KeyBody).secret).not.toBe((a.body.data as KeyBody).secret);
      expect((b.body.data as KeyBody).orgId).toBe(orgB.orgId);
    });
  });

  // ===========================================================================
  // Authentication and unauthenticated access
  // ===========================================================================
  describe('unauthenticated access', () => {
    it('cases 1/2/3 — every route requires authentication', async () => {
      const id = uuidv7();
      for (const res of [
        await anonymous.list(),
        await anonymous.get(id),
        await anonymous.create(validCreate('anon')),
        await anonymous.revoke(id),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTH_CREDENTIAL_REQUIRED);
      }
    });
  });

  describe('credential lifecycle at authentication', () => {
    it('cases 15/33 — a revoked key cannot authenticate', async () => {
      const { body, credential } = await createKey('revoked-auth');
      await me(credential).expect(200);

      await api(adminToken).revoke(body.id).expect(200);

      const res = await me(credential).expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_API_KEY_INVALID);
    });

    it('cases 14/32 — an expired key cannot authenticate', async () => {
      const { body, credential } = await createKey('expiring', {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(body.status).toBe('active');
      await me(credential).expect(200);

      // Move the boundary into the past rather than sleeping: the rule under
      // test is `expires_at > now()`, not the clock.
      await h.admin
        .update(schema.apiKeys)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.apiKeys.id, body.id));

      await me(credential).expect(401);
      const detail = await api(adminToken).get(body.id).expect(200);
      expect((detail.body.data as KeyBody).status).toBe('expired');
    });

    it('cases 13/34 — a disabled creator stops the key conferring anything', async () => {
      const creator = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'organization',
        orgA.orgId,
        'ak-creator',
      );
      plantedUsers.push(creator.userId);
      const creatorToken = await tokenFor(creator.email);

      const { credential } = await createKey('by-creator', {}, creatorToken);
      const before = await me(credential).expect(200);
      expect(before.body.data.permissions).toContain(PERMISSIONS.WORKSPACES_READ);

      await request(h.app.getHttpServer())
        .post(url(`/users/${creator.userId}/disable`))
        .set('authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Phase 1B.6.1: the intersection resolves to nothing for a creator who
      // cannot sign in. The key still authenticates as an identity and confers
      // no authority — keys are *not* auto-revoked, which is the documented
      // semantic.
      const after = await me(credential).expect(200);
      expect(after.body.data.permissions).toEqual([]);
      await api(credential).list().expect(403);

      const [row] = await h.admin
        .select({ revokedAt: schema.apiKeys.revokedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.createdBy, creator.userId));
      expect(row!.revokedAt).toBeNull();
    });

    it('a revoked key stays refused regardless of creator status', async () => {
      const { body, credential } = await createKey('revoked-wins');
      await api(adminToken).revoke(body.id).expect(200);
      // Creator is active throughout; revocation alone is terminal.
      await me(credential).expect(401);
    });
  });

  // ===========================================================================
  // Authorization
  // ===========================================================================
  describe('authorization', () => {
    async function powerless(): Promise<string> {
      const [role] = await h.admin
        .insert(schema.roles)
        .values({
          orgId: orgA.orgId,
          key: `ak_empty_${uuidv7().replace(/-/g, '').slice(-6)}`,
          name: 'empty',
          isSystemRole: false,
          allowedScopeTypes: ['organization'],
        })
        .returning({ id: schema.roles.id });
      const email = `ak-none-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      plantedUsers.push(user!.id);
      await h.admin.insert(schema.userRoles).values({
        userId: user!.id,
        roleId: role!.id,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });
      return tokenFor(email);
    }

    it('reading, creating and revoking each require their own permission', async () => {
      const { body } = await createKey('perm');
      const token = await powerless();

      await api(token).list().expect(403);
      await api(token).get(body.id).expect(403);
      await api(token).create(validCreate('denied')).expect(403);
      await api(token).revoke(body.id).expect(403);

      // Nothing moved.
      const [row] = await h.admin
        .select({ revokedAt: schema.apiKeys.revokedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, body.id));
      expect(row!.revokedAt).toBeNull();
    });

    it('cases 4/5/6 — another organization’s keys are invisible and untouchable', async () => {
      const mine = await createKey('mine');
      const theirs = await api(orgBAdminToken)
        .create({
          name: `theirs-${uuidv7().replace(/-/g, '').slice(-8)}`,
          scopeType: 'organization',
          scopeId: orgB.orgId,
          scopes: [PERMISSIONS.WORKSPACES_READ],
        })
        .expect(201);
      const theirId = (theirs.body.data as KeyBody).id;

      const list = await api(adminToken).list().expect(200);
      const ids = (list.body.data as KeyBody[]).map((k) => k.id);
      expect(ids).toContain(mine.body.id);
      expect(ids).not.toContain(theirId);

      await api(adminToken).get(theirId).expect(404);
      await api(adminToken).revoke(theirId).expect(404);

      // Still live in its own tenant — the refusal was scoping, not a mutation.
      const [row] = await h.admin
        .select({ revokedAt: schema.apiKeys.revokedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, theirId));
      expect(row!.revokedAt).toBeNull();
    });

    it('case 5 — a real foreign id is indistinguishable from an unknown one', async () => {
      const theirs = await api(orgBAdminToken)
        .create({
          name: `oracle-${uuidv7().replace(/-/g, '').slice(-8)}`,
          scopeType: 'organization',
          scopeId: orgB.orgId,
          scopes: [PERMISSIONS.WORKSPACES_READ],
        })
        .expect(201);

      const real = await api(adminToken)
        .get((theirs.body.data as KeyBody).id)
        .expect(404);
      const unknown = await api(adminToken).get(uuidv7()).expect(404);
      const strip = (b: { error: Record<string, unknown> }) => ({
        ...b.error,
        correlationId: '<x>',
      });
      expect(strip(real.body)).toEqual(strip(unknown.body));
    });

    it('cases 7/28 — a forged organization header cannot widen the request', async () => {
      const res = await api(adminToken, orgB.orgId).list().expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('case 28 — binding to another tenant’s workspace is 404, not a binding', async () => {
      const res = await api(adminToken)
        .create(validCreate('substitute', { scopeType: 'workspace', scopeId: orgB.workspaceId }))
        .expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);

      const { rows } = await h.admin.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM api_keys WHERE org_id = ${orgB.orgId}`,
      );
      expect(rows[0]!.c).toBe('0');
    });

    it('cases 10/8 — platform, reseller and team bindings are unrepresentable', async () => {
      for (const scopeType of ['platform', 'reseller', 'team']) {
        const res = await api(adminToken)
          .create(validCreate('scope', { scopeType, scopeId: orgA.orgId }))
          .expect(400);
        expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      }
    });

    it('case 27 — revoke authorizes against the stored binding scope, not the caller’s', async () => {
      // A key bound to workspace one.
      const { body } = await createKey('ws-bound', {
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });
      expect(body.scopeType).toBe('workspace');
      expect(body.scopeId).toBe(orgA.workspaceId);

      // An actor whose only grant is in a *different* workspace of the same
      // organization. It can see nothing of workspace one.
      const sibling = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'workspace',
        workspaceTwoId,
        'ak-sibling',
      );
      plantedUsers.push(sibling.userId);
      const siblingToken = await tokenFor(sibling.email);

      const res = await api(siblingToken).revoke(body.id).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

      const [row] = await h.admin
        .select({ revokedAt: schema.apiKeys.revokedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, body.id));
      expect(row!.revokedAt).toBeNull();
    });

    it('cases 11/35 — a creator cannot confer a permission held at an unrelated scope', async () => {
      // The fixture admin holds `users.disable` across organization A. Ask for a
      // key bound to a workspace: the organization grant *does* cover the
      // workspace, so this must succeed — the positive control.
      await api(adminToken)
        .create(
          validCreate('covers', {
            scopeType: 'workspace',
            scopeId: orgA.workspaceId,
            scopes: [PERMISSIONS.USERS_DISABLE],
          }),
        )
        .expect(201);

      // Now an actor holding a permission only in workspace two, asking for a
      // key bound to workspace one. The flattened union contains it; no coherent
      // grant carries it there.
      const [wsRole] = await h.admin
        .insert(schema.roles)
        .values({
          orgId: orgA.orgId,
          key: `ak_ws_${uuidv7().replace(/-/g, '').slice(-6)}`,
          name: 'ws-only',
          isSystemRole: false,
          allowedScopeTypes: ['workspace'],
        })
        .returning({ id: schema.roles.id });
      for (const key of [PERMISSIONS.API_KEYS_CREATE, PERMISSIONS.TEAMS_CREATE]) {
        const [p] = await h.admin
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, key));
        await h.admin
          .insert(schema.rolePermissions)
          .values({ roleId: wsRole!.id, permissionId: p!.id })
          .onConflictDoNothing();
      }
      const split = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'workspace',
        workspaceTwoId,
        'ak-split',
      );
      plantedUsers.push(split.userId);
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.userId, split.userId));
      await h.admin.insert(schema.userRoles).values({
        userId: split.userId,
        roleId: wsRole!.id,
        scopeType: 'workspace',
        scopeId: workspaceTwoId,
      });
      const splitToken = await tokenFor(split.email);

      // Positive control: it may create in its own workspace.
      await api(splitToken)
        .create(
          validCreate('own-ws', {
            scopeType: 'workspace',
            scopeId: workspaceTwoId,
            scopes: [PERMISSIONS.TEAMS_CREATE],
          }),
        )
        .expect(201);

      // And not in the sibling workspace it does not cover.
      const res = await api(splitToken)
        .create(
          validCreate('other-ws', {
            scopeType: 'workspace',
            scopeId: orgA.workspaceId,
            scopes: [PERMISSIONS.TEAMS_CREATE],
          }),
        )
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('case 12 — a key may not request more than its creator holds at the binding', async () => {
      const res = await api(adminToken)
        .create(validCreate('over', { scopes: [PERMISSIONS.PLATFORM_TENANTS_MANAGE] }))
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION);
      expect(res.body.error.details.rejected).toContain(PERMISSIONS.PLATFORM_TENANTS_MANAGE);
    });

    it('an API-key principal cannot create another API key', async () => {
      const { credential } = await createKey('by-key', {
        scopes: [PERMISSIONS.API_KEYS_CREATE, PERMISSIONS.WORKSPACES_READ],
      });
      const res = await api(credential).create(validCreate('nested')).expect(403);
      // A key has no `created_by` to record, and a key with no creator confers
      // nothing — so the refusal prevents a dead credential rather than an
      // escalation.
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_PERMISSION_DENIED);
    });

    it('a platform role cannot be smuggled in through scopes', async () => {
      const [platformRole] = await h.admin
        .select({ key: schema.roles.key })
        .from(schema.roles)
        .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN));
      expect(platformRole).toBeDefined();

      const res = await api(adminToken)
        .create(validCreate('plat', { scopes: [PERMISSIONS.PLATFORM_ROLES_ASSIGN] }))
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION);
    });
  });

  // ===========================================================================
  // Lifecycle, list conventions, audit, RLS
  // ===========================================================================
  describe('lifecycle', () => {
    it('revocation is terminal and repeats are a lifecycle conflict', async () => {
      const { body } = await createKey('terminal');
      const first = await api(adminToken).revoke(body.id).expect(200);
      expect((first.body.data as KeyBody).status).toBe('revoked');
      expect((first.body.data as KeyBody).revokedAt).not.toBeNull();

      const second = await api(adminToken).revoke(body.id).expect(409);
      expect(second.body.error.code).toBe(ERROR_CODES.API_KEY_LIFECYCLE_CONFLICT);
      expect(second.body.error.details).toEqual({ status: 'revoked' });
    });

    it('there is no delete and no un-revoke', async () => {
      const { body } = await createKey('nodelete');
      await request(h.app.getHttpServer())
        .delete(url(`/api-keys/${body.id}`))
        .set('authorization', `Bearer ${adminToken}`)
        .expect(404);
      await request(h.app.getHttpServer())
        .post(url(`/api-keys/${body.id}/reactivate`))
        .set('authorization', `Bearer ${adminToken}`)
        .expect(404);

      const { rows } = await h.admin.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM api_keys WHERE id = ${body.id}`,
      );
      expect(rows[0]!.c).toBe('1');
    });

    it('rejects an expiry that is not in the future', async () => {
      for (const when of [new Date(Date.now() - 1000), new Date(Date.now() - 86_400_000)]) {
        const res = await api(adminToken)
          .create(validCreate('past', { expiresAt: when.toISOString() }))
          .expect(400);
        expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
        expect(
          (res.body.error.details.issues as { field: string }[]).some(
            (i) => i.field === 'expiresAt',
          ),
        ).toBe(true);
      }
    });

    it('accepts a null expiry as "never expires"', async () => {
      const { body } = await createKey('forever', { expiresAt: null });
      expect(body.expiresAt).toBeNull();
      expect(body.status).toBe('active');
    });

    it('rejects an unknown permission in scopes', async () => {
      const res = await api(adminToken)
        .create(validCreate('badscope', { scopes: ['not.a.permission'] }))
        .expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('rejects unknown properties on the body', async () => {
      const res = await api(adminToken)
        .create(validCreate('extra', { keyHash: 'x', secret: 'y' }))
        .expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });
  });

  describe('list conventions', () => {
    it('answers the canonical envelopes', async () => {
      await createKey('env');
      const list = await api(adminToken).list('?limit=1').expect(200);
      expect(Object.keys(list.body.page as object).sort()).toEqual([
        'hasMore',
        'limit',
        'nextCursor',
      ]);
      expect(list.body.page.limit).toBe(1);
      expect(Array.isArray(list.body.data)).toBe(true);
    });

    it('filters by derived status', async () => {
      const live = await createKey('live');
      const dead = await createKey('dead');
      await api(adminToken).revoke(dead.body.id).expect(200);

      const active = await api(adminToken).list('?status=active').expect(200);
      expect((active.body.data as KeyBody[]).map((k) => k.id)).toEqual([live.body.id]);

      const revoked = await api(adminToken).list('?status=revoked').expect(200);
      expect((revoked.body.data as KeyBody[]).map((k) => k.id)).toEqual([dead.body.id]);
    });

    it('filters by binding scope', async () => {
      const org = await createKey('org-bound');
      const ws = await createKey('ws-bound-filter', {
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      const byType = await api(adminToken).list('?scopeType=workspace').expect(200);
      expect((byType.body.data as KeyBody[]).map((k) => k.id)).toEqual([ws.body.id]);

      const byId = await api(adminToken).list(`?scopeId=${orgA.orgId}`).expect(200);
      expect((byId.body.data as KeyBody[]).map((k) => k.id)).toEqual([org.body.id]);
    });

    it('refuses an unknown parameter and a disallowed sort', async () => {
      await api(adminToken)
        .list('?orgId=' + orgB.orgId)
        .expect(400);
      const res = await api(adminToken).list('?sort=keyHash').expect(400);
      expect(res.body.error.details.issues[0].rule).toBe('SORT_NOT_ALLOWED');
      await api(adminToken).list('?sort=lastUsedAt').expect(400);
      await api(adminToken).list('?limit=0').expect(400);
      await api(adminToken).list('?limit=101').expect(400);
      await api(adminToken).list('?cursor=nope.nope').expect(400);
    });

    it('walks every key exactly once across pages', async () => {
      const made = [await createKey('p1'), await createKey('p2'), await createKey('p3')];
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res: request.Response = await api(adminToken).list(query).expect(200);
        seen.push(...(res.body.data as KeyBody[]).map((k) => k.id));
        cursor = res.body.page.nextCursor as string | null;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      for (const m of made) expect(seen).toContain(m.body.id);
    });
  });

  describe('audit', () => {
    it('records api_key.created at the binding scope', async () => {
      const { body } = await createKey('audit-create', {
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });
      const rows = await auditRows('api_key.created');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scope_type).toBe('workspace');
      expect(rows[0]!.workspace_id).toBe(orgA.workspaceId);
      expect(rows[0]!.org_id).toBe(orgA.orgId);
      expect(rows[0]!.resource_id).toBe(body.id);
      expect(rows[0]!.actor_user_id).toBe(orgA.userId);
    });

    it('records api_key.revoked with before and after', async () => {
      const { body } = await createKey('audit-revoke');
      await purgeAudit(h.admin, sql`true`);
      await api(adminToken).revoke(body.id).expect(200);

      const rows = await auditRows('api_key.revoked');
      expect(rows).toHaveLength(1);
      expect((rows[0]!.before as { status: string }).status).toBe('active');
      expect((rows[0]!.after as { status: string }).status).toBe('revoked');
      expect(JSON.stringify(rows[0])).not.toMatch(/\$argon2/);
    });

    it('a failed audit rolls the creation back with it', async () => {
      const audit = h.app.get((await import('../src/audit/audit-writer.service')).AuditWriter) as {
        record: (...a: unknown[]) => Promise<void>;
      };
      const spy = jest.spyOn(audit, 'record').mockRejectedValue(new Error('audit unavailable'));
      let status = 0;
      try {
        const res = await api(adminToken).create(validCreate('audit-fail'));
        status = res.status;
      } finally {
        spy.mockRestore();
      }
      expect(status).toBeGreaterThanOrEqual(400);

      const { rows } = await h.admin.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM api_keys WHERE org_id = ${orgA.orgId}`,
      );
      expect(rows[0]!.c).toBe('0');
    });

    it('a refused creation writes authorization.denied and no creation record', async () => {
      const token = await powerlessToken();
      await api(token).create(validCreate('denied-audit')).expect(403);
      expect(await auditRows('api_key.created')).toHaveLength(0);
      expect(await auditRows('authorization.denied')).toHaveLength(1);
    });

    async function powerlessToken(): Promise<string> {
      const [role] = await h.admin
        .insert(schema.roles)
        .values({
          orgId: orgA.orgId,
          key: `ak_none_${uuidv7().replace(/-/g, '').slice(-6)}`,
          name: 'none',
          isSystemRole: false,
          allowedScopeTypes: ['organization'],
        })
        .returning({ id: schema.roles.id });
      const email = `ak-da-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      plantedUsers.push(user!.id);
      await h.admin.insert(schema.userRoles).values({
        userId: user!.id,
        roleId: role!.id,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });
      return tokenFor(email);
    }
  });

  describe('RLS backstop, application boundary bypassed', () => {
    const context = (tenant: TenantFixture) => ({
      orgId: tenant.orgId,
      workspaceId: null,
      resellerId: tenant.resellerId,
      userId: tenant.userId,
      isPlatformAdmin: false,
    });

    it('case 29 — another organization’s key is invisible', async () => {
      const theirs = await api(orgBAdminToken)
        .create({
          name: `rls-${uuidv7().replace(/-/g, '').slice(-8)}`,
          scopeType: 'organization',
          scopeId: orgB.orgId,
          scopes: [PERMISSIONS.WORKSPACES_READ],
        })
        .expect(201);
      const id = (theirs.body.data as KeyBody).id;

      const visible = await db.withTenant(context(orgA), (tx) =>
        tx.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(eq(schema.apiKeys.id, id)),
      );
      expect(visible).toEqual([]);
    });

    it('case 29 — a cross-tenant revocation writes nothing', async () => {
      const theirs = await api(orgBAdminToken)
        .create({
          name: `rls-w-${uuidv7().replace(/-/g, '').slice(-8)}`,
          scopeType: 'organization',
          scopeId: orgB.orgId,
          scopes: [PERMISSIONS.WORKSPACES_READ],
        })
        .expect(201);
      const id = (theirs.body.data as KeyBody).id;

      const updated = await db.withTenant(context(orgA), (tx) =>
        tx
          .update(schema.apiKeys)
          .set({ revokedAt: new Date() })
          .where(eq(schema.apiKeys.id, id))
          .returning({ id: schema.apiKeys.id }),
      );
      expect(updated).toEqual([]);

      const [row] = await h.admin
        .select({ revokedAt: schema.apiKeys.revokedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, id));
      expect(row!.revokedAt).toBeNull();
    });

    it('a cross-tenant insert is refused by the policy', async () => {
      await expect(
        db.withTenant(context(orgA), (tx) =>
          tx.insert(schema.apiKeys).values({
            orgId: orgB.orgId,
            name: 'forged',
            keyPrefix: `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`,
            keyHash: 'x',
            scopes: [],
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
