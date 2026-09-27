/**
 * Phase 1C.2 — session policy (ADR-012 F-9 … F-12, `FRONTEND_API_CONTRACT.md`
 * §31d) — security suite.
 *
 *   A  session cap and eviction (F-11)            E  refresh security
 *   B  own-session management (F-10, live list)   F  logout, incl. expired token (F-12)
 *   C  administrator revocation (F-9)             G  concurrency
 *   D  tenant manipulation                        H  audit routing and atomicity
 *   L  organization lifecycle (documented behaviour, not new policy)
 *
 * Topology (shared reseller, as every Phase 1C suite):
 *
 *     Reseller A ── A1 (active) ── workspace W1 ── team T1
 *                ├─ A2 (active)
 *                └─ S  (suspended)
 *     Reseller B ── B1 (active)
 *
 * `AUTH_MAX_SESSIONS_PER_USER` is 3 for this file. Every case drives real HTTP
 * against the real database; nothing is mocked except where a failure is
 * injected into the production code path to prove atomicity.
 */
process.env.AUTH_MAX_SESSIONS_PER_USER = '3';

import { AUDIT_ACTIONS, ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AuditWriter } from '../src/audit/audit-writer.service';
import { AccessTokenService } from '../src/auth/jwt.service';
import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

const CAP = 3;

interface Org {
  orgId: string;
  workspaceId: string;
  teamId: string;
  roles: Record<string, string>;
}

interface Person {
  userId: string;
  email: string;
}

interface Login {
  token: string;
  cookie: string;
  sessionId: string;
}

describe('Phase 1C.2 session policy', () => {
  let h: Harness;
  let credentials: CredentialService;
  let authPool: Pool;
  let resellerA: string;
  let resellerB: string;
  let a1: Org;
  let a2: Org;
  let b1: Org;
  let s: Org;
  const p: Record<string, Person> = {};
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  const createdResellers: string[] = [];
  /** Every credential this suite handled, to prove none reaches an audit row. */
  const secrets: string[] = [PASSWORD];
  let apiKey: string;

  const url = (path: string) => `/${PREFIX}${path}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string): Promise<Person> {
    const email = `${label}-${suffix()}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    createdUsers.push(u!.id);
    return { userId: u!.id, email };
  }

  async function grant(
    userId: string,
    roleId: string,
    scopeType: 'platform' | 'reseller' | 'organization' | 'workspace' | 'team',
    scopeId: string | null,
  ): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [row] = await tx
        .insert(schema.userRoles)
        .values({ userId, roleId, scopeType, scopeId })
        .returning({ id: schema.userRoles.id });
      return row!.id;
    });
  }

  async function platformRole(key: string) {
    const [r] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return r!.id;
  }

  async function createReseller(label: string) {
    const [r] = await h.admin
      .insert(schema.resellers)
      .values({ name: `R ${label}`, slug: `rs-${label}-${suffix()}` })
      .returning({ id: schema.resellers.id });
    createdResellers.push(r!.id);
    return r!.id;
  }

  async function plantOrg(label: string, resellerId: string): Promise<Org> {
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({ name: `O ${label}`, slug: `o-${label}-${suffix()}`, resellerId })
      .returning({ id: schema.organizations.id });
    const orgId = org!.id;
    createdOrgs.push(orgId);
    const [ws] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: 'Default', slug: 'default', isDefault: true })
      .returning({ id: schema.workspaces.id });
    const [team] = await h.admin
      .insert(schema.teams)
      .values({ orgId, workspaceId: ws!.id, name: `T ${label}` })
      .returning({ id: schema.teams.id });
    const provisioner = h.app.get(TenantRoleProvisioner);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, orgId, {
        correlationId: uuidv7(),
      });
    });
    const rows = await h.admin
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, orgId));
    return {
      orgId,
      workspaceId: ws!.id,
      teamId: team!.id,
      roles: Object.fromEntries(rows.map((r) => [r.key, r.id])),
    };
  }

  /** A custom role in `org` carrying the session permissions, admitted only at `scopeType`. */
  async function sessionAdminRole(org: Org, scopeType: 'workspace' | 'team'): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: org.orgId,
          key: `${scopeType}_session_admin_${suffix()}`,
          name: `${scopeType} session admin`,
          isSystemRole: false,
          allowedScopeTypes: [scopeType],
        })
        .returning({ id: schema.roles.id });
      const perms = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(inArray(schema.permissions.key, ['sessions.read', 'sessions.revoke', 'users.read']));
      for (const perm of perms) {
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: perm.id });
      }
      return role!.id;
    });
  }

  // --- HTTP helpers -------------------------------------------------------------

  const server = () => h.app.getHttpServer();

  const call = (
    method: 'get' | 'post' | 'delete',
    token: string,
    path: string,
    org?: string,
  ): request.Test => {
    const r = request(server())[method](url(path)).set('authorization', `Bearer ${token}`);
    return org ? r.set('x-acc-organization', org) : r;
  };

  const sidOf = (token: string): string =>
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).sid as string;

  const cookieFrom = (res: request.Response): string => {
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const match = raw.map((c) => /acc_refresh=([^;]*)/.exec(c)).find(Boolean);
    return match ? match[1]! : '';
  };

  async function loginRaw(email: string, clear = true): Promise<request.Response> {
    if (clear) await h.clearRateLimits();
    return request(server()).post(url('/auth/login')).send({ email, password: PASSWORD });
  }

  async function login(person: Person, clear = true): Promise<Login> {
    const res = await loginRaw(person.email, clear);
    expect(res.status).toBe(200);
    const token = res.body.data.accessToken as string;
    const cookie = cookieFrom(res);
    secrets.push(token, cookie);
    return { token, cookie, sessionId: sidOf(token) };
  }

  async function refreshRaw(cookie: string, clear = true): Promise<request.Response> {
    if (clear) await h.clearRateLimits();
    return request(server())
      .post(url('/auth/refresh'))
      .set('Cookie', `acc_refresh=${cookie}`)
      .set('X-Acc-Refresh', '1');
  }

  const me = (token: string) => call('get', token, '/auth/me');

  /** An error body minus its per-request correlation id, for byte-identity comparisons. */
  const withoutCorrelation = (error: Record<string, unknown>) => {
    const { correlationId: _ignored, ...rest } = error;
    return rest;
  };

  // --- database probes --------------------------------------------------------------

  async function liveSessions(userId: string) {
    const { rows } = await h.admin.execute<{ id: string; family_id: string; created_at: Date }>(
      sql`SELECT id, family_id, created_at FROM sessions
           WHERE user_id = ${userId} AND revoked_at IS NULL AND rotated_at IS NULL
             AND expires_at > now()
           ORDER BY created_at, id`,
    );
    return rows;
  }

  async function sessionRow(id: string) {
    const { rows } = await h.admin.execute<{
      id: string;
      family_id: string;
      revoked_at: Date | null;
      revoked_reason: string | null;
      rotated_at: Date | null;
    }>(
      sql`SELECT id, family_id, revoked_at, revoked_reason, rotated_at FROM sessions WHERE id = ${id}`,
    );
    return rows[0];
  }

  async function liveInFamily(familyId: string) {
    const { rows } = await h.admin.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM sessions
           WHERE family_id = ${familyId} AND revoked_at IS NULL AND rotated_at IS NULL
             AND expires_at > now()`,
    );
    return rows[0]!.n;
  }

  async function resetSessions(userId: string) {
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
  }

  async function auditRows(where: ReturnType<typeof sql>) {
    const { rows } = await h.admin.execute<Record<string, unknown>>(
      sql`SELECT * FROM audit_logs WHERE ${where} ORDER BY id`,
    );
    return rows;
  }

  // --- setup ------------------------------------------------------------------------

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    authPool = new Pool({ connectionString: process.env.DATABASE_AUTH_URL!, max: 2 });

    resellerA = await createReseller('sp-a');
    resellerB = await createReseller('sp-b');
    a1 = await plantOrg('sp-a1', resellerA);
    a2 = await plantOrg('sp-a2', resellerA);
    b1 = await plantOrg('sp-b1', resellerB);
    s = await plantOrg('sp-s', resellerA);

    const RO = TENANT_ROLE_KEYS.READ_ONLY;
    const ADMIN = TENANT_ROLE_KEYS.ORG_ADMIN;

    p.adminA1 = await createUser('sp-admin-a1');
    await grant(p.adminA1.userId, a1.roles[ADMIN]!, 'organization', a1.orgId);
    p.adminB1 = await createUser('sp-admin-b1');
    await grant(p.adminB1.userId, b1.roles[ADMIN]!, 'organization', b1.orgId);

    for (const name of ['cap', 'own', 'race', 'disable', 'tOrg']) {
      p[name] = await createUser(`sp-${name}`);
      await grant(p[name]!.userId, a1.roles[RO]!, 'organization', a1.orgId);
    }
    p.tWs = await createUser('sp-t-ws');
    await grant(p.tWs.userId, a1.roles[RO]!, 'workspace', a1.workspaceId);
    p.tTeam = await createUser('sp-t-team');
    await grant(p.tTeam.userId, a1.roles[RO]!, 'team', a1.teamId);
    p.tTwoOrgs = await createUser('sp-t-two-orgs');
    await grant(p.tTwoOrgs.userId, a1.roles[RO]!, 'organization', a1.orgId);
    await grant(p.tTwoOrgs.userId, a2.roles[RO]!, 'organization', a2.orgId);
    p.tReseller = await createUser('sp-t-reseller');
    await grant(p.tReseller.userId, a1.roles[RO]!, 'organization', a1.orgId);
    await grant(
      p.tReseller.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );
    p.tPlatform = await createUser('sp-t-platform');
    await grant(p.tPlatform.userId, a1.roles[RO]!, 'organization', a1.orgId);
    await grant(
      p.tPlatform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );

    p.platform = await createUser('sp-platform');
    await grant(
      p.platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    p.support = await createUser('sp-support');
    await grant(
      p.support.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    p.resellerAdmin = await createUser('sp-reseller-admin');
    await grant(
      p.resellerAdmin.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );
    p.wsAdmin = await createUser('sp-ws-admin');
    await grant(
      p.wsAdmin.userId,
      await sessionAdminRole(a1, 'workspace'),
      'workspace',
      a1.workspaceId,
    );
    p.teamAdmin = await createUser('sp-team-admin');
    await grant(p.teamAdmin.userId, await sessionAdminRole(a1, 'team'), 'team', a1.teamId);

    // S: a member and an administrator, then suspended.
    p.sMember = await createUser('sp-s-member');
    await grant(p.sMember.userId, s.roles[RO]!, 'organization', s.orgId);
    p.sAdmin = await createUser('sp-s-admin');
    await grant(p.sAdmin.userId, s.roles[ADMIN]!, 'organization', s.orgId);
    await h.admin
      .update(schema.organizations)
      .set({ status: 'suspended', statusChangedAt: new Date() })
      .where(eq(schema.organizations.id, s.orgId));

    // An API key of A1's administrator, asking for both session permissions.
    const prefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
    const secret = `s${uuidv7().replace(/-/g, '')}${uuidv7().replace(/-/g, '')}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: a1.orgId,
      name: `sp-${prefix}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: ['sessions.read', 'sessions.revoke', 'users.read'],
      createdBy: p.adminA1.userId,
    });
    apiKey = `${prefix}.${secret}`;
    secrets.push(apiKey, secret);
  }, 240_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.clearRateLimits();
    await authPool.end();
    const orgs = [...new Set(createdOrgs)];
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
    await purgeAudit(
      h.admin,
      sql`org_id IN (${list(orgs)}) OR actor_user_id IN (${list(createdUsers)}) OR actor_api_key_id IN (SELECT id FROM api_keys WHERE org_id IN (${list(orgs)})) OR reseller_id IN (${list(createdResellers)})`,
    );
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(
          sql`DELETE FROM user_roles WHERE user_id IN (${list(createdUsers)}) OR org_id IN (${list(orgs)})`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      for (const table of [
        'role_permissions',
        'roles',
        'ws_tickets',
        'api_keys',
        'idempotency_keys',
        'teams',
        'workspaces',
      ]) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(orgs)})`);
      }
    });
    await h.admin.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgs)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.delete(schema.resellers).where(inArray(schema.resellers.id, createdResellers));
    await h.close();
    delete process.env.AUTH_MAX_SESSIONS_PER_USER;
  }, 240_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===========================================================================
  describe('A. session cap and eviction (F-11)', () => {
    beforeEach(() => resetSessions(p.cap!.userId));

    it('at the cap, the oldest live session is evicted, audited, and dead on its next use; the new one survives', async () => {
      const first = await login(p.cap!);
      const second = await login(p.cap!);
      const third = await login(p.cap!);
      expect((await liveSessions(p.cap!.userId)).map((r) => r.id)).toEqual([
        first.sessionId,
        second.sessionId,
        third.sessionId,
      ]);

      const fourth = await login(p.cap!);
      expect((await liveSessions(p.cap!.userId)).map((r) => r.id)).toEqual([
        second.sessionId,
        third.sessionId,
        fourth.sessionId,
      ]);
      const evicted = await sessionRow(first.sessionId);
      expect(evicted!.revoked_reason).toBe('session_limit_exceeded');

      const [audit] = await auditRows(
        sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED} AND resource_id = ${first.sessionId}`,
      );
      expect(audit).toMatchObject({
        scope_type: 'platform',
        actor_type: 'user',
        actor_user_id: p.cap!.userId,
        outcome: 'success',
      });
      expect(audit!.metadata).toEqual({
        reason: 'session_limit_exceeded',
        evictedBy: fourth.sessionId,
      });

      const dead = await me(first.token);
      expect(dead.status).toBe(401);
      expect(dead.body.error.code).toBe(ERROR_CODES.AUTH_SESSION_REVOKED);
      expect((await refreshRaw(first.cookie)).status).toBe(401);
      await me(fourth.token).expect(200);
    });

    it('revoked, expired and rotated sessions do not count toward the cap', async () => {
      const revoked = await login(p.cap!);
      const expired = await login(p.cap!);
      const rotated = await login(p.cap!);
      await h.admin.execute(
        sql`UPDATE sessions SET revoked_at = now(), revoked_reason = 'test' WHERE id = ${revoked.sessionId}`,
      );
      await h.admin.execute(
        sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = ${expired.sessionId}`,
      );
      const successor = await refreshRaw(rotated.cookie);
      expect(successor.status).toBe(200);
      // Live now: only the successor of `rotated`.
      expect(await liveSessions(p.cap!.userId)).toHaveLength(1);

      await login(p.cap!);
      await login(p.cap!);
      expect(await liveSessions(p.cap!.userId)).toHaveLength(CAP);
      const evictions = await h.admin.execute(
        sql`SELECT 1 FROM sessions WHERE user_id = ${p.cap!.userId} AND revoked_reason = 'session_limit_exceeded'`,
      );
      expect(evictions.rows).toHaveLength(0);
    });

    it('eviction order is deterministic: identical creation times fall back to the lower id', async () => {
      const logins = [await login(p.cap!), await login(p.cap!), await login(p.cap!)];
      await h.admin.execute(
        sql`UPDATE sessions SET created_at = '2026-01-01T00:00:00Z' WHERE user_id = ${p.cap!.userId}`,
      );
      const lowest = [...logins.map((l) => l.sessionId)].sort()[0]!;
      await login(p.cap!);
      expect((await sessionRow(lowest))!.revoked_reason).toBe('session_limit_exceeded');
      expect(await liveSessions(p.cap!.userId)).toHaveLength(CAP);
    });

    it('G. six concurrent logins never leave more than the cap live — for several rounds', async () => {
      for (let round = 0; round < 3; round++) {
        await h.clearRateLimits();
        const results = await Promise.all(
          Array.from({ length: 6 }, () => loginRaw(p.cap!.email, false)),
        );
        expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
        expect(await liveSessions(p.cap!.userId)).toHaveLength(CAP);
      }
      // 18 logins, at most 3 alive: exactly 15 evictions, each audited once.
      const evictions = await h.admin.execute<{ id: string }>(
        sql`SELECT id FROM sessions WHERE user_id = ${p.cap!.userId} AND revoked_reason = 'session_limit_exceeded'`,
      );
      expect(evictions.rows).toHaveLength(15);
      const audited = await auditRows(
        sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED} AND actor_user_id = ${p.cap!.userId}
            AND resource_id IN (${sql.join(
              evictions.rows.map((r) => sql`${r.id}`),
              sql`, `,
            )})`,
      );
      expect(audited).toHaveLength(15);
    });
  });

  // ===========================================================================
  describe('B. own-session management (live list, chain revocation, revoke-all)', () => {
    beforeEach(() => resetSessions(p.own!.userId));

    it('GET /auth/sessions lists only live sessions — never rotated, expired or revoked ones', async () => {
      const a = await login(p.own!);
      const b = await login(p.own!);
      const c = await login(p.own!);
      const rotated = await refreshRaw(a.cookie);
      const aNext = rotated.body.data.accessToken as string;
      secrets.push(aNext, cookieFrom(rotated));
      await h.admin.execute(
        sql`UPDATE sessions SET revoked_at = now(), revoked_reason = 'test' WHERE id = ${b.sessionId}`,
      );
      await h.admin.execute(
        sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = ${c.sessionId}`,
      );

      const listed = await call('get', aNext, '/auth/sessions').expect(200);
      const ids = listed.body.data.map((x: { id: string }) => x.id);
      expect(ids).toEqual([sidOf(aNext)]);
      expect(listed.body.data[0].current).toBe(true);
      for (const gone of [a.sessionId, b.sessionId, c.sessionId]) expect(ids).not.toContain(gone);
      // History is kept, not deleted.
      for (const kept of [a.sessionId, b.sessionId, c.sessionId]) {
        expect(await sessionRow(kept)).toBeDefined();
      }

      const d = await login(p.own!);
      const again = await call('get', d.token, '/auth/sessions').expect(200);
      expect(new Set(again.body.data.map((x: { id: string }) => x.id))).toEqual(
        new Set([sidOf(aNext), d.sessionId]),
      );
    });

    it('DELETE /auth/sessions/:id revokes the whole rotation chain, audited through acc_auth in the same transaction (Phase 1B defect corrected)', async () => {
      const device = await login(p.own!);
      const other = await login(p.own!);
      const rotated = await refreshRaw(device.cookie);
      expect(rotated.status).toBe(200);
      const successorToken = rotated.body.data.accessToken as string;
      const successorCookie = cookieFrom(rotated);
      secrets.push(successorToken, successorCookie);

      // The id the client listed before the refresh — now spent — still names the device.
      await call('delete', other.token, `/auth/sessions/${device.sessionId}`).expect(204);
      expect(await liveInFamily((await sessionRow(device.sessionId))!.family_id)).toBe(0);
      expect((await me(successorToken)).status).toBe(401);
      expect((await refreshRaw(successorCookie)).status).toBe(401);
      await me(other.token).expect(200);

      const [audit] = await auditRows(
        sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED} AND resource_id = ${device.sessionId}`,
      );
      expect(audit).toMatchObject({
        scope_type: 'platform',
        org_id: null,
        actor_type: 'user',
        actor_user_id: p.own!.userId,
      });
      expect(audit!.metadata).toEqual({ self: false });

      // A repeat has nothing live to revoke: 404, as for an unknown id.
      const repeat = await call('delete', other.token, `/auth/sessions/${device.sessionId}`);
      expect(repeat.status).toBe(404);
      const unknown = await call('delete', other.token, `/auth/sessions/${uuidv7()}`);
      expect(unknown.status).toBe(404);
      expect(withoutCorrelation(repeat.body.error)).toEqual(withoutCorrelation(unknown.body.error));
    });

    it("another user's session is 404, byte-identical to an unknown id, and untouched", async () => {
      const mine = await login(p.own!);
      const theirs = await login(p.tOrg!);
      const foreign = await call('delete', mine.token, `/auth/sessions/${theirs.sessionId}`);
      const unknown = await call('delete', mine.token, `/auth/sessions/${uuidv7()}`);
      expect(foreign.status).toBe(404);
      expect(withoutCorrelation(foreign.body.error)).toEqual(
        withoutCorrelation(unknown.body.error),
      );
      expect((await sessionRow(theirs.sessionId))!.revoked_at).toBeNull();
    });

    it('revoke-all keeps the current session, revokes every other chain, returns the count, and is audited', async () => {
      const x = await login(p.own!);
      const y = await login(p.own!);
      const current = await login(p.own!);

      const res = await call('post', current.token, '/auth/sessions/revoke-all').expect(200);
      expect(res.body).toEqual({ data: { revoked: 2 } });
      await me(current.token).expect(200);
      for (const gone of [x, y]) {
        expect((await me(gone.token)).status).toBe(401);
        expect((await refreshRaw(gone.cookie)).status).toBe(401);
      }
      const [audit] = await auditRows(
        sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED_ALL} AND actor_user_id = ${p.own!.userId}`,
      );
      expect(audit).toMatchObject({ scope_type: 'platform', resource_id: current.sessionId });
      expect(audit!.after).toEqual({ revoked: 2 });

      const again = await call('post', current.token, '/auth/sessions/revoke-all').expect(200);
      expect(again.body).toEqual({ data: { revoked: 0 } });
    });

    it('revoke-all is for a session principal: an API key is refused', async () => {
      const res = await call('post', apiKey, '/auth/sessions/revoke-all');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });
  });

  // ===========================================================================
  describe('E. refresh security', () => {
    beforeEach(() => resetSessions(p.own!.userId));

    it('revoked, expired, unknown and replayed refresh tokens are all refused; the cookie decides the identity', async () => {
      const revoked = await login(p.own!);
      await h.admin.execute(
        sql`UPDATE sessions SET revoked_at = now(), revoked_reason = 'test' WHERE id = ${revoked.sessionId}`,
      );
      expect((await refreshRaw(revoked.cookie)).status).toBe(401);

      const expired = await login(p.own!);
      await h.admin.execute(
        sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = ${expired.sessionId}`,
      );
      expect((await refreshRaw(expired.cookie)).status).toBe(401);

      expect((await refreshRaw(`forged-${uuidv7()}`)).status).toBe(401);

      const live = await login(p.own!);
      const rotated = await refreshRaw(live.cookie);
      expect(rotated.status).toBe(200);
      secrets.push(rotated.body.data.accessToken, cookieFrom(rotated));
      // The refreshed token belongs to the cookie's owner, whatever else is presented.
      const who = await me(rotated.body.data.accessToken).expect(200);
      expect(who.body.data.userId).toBe(p.own!.userId);
      // Replaying the spent token revokes the whole chain.
      expect((await refreshRaw(live.cookie)).status).toBe(401);
      expect(await liveInFamily((await sessionRow(live.sessionId))!.family_id)).toBe(0);
    });
  });

  // ===========================================================================
  describe('F. logout (F-12)', () => {
    beforeEach(() => resetSessions(p.own!.userId));

    const logout = (opts: { bearer?: string; cookie?: string; csrf?: boolean }) => {
      let r = request(server()).post(url('/auth/logout'));
      if (opts.bearer) r = r.set('authorization', `Bearer ${opts.bearer}`);
      if (opts.cookie !== undefined) r = r.set('Cookie', `acc_refresh=${opts.cookie}`);
      if (opts.csrf !== false) r = r.set('X-Acc-Refresh', '1');
      return r;
    };
    const clearsCookie = (res: request.Response) =>
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .some((c) => /^acc_refresh=;/.test(c));

    it('an expired access token with a valid refresh cookie still revokes the session chain', async () => {
      const device = await login(p.own!);
      const tokens = h.app.get(AccessTokenService);
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now - 2 * 60 * 60 * 1000);
      const expired = tokens.issue({ userId: p.own!.userId, sessionId: device.sessionId }).token;
      clock.mockRestore();
      secrets.push(expired);
      expect((await me(expired)).status).toBe(401);

      await h.clearRateLimits();
      const res = await logout({ bearer: expired, cookie: device.cookie }).expect(204);
      expect(res.text).toBe('');
      expect(clearsCookie(res)).toBe(true);
      expect(await liveInFamily((await sessionRow(device.sessionId))!.family_id)).toBe(0);
      expect((await refreshRaw(device.cookie)).status).toBe(401);

      const [audit] = await auditRows(
        sql`action = ${AUDIT_ACTIONS.AUTH_LOGOUT} AND resource_id = ${device.sessionId}`,
      );
      expect(audit).toMatchObject({ actor_user_id: p.own!.userId, scope_type: 'platform' });
      expect(audit!.metadata).toEqual({ via: 'refresh_cookie' });
    });

    it('unknown and already-revoked cookies are answered identically (204, cookie cleared), revoke nothing and write nothing', async () => {
      const device = await login(p.own!);
      await h.clearRateLimits();
      const unknown = await logout({ cookie: `unknown-${uuidv7()}` }).expect(204);
      expect(clearsCookie(unknown)).toBe(true);
      expect((await sessionRow(device.sessionId))!.revoked_at).toBeNull();

      await logout({ cookie: device.cookie }).expect(204);
      const repeated = await logout({ cookie: device.cookie }).expect(204);
      expect(repeated.text).toBe(unknown.text);
      expect(Object.keys(repeated.body)).toEqual(Object.keys(unknown.body));

      const logouts = await auditRows(
        sql`action = ${AUDIT_ACTIONS.AUTH_LOGOUT} AND resource_id = ${device.sessionId}`,
      );
      expect(logouts).toHaveLength(1);
    });

    it('the cookie path requires X-Acc-Refresh; with no credential at all the answer is 401', async () => {
      const device = await login(p.own!);
      await h.clearRateLimits();
      expect((await logout({ cookie: device.cookie, csrf: false })).status).toBe(403);
      expect((await sessionRow(device.sessionId))!.revoked_at).toBeNull();
      expect((await logout({})).status).toBe(401);
    });

    it('the cookie path is throttled with the refresh bucket — it cannot bypass the Gate B limiter', async () => {
      const device = await login(p.own!);
      await h.clearRateLimits();
      let limited: request.Response | null = null;
      for (let i = 0; i < 500 && !limited; i++) {
        const res = await logout({ cookie: `unknown-${i}-${uuidv7()}` });
        if (res.status === 429) limited = res;
        else expect(res.status).toBe(204);
      }
      expect(limited).not.toBeNull();
      expect(limited!.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
      expect(limited!.headers['retry-after']).toBeDefined();
      // Throttled means nothing happened: the real cookie is not honoured either.
      expect((await logout({ cookie: device.cookie })).status).toBe(429);
      expect((await sessionRow(device.sessionId))!.revoked_at).toBeNull();
      await h.clearRateLimits();
    });

    it('the bearer path still revokes the chain, including a successor minted by a refresh', async () => {
      const device = await login(p.own!);
      const rotated = await refreshRaw(device.cookie);
      const next = rotated.body.data.accessToken as string;
      secrets.push(next, cookieFrom(rotated));
      await logout({ bearer: next }).expect(204);
      expect(await liveInFamily((await sessionRow(device.sessionId))!.family_id)).toBe(0);
    });
  });

  // ===========================================================================
  describe('G. concurrency: refresh never outlives a revocation; no deadlock with disable', () => {
    beforeEach(() => resetSessions(p.race!.userId));

    it('a refresh racing a chain revocation never leaves a usable successor', async () => {
      for (let round = 0; round < 6; round++) {
        const device = await login(p.race!);
        const other = await login(p.race!);
        await h.clearRateLimits();
        const [refreshed] = await Promise.all([
          refreshRaw(device.cookie, false),
          call('delete', other.token, `/auth/sessions/${device.sessionId}`),
        ]);
        expect(await liveInFamily((await sessionRow(device.sessionId))!.family_id)).toBe(0);
        if (refreshed.status === 200) {
          secrets.push(refreshed.body.data.accessToken, cookieFrom(refreshed));
          expect((await me(refreshed.body.data.accessToken)).status).toBe(401);
        }
        await resetSessions(p.race!.userId);
      }
    });

    it('a refresh racing self revoke-all never leaves a usable successor', async () => {
      for (let round = 0; round < 6; round++) {
        const device = await login(p.race!);
        const current = await login(p.race!);
        await h.clearRateLimits();
        const [refreshed, revoked] = await Promise.all([
          refreshRaw(device.cookie, false),
          call('post', current.token, '/auth/sessions/revoke-all'),
        ]);
        expect(revoked.status).toBe(200);
        expect(await liveInFamily((await sessionRow(device.sessionId))!.family_id)).toBe(0);
        if (refreshed.status === 200) {
          secrets.push(refreshed.body.data.accessToken, cookieFrom(refreshed));
          expect((await me(refreshed.body.data.accessToken)).status).toBe(401);
        }
        await resetSessions(p.race!.userId);
      }
    });

    it('a refresh racing an administrator revoke-all never leaves a usable successor', async () => {
      const admin = await login(p.adminA1!);
      for (let round = 0; round < 6; round++) {
        const device = await login(p.race!);
        await h.clearRateLimits();
        const [refreshed, revoked] = await Promise.all([
          refreshRaw(device.cookie, false),
          call('post', admin.token, `/users/${p.race!.userId}/sessions/revoke-all`),
        ]);
        expect(revoked.status).toBe(200);
        expect(await liveSessions(p.race!.userId)).toHaveLength(0);
        if (refreshed.status === 200) {
          secrets.push(refreshed.body.data.accessToken, cookieFrom(refreshed));
          expect((await me(refreshed.body.data.accessToken)).status).toBe(401);
        }
        await resetSessions(p.race!.userId);
      }
    });

    it('logins racing revocations (self and administrator) and refreshes keep the cap and complete', async () => {
      const admin = await login(p.adminA1!);
      for (let round = 0; round < 4; round++) {
        const seedA = await login(p.race!);
        const seedB = await login(p.race!);
        const current = await login(p.race!);
        await h.clearRateLimits();
        const results = await Promise.all([
          loginRaw(p.race!.email, false),
          loginRaw(p.race!.email, false),
          refreshRaw(seedA.cookie, false),
          call('delete', current.token, `/auth/sessions/${seedB.sessionId}`),
          call('post', current.token, '/auth/sessions/revoke-all'),
          call('post', admin.token, `/users/${p.race!.userId}/sessions/revoke-all`),
        ]);
        for (const r of results) expect(r.status).toBeLessThan(500);
        expect((await liveSessions(p.race!.userId)).length).toBeLessThanOrEqual(CAP);
        await resetSessions(p.race!.userId);
      }
    });

    it('a user disable racing that user’s logins never deadlocks and never leaves a live session', async () => {
      const admin = await login(p.adminA1!);
      for (let round = 0; round < 5; round++) {
        await login(p.disable!);
        await h.clearRateLimits();
        const [first, disabled, second] = await Promise.all([
          loginRaw(p.disable!.email, false),
          call('post', admin.token, `/users/${p.disable!.userId}/disable`),
          loginRaw(p.disable!.email, false),
        ]);
        expect(disabled.status).toBe(200);
        for (const r of [first, second]) expect([200, 401]).toContain(r.status);
        expect(await liveSessions(p.disable!.userId)).toHaveLength(0);
        await call('post', admin.token, `/users/${p.disable!.userId}/reactivate`).expect(200);
        await resetSessions(p.disable!.userId);
      }
    });
  });

  // ===========================================================================
  describe('C. administrator revocation (F-9): every grant the target holds must be covered', () => {
    let admin: Login;
    beforeAll(async () => {
      admin = await login(p.adminA1!);
    });

    it('an organization administrator lists and revokes users it fully covers — organization, workspace and team grants', async () => {
      for (const target of [p.tOrg!, p.tWs!, p.tTeam!]) {
        await resetSessions(target.userId);
        const t1 = await login(target);
        await login(target);
        const listed = await call('get', admin.token, `/users/${target.userId}/sessions`).expect(
          200,
        );
        expect(listed.body.data).toHaveLength(2);
        expect(listed.body.page).toBeUndefined();
        expect(Object.keys(listed.body.data[0]).sort()).toEqual(
          ['createdAt', 'current', 'expiresAt', 'id', 'ip', 'lastUsedAt', 'userAgent'].sort(),
        );

        const res = await call('post', admin.token, `/users/${target.userId}/sessions/revoke-all`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { revoked: 2 } });
        expect(await liveSessions(target.userId)).toHaveLength(0);
        expect((await me(t1.token)).status).toBe(401);

        const [audit] = await auditRows(
          sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED_ALL} AND resource_id = ${target.userId} AND actor_user_id = ${p.adminA1!.userId}`,
        );
        expect(audit).toMatchObject({ scope_type: 'organization', org_id: a1.orgId });
        expect(audit!.after).toEqual({ revoked: 2 });
      }
    });

    it('DELETE /users/:id/sessions/:sessionId revokes one chain; a repeat or another user’s session is 404', async () => {
      await resetSessions(p.tOrg!.userId);
      const keep = await login(p.tOrg!);
      const drop = await login(p.tOrg!);
      await call(
        'delete',
        admin.token,
        `/users/${p.tOrg!.userId}/sessions/${drop.sessionId}`,
      ).expect(204);
      expect((await me(drop.token)).status).toBe(401);
      await me(keep.token).expect(200);
      expect(
        (await call('delete', admin.token, `/users/${p.tOrg!.userId}/sessions/${drop.sessionId}`))
          .status,
      ).toBe(404);

      const theirs = await login(p.tWs!);
      const mismatched = await call(
        'delete',
        admin.token,
        `/users/${p.tOrg!.userId}/sessions/${theirs.sessionId}`,
      );
      expect(mismatched.status).toBe(404);
      expect((await sessionRow(theirs.sessionId))!.revoked_at).toBeNull();
      const [audit] = await auditRows(
        sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED} AND resource_id = ${drop.sessionId}`,
      );
      expect(audit).toMatchObject({ scope_type: 'organization', org_id: a1.orgId });
    });

    it('a target holding a grant in another organization, at a reseller, or at platform is 403 — audited, nothing revoked, no foreign id recorded', async () => {
      for (const target of [p.tTwoOrgs!, p.tReseller!, p.tPlatform!]) {
        await resetSessions(target.userId);
        const t = await login(target);
        for (const [method, path] of [
          ['get', `/users/${target.userId}/sessions`],
          ['post', `/users/${target.userId}/sessions/revoke-all`],
          ['delete', `/users/${target.userId}/sessions/${t.sessionId}`],
        ] as const) {
          const res = await call(method, admin.token, path);
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
        }
        await me(t.token).expect(200);
        expect(await liveSessions(target.userId)).toHaveLength(1);

        const denials = await auditRows(
          sql`action = ${AUDIT_ACTIONS.AUTHORIZATION_DENIED} AND actor_user_id = ${p.adminA1!.userId} AND resource_id = ${target.userId}`,
        );
        expect(denials.length).toBeGreaterThanOrEqual(3);
        for (const d of denials) {
          expect(d.org_id).toBe(a1.orgId);
          expect(d.metadata).toMatchObject({ denialDetail: 'subject_holds_uncovered_grant' });
          const text = JSON.stringify(d);
          expect(text).not.toContain(a2.orgId);
          expect(text).not.toContain(resellerA);
        }
      }
    });

    it('cross-reseller: an organization administrator of B1 gets 404 for an A1 user', async () => {
      const b = await login(p.adminB1!);
      const listed = await call('get', b.token, `/users/${p.tOrg!.userId}/sessions`);
      expect(listed.status).toBe(404);
      const revoked = await call('post', b.token, `/users/${p.tOrg!.userId}/sessions/revoke-all`);
      expect(revoked.status).toBe(404);
      expect(JSON.stringify(revoked.body)).not.toContain(p.tOrg!.userId);
    });

    it('a platform super administrator covers every grant and may revoke a user spanning organizations, reseller and platform', async () => {
      const platform = await login(p.platform!);
      for (const target of [p.tTwoOrgs!, p.tReseller!, p.tPlatform!]) {
        await resetSessions(target.userId);
        await login(target);
        const res = await call(
          'post',
          platform.token,
          `/users/${target.userId}/sessions/revoke-all`,
          a1.orgId,
        );
        expect(res.status).toBe(200);
        expect(res.body.data.revoked).toBe(1);
      }
    });

    it('support can list (it holds sessions.read everywhere) but never revoke', async () => {
      const support = await login(p.support!);
      await resetSessions(p.tTwoOrgs!.userId);
      await login(p.tTwoOrgs!);
      await call('get', support.token, `/users/${p.tTwoOrgs!.userId}/sessions`, a1.orgId).expect(
        200,
      );
      const res = await call(
        'post',
        support.token,
        `/users/${p.tTwoOrgs!.userId}/sessions/revoke-all`,
        a1.orgId,
      );
      expect(res.status).toBe(403);
      expect(await liveSessions(p.tTwoOrgs!.userId)).toHaveLength(1);
    });

    it('frozen roles: a reseller administrator has no session permission; workspace and team session admins cannot act at the organization', async () => {
      await resetSessions(p.tWs!.userId);
      await resetSessions(p.tTeam!.userId);
      await login(p.tWs!);
      await login(p.tTeam!);

      const reseller = await login(p.resellerAdmin!);
      for (const [method, path] of [
        ['get', `/users/${p.tOrg!.userId}/sessions`],
        ['post', `/users/${p.tOrg!.userId}/sessions/revoke-all`],
      ] as const) {
        expect((await call(method, reseller.token, path, a1.orgId)).status).toBe(403);
      }

      const wsAdmin = await login(p.wsAdmin!);
      const teamAdmin = await login(p.teamAdmin!);
      expect((await call('get', wsAdmin.token, `/users/${p.tWs!.userId}/sessions`)).status).toBe(
        403,
      );
      expect(
        (await call('post', wsAdmin.token, `/users/${p.tWs!.userId}/sessions/revoke-all`)).status,
      ).toBe(403);
      expect(
        (await call('post', teamAdmin.token, `/users/${p.tTeam!.userId}/sessions/revoke-all`))
          .status,
      ).toBe(403);
      expect(await liveSessions(p.tWs!.userId)).toHaveLength(1);
      expect(await liveSessions(p.tTeam!.userId)).toHaveLength(1);
    });

    it('an API key may list within its coverage but can never revoke another user’s sessions', async () => {
      await resetSessions(p.tOrg!.userId);
      const t = await login(p.tOrg!);
      await call('get', apiKey, `/users/${p.tOrg!.userId}/sessions`).expect(200);
      for (const [method, path] of [
        ['post', `/users/${p.tOrg!.userId}/sessions/revoke-all`],
        ['delete', `/users/${p.tOrg!.userId}/sessions/${t.sessionId}`],
      ] as const) {
        const res = await call(method, apiKey, path);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      }
      await me(t.token).expect(200);
    });
  });

  // ===========================================================================
  describe('D. tenant manipulation cannot broaden session administration', () => {
    it('a forged X-Acc-Organization is refused; a client-supplied orgId changes nothing', async () => {
      const admin = await login(p.adminA1!);
      for (const org of [a2.orgId, b1.orgId]) {
        const res = await call(
          'post',
          admin.token,
          `/users/${p.tTwoOrgs!.userId}/sessions/revoke-all`,
          org,
        );
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      }
      const withQuery = await call(
        'post',
        admin.token,
        `/users/${p.tTwoOrgs!.userId}/sessions/revoke-all?orgId=${a2.orgId}`,
      );
      expect(withQuery.status).not.toBe(200);
      expect((await liveSessions(p.tTwoOrgs!.userId)).length).toBeGreaterThanOrEqual(0);
    });

    it('a stale context confers nothing: once the administrator’s grant is gone, its still-valid token cannot revoke', async () => {
      const admin = await login(p.adminA1!);
      await resetSessions(p.tOrg!.userId);
      await login(p.tOrg!);
      await h.admin.execute(
        sql`DELETE FROM user_roles WHERE user_id = ${p.adminA1!.userId} AND org_id = ${a1.orgId}`,
      );
      try {
        const res = await call('post', admin.token, `/users/${p.tOrg!.userId}/sessions/revoke-all`);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        const pinned = await call(
          'post',
          admin.token,
          `/users/${p.tOrg!.userId}/sessions/revoke-all`,
          a1.orgId,
        );
        expect(pinned.status).toBe(403);
        expect(await liveSessions(p.tOrg!.userId)).toHaveLength(1);
      } finally {
        await grant(
          p.adminA1!.userId,
          a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
          'organization',
          a1.orgId,
        );
      }
    });
  });

  // ===========================================================================
  describe('H. audit routing: the approved acc_auth session actions, and nothing else', () => {
    const tryInsert = async (action: string, scopeType = 'platform', actorUserId?: string) => {
      const client = await authPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO audit_logs (scope_type, scope_id, actor_type, actor_user_id, action, resource_type, outcome, correlation_id)
           VALUES ($1, $2, 'user', $3, $4, 'probe', 'success', $5)`,
          [
            scopeType,
            scopeType === 'platform' ? null : a1.orgId,
            actorUserId ?? p.own!.userId,
            action,
            uuidv7(),
          ],
        );
        return 'accepted';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };

    it('acc_auth may write session.revoked and session.revoked_all at platform scope', async () => {
      expect(await tryInsert(AUDIT_ACTIONS.SESSION_REVOKED)).toBe('accepted');
      expect(await tryInsert(AUDIT_ACTIONS.SESSION_REVOKED_ALL)).toBe('accepted');
    });

    it('acc_auth may not write any other sensitive, lifecycle, role, key or administrative action — nor a session action at tenant scope', async () => {
      for (const action of [
        AUDIT_ACTIONS.AUTHORIZATION_DENIED,
        AUDIT_ACTIONS.ORGANIZATION_CREATED,
        AUDIT_ACTIONS.ORGANIZATION_SUSPENDED,
        AUDIT_ACTIONS.ORGANIZATION_CLOSED,
        AUDIT_ACTIONS.WORKSPACE_ARCHIVED,
        AUDIT_ACTIONS.TEAM_ARCHIVED,
        AUDIT_ACTIONS.ROLE_CREATED,
        AUDIT_ACTIONS.USER_ROLE_GRANTED,
        AUDIT_ACTIONS.API_KEY_CREATED,
        AUDIT_ACTIONS.API_KEY_REVOKED,
        AUDIT_ACTIONS.USER_DISABLED,
        'platform.anything',
        'session.revoked.forged',
      ]) {
        expect(await tryInsert(action)).toMatch(/row-level security/);
      }
      expect(await tryInsert(AUDIT_ACTIONS.SESSION_REVOKED, 'organization')).toMatch(
        /row-level security/,
      );
    });

    it('atomicity: a failed audit write leaves the session live and writes nothing', async () => {
      await resetSessions(p.own!.userId);
      const device = await login(p.own!);
      const other = await login(p.own!);
      jest.spyOn(AuditWriter.prototype, 'record').mockImplementation(async (input) => {
        if (input.action === AUDIT_ACTIONS.SESSION_REVOKED)
          throw new Error('injected audit failure');
      });
      const res = await call('delete', other.token, `/auth/sessions/${device.sessionId}`);
      expect(res.status).toBe(500);
      expect((await sessionRow(device.sessionId))!.revoked_at).toBeNull();
      expect(
        await auditRows(
          sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED} AND resource_id = ${device.sessionId}`,
        ),
      ).toHaveLength(0);
    });

    it('atomicity: a failure after the audit write rolls back both the revocation and its record', async () => {
      await resetSessions(p.own!.userId);
      const device = await login(p.own!);
      const other = await login(p.own!);
      const original = AuditWriter.prototype.record;
      jest.spyOn(AuditWriter.prototype, 'record').mockImplementation(async function (
        this: AuditWriter,
        input,
        tx,
      ) {
        await original.call(this, input, tx);
        if (input.action === AUDIT_ACTIONS.SESSION_REVOKED)
          throw new Error('fails after the write');
      });
      const res = await call('delete', other.token, `/auth/sessions/${device.sessionId}`);
      expect(res.status).toBe(500);
      expect((await sessionRow(device.sessionId))!.revoked_at).toBeNull();
      expect(
        await auditRows(
          sql`action = ${AUDIT_ACTIONS.SESSION_REVOKED} AND resource_id = ${device.sessionId}`,
        ),
      ).toHaveLength(0);
    });

    it('atomicity: an eviction whose audit write fails aborts the login — nothing evicted, no session added', async () => {
      await resetSessions(p.cap!.userId);
      for (let i = 0; i < CAP; i++) await login(p.cap!);
      const before = (await liveSessions(p.cap!.userId)).map((r) => r.id);
      jest.spyOn(AuditWriter.prototype, 'record').mockImplementation(async (input) => {
        if (input.action === AUDIT_ACTIONS.SESSION_REVOKED)
          throw new Error('injected audit failure');
      });
      const res = await loginRaw(p.cap!.email);
      expect(res.status).toBe(500);
      jest.restoreAllMocks();
      expect((await liveSessions(p.cap!.userId)).map((r) => r.id)).toEqual(before);
    });

    it('no audit row written by this suite carries a credential', async () => {
      const rows = await auditRows(
        sql`actor_user_id IN (${sql.join(
          createdUsers.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
      expect(rows.length).toBeGreaterThan(20);
      const text = JSON.stringify(rows);
      for (const secret of secrets.filter((x) => x && x.length >= 16)) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/Bearer /);
    });
  });

  // ===========================================================================
  describe('L. organization lifecycle (documented behaviour for 1C.2, not new product policy)', () => {
    it('a member of a suspended organization keeps identity-level session control', async () => {
      await resetSessions(p.sMember!.userId);
      const a = await login(p.sMember!);
      const b = await login(p.sMember!);
      await call('get', b.token, '/auth/sessions').expect(200);
      const rotated = await refreshRaw(a.cookie);
      expect(rotated.status).toBe(200);
      secrets.push(rotated.body.data.accessToken, cookieFrom(rotated));
      await call('post', b.token, '/auth/sessions/revoke-all').expect(200);
      await request(server())
        .post(url('/auth/logout'))
        .set('authorization', `Bearer ${b.token}`)
        .set('X-Acc-Refresh', '1')
        .expect(204);
      expect(await liveSessions(p.sMember!.userId)).toHaveLength(0);
    });

    it('administrator routes follow the selected-organization rules: refused in a suspended organization', async () => {
      await resetSessions(p.sMember!.userId);
      await login(p.sMember!);
      const sAdmin = await login(p.sAdmin!);
      const member = await call(
        'post',
        sAdmin.token,
        `/users/${p.sMember!.userId}/sessions/revoke-all`,
        s.orgId,
      );
      expect(member.status).toBe(403);
      expect(member.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);

      const platform = await login(p.platform!);
      const mutation = await call(
        'post',
        platform.token,
        `/users/${p.sMember!.userId}/sessions/revoke-all`,
        s.orgId,
      );
      expect(mutation.status).toBe(409);
      expect(mutation.body.error.code).toBe(ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT);
      await call('get', platform.token, `/users/${p.sMember!.userId}/sessions`, s.orgId).expect(
        200,
      );
      expect(await liveSessions(p.sMember!.userId)).toHaveLength(1);
    });
  });
});
