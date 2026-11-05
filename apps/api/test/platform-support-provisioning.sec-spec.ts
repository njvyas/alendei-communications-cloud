import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUDIT_ACTIONS, ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { ownerAuditWriter, runBootstrap } from '../src/cli/bootstrap';
import {
  PLATFORM_SUPPORT_ACTOR_LABEL,
  PLATFORM_SUPPORT_SESSION_REVOCATION_REASON,
  PlatformSupportRefusal,
  createPlatformSupportUser,
  platformSupportStatus,
  revokePlatformSupportUser,
  type PlatformSupportCheckpoint,
  type PlatformSupportDeps,
} from '../src/cli/platform-support-provisioning';
import { ActivationRefusal, activateInvitedUser } from '../src/cli/user-activation';
import { CredentialService } from '../src/iam/credential.service';
import { SessionService } from '../src/iam/session.service';
import { UserLifecycleService } from '../src/iam/user-lifecycle.service';
import { PASSWORD, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, suffix, url, type Org } from './revocation-fixtures';

jest.setTimeout(120_000);

/** The new support identity's password. The operators' password is the harness `PASSWORD`. */
const SUPPORT_PASSWORD = 'the-platform-support-passphrase-01';
const MFA_REF = `ref://psp-mfa-${randomBytes(6).toString('hex')}`;
const API_DIR = resolve(__dirname, '..');
const APP_ENV = 'test';

/**
 * ADR-015 Item 5 Amendment A-1 — owner-run Platform Support provisioning.
 * Runs as the schema owner against a disposable clone, like the activation spec.
 * Matrix IDs (P-, N-, C-, R-) follow the approved design (05-Nov-2026).
 */
describe('platform:support provisioning (ADR-015 A-1)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let users: UserLifecycleService;
  let credentials: CredentialService;
  let sessions: SessionService;
  let a: Org;
  let operator: { userId: string; email: string };

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('psp');
    users = h.app.get(UserLifecycleService);
    credentials = h.app.get(CredentialService);
    sessions = h.app.get(SessionService);
    a = await w.org('psp-a');
    // A second organization, as on QA (10): with exactly one organization in the
    // database a support caller's optional tenant context auto-selects it and a
    // refusal is filed at that organization instead of at platform scope.
    await w.org('psp-b');
    operator = await w.superAdmin('psp-operator');
  });

  afterAll(async () => {
    try {
      // Identities the CLI created are not in the world's list; add them so its
      // teardown removes them, their sessions and the audit rows they acted in.
      const made = await h.admin.execute<{ id: string }>(
        sql`SELECT id FROM users WHERE email ILIKE 'psp-%@example.test'`,
      );
      for (const { id } of made.rows) if (!w.createdUsers.includes(id)) w.createdUsers.push(id);
      await purgeByResource(made.rows.map((r) => r.id));
      await w.teardown();
    } finally {
      await h.close();
    }
  });

  // --- helpers ---------------------------------------------------------------------------

  const api = () => request(h.app.getHttpServer());
  const address = (label: string) => `psp-${label}-${suffix()}@example.test`;

  function deps(checkpoint?: (p: PlatformSupportCheckpoint) => Promise<void>): PlatformSupportDeps {
    return { users, credentials, sessions, audit: ownerAuditWriter(), checkpoint };
  }

  const create = (
    userEmail: string,
    over: Partial<Parameters<typeof createPlatformSupportUser>[2]> = {},
    checkpoint?: (p: PlatformSupportCheckpoint) => Promise<void>,
  ) =>
    createPlatformSupportUser(h.admin, deps(checkpoint), {
      appEnv: APP_ENV,
      operatorEmail: operator.email,
      operatorPassword: PASSWORD,
      userEmail,
      password: SUPPORT_PASSWORD,
      ...over,
    });

  const revoke = (
    userEmail: string,
    over: Partial<Parameters<typeof revokePlatformSupportUser>[2]> = {},
    checkpoint?: (p: PlatformSupportCheckpoint) => Promise<void>,
  ) =>
    revokePlatformSupportUser(h.admin, deps(checkpoint), {
      appEnv: APP_ENV,
      operatorEmail: operator.email,
      operatorPassword: PASSWORD,
      userEmail,
      ...over,
    });

  async function purgeByResource(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await h.admin.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`);
    try {
      await h.admin.execute(sql`DELETE FROM audit_logs WHERE resource_id IN (${list})
        OR (after->>'userId') IN (SELECT id::text FROM users WHERE id IN (${list}))
        OR (before->>'userId') IN (SELECT id::text FROM users WHERE id IN (${list}))`);
    } finally {
      await h.admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
    }
  }

  const userByEmail = async (email: string) =>
    (
      await h.admin.execute<{
        id: string;
        status: string;
        passwordHash: string | null;
        mfaEnabled: boolean;
        mfaSecretRef: string | null;
      }>(sql`SELECT id, status::text AS status, password_hash AS "passwordHash",
                    mfa_enabled AS "mfaEnabled", mfa_secret_ref AS "mfaSecretRef"
               FROM users WHERE lower(email) = lower(${email})`)
    ).rows[0] ?? null;

  const grantsOf = async (userId: string) =>
    (
      await h.admin.execute<{
        id: string;
        roleKey: string;
        scopeType: string;
        scopeId: string | null;
        orgId: string | null;
      }>(sql`SELECT ur.id, r.key AS "roleKey", ur.scope_type::text AS "scopeType",
                    ur.scope_id AS "scopeId", ur.org_id AS "orgId"
               FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${userId}`)
    ).rows;

  /** Every audit row about an identity (as resource, or named in a grant image). */
  const auditAbout = async (userId: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(sql`
        SELECT * FROM audit_logs
         WHERE resource_id = ${userId} OR (after->>'userId') = ${userId} OR (before->>'userId') = ${userId}
         ORDER BY created_at, id`)
    ).rows;

  const auditByEmail = async (email: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(sql`
        SELECT * FROM audit_logs WHERE metadata->>'email' = ${email} ORDER BY created_at, id`)
    ).rows;

  const liveSessions = async (userId: string) =>
    Number(
      (
        await h.admin.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM sessions
           WHERE user_id = ${userId} AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now()`)
      ).rows[0]!.n,
    );

  async function login(email: string, password: string) {
    await h.clearRateLimits();
    const res = await api().post(url('/auth/login')).send({ email, password });
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('acc_refresh='));
    return {
      status: res.status,
      code: res.body?.error?.code as string | undefined,
      token: res.body?.data?.accessToken as string | undefined,
      refreshCookie: cookie?.split(';')[0],
    };
  }

  async function refused(attempt: Promise<unknown>, code: string): Promise<PlatformSupportRefusal> {
    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformSupportRefusal);
    expect((error as PlatformSupportRefusal).code).toBe(code);
    for (const secret of [PASSWORD, SUPPORT_PASSWORD]) {
      expect((error as Error).message).not.toContain(secret);
    }
    return error as PlatformSupportRefusal;
  }

  /** No plaintext password, digest, MFA reference or session/token material in any column. */
  function expectNoCredentialMaterial(rows: readonly unknown[], extra: readonly string[] = []) {
    const text = JSON.stringify(rows);
    for (const needle of [PASSWORD, SUPPORT_PASSWORD, '$argon2', MFA_REF, ...extra]) {
      expect([needle.slice(0, 12), text.includes(needle)]).toEqual([needle.slice(0, 12), false]);
    }
  }

  async function newSupport(label: string) {
    const email = address(label);
    const result = await create(email);
    w.createdUsers.push(result.userId);
    return { ...result, email };
  }

  // --- P: create, then use the identity --------------------------------------------------------

  describe('P — create and the support persona it yields', () => {
    let s: Awaited<ReturnType<typeof newSupport>>;
    let token: string;

    beforeAll(async () => {
      s = await newSupport('main');
      const signedIn = await login(s.email, SUPPORT_PASSWORD);
      expect(signedIn.status).toBe(200);
      token = signedIn.token!;
    });

    it('P-01 creates an active identity with exactly one alendei_support@platform grant, audited with the email', async () => {
      const row = (await userByEmail(s.email))!;
      expect(row).toMatchObject({
        id: s.userId,
        status: 'active',
        mfaEnabled: false,
        mfaSecretRef: null,
      });
      expect(row.passwordHash).not.toContain(SUPPORT_PASSWORD);
      expect(await credentials.verify(row.passwordHash!, SUPPORT_PASSWORD)).toBe(true);

      const grants = await grantsOf(s.userId);
      expect(grants).toEqual([
        {
          id: s.grantId,
          roleKey: PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT,
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
        },
      ]);
      const [granted] = await h.admin
        .select({ grantedBy: schema.userRoles.grantedBy })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.id, s.grantId));
      expect(granted!.grantedBy).toBe(operator.userId);

      const rows = (await auditAbout(s.userId)).filter((r) => r.correlation_id === s.correlationId);
      expect(rows.map((r) => r.action)).toEqual([
        AUDIT_ACTIONS.USER_INVITED,
        AUDIT_ACTIONS.USER_ROLE_GRANTED,
        AUDIT_ACTIONS.USER_ACTIVATED,
      ]);
      for (const r of rows) {
        expect(r).toMatchObject({
          outcome: 'success',
          scope_type: 'platform',
          actor_type: 'user',
          actor_user_id: operator.userId,
          actor_label: PLATFORM_SUPPORT_ACTOR_LABEL,
        });
        expect((r.metadata as Record<string, unknown>).email).toBe(s.email);
      }
      expect((rows[1]!.after as Record<string, unknown>).roleKey).toBe(
        PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT,
      );
      expectNoCredentialMaterial(rows);
    });

    it('P-02 the identity signs in; /auth/me shows alendei_support only and not a platform administrator', async () => {
      const me = await api()
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.data.roles).toEqual([
        expect.objectContaining({
          roleKey: PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT,
          scopeType: 'platform',
          scopeId: null,
        }),
      ]);
      expect(me.body.data.tenant.isPlatformAdmin).toBe(false);
    });

    it('P-03 (QA D-2/D2-3) a branding update is refused 403 AUTHZ_SCOPE_DENIED and nothing changes', async () => {
      const before = await api()
        .get(url(`/organizations/${a.orgId}/branding`))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      const res = await api()
        .patch(url(`/organizations/${a.orgId}/branding`))
        .set('authorization', `Bearer ${token}`)
        .send({ brandName: 'support must not change this' });
      expect([res.status, res.body.error?.code]).toEqual([403, ERROR_CODES.AUTHZ_SCOPE_DENIED]);
      const after = await api()
        .get(url(`/organizations/${a.orgId}/branding`))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.data).toEqual(before.body.data);
    });

    it('P-04 (QA D-3/D3-5) four control-plane routes are refused and audited at platform scope', async () => {
      const calls = [
        { path: '/resellers', body: { name: 'PSP Denied', slug: `psp-denied-${suffix()}` } },
        { path: `/resellers/${w.resellerId}/suspend`, body: { reason: 'psp support attempt' } },
        { path: `/resellers/${w.resellerId}/reactivate`, body: { reason: 'psp support attempt' } },
        {
          path: '/onboarding/direct',
          body: {
            name: 'PSP Denied Direct',
            slug: `psp-denied-d-${suffix()}`,
            adminUser: { email: address('denied-admin'), firstName: 'PSP', lastName: 'Denied' },
          },
        },
      ];
      for (const c of calls) {
        const res = await api()
          .post(url(c.path))
          .set('authorization', `Bearer ${token}`)
          .set('idempotency-key', uuidv7())
          .send(c.body);
        expect([c.path, res.status, res.body.error?.code]).toEqual([
          c.path,
          403,
          ERROR_CODES.AUTHZ_SCOPE_DENIED,
        ]);
        const denied = await h.admin
          .select()
          .from(schema.auditLogs)
          .where(eq(schema.auditLogs.correlationId, res.headers['x-correlation-id'] as string));
        expect(denied.map((d) => [d.action, d.scopeType, d.actorUserId])).toEqual([
          [AUDIT_ACTIONS.AUTHORIZATION_DENIED, 'platform', s.userId],
        ]);
      }
      const [reseller] = await h.admin
        .select({ status: schema.resellers.status })
        .from(schema.resellers)
        .where(eq(schema.resellers.id, w.resellerId));
      expect(reseller!.status).toBe('active');
    });

    it('P-05 (QA U13.4/C2) the support cockpit answers 200 with no sensitive data', async () => {
      const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
      const PROHIBITED =
        /^(email|ip|ipaddress|useragent|recipient|recipients|payload|body|content|text|password|token|phone)$/;
      const keys = (v: unknown, out: string[] = []): string[] => {
        if (Array.isArray(v)) v.forEach((x) => keys(x, out));
        else if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) {
            out.push(k.toLowerCase().replace(/[^a-z]/g, ''));
            keys(x, out);
          }
        return out;
      };
      for (const path of [
        `/platform/support/organizations/${a.orgId}/overview`,
        `/platform/support/organizations/${a.orgId}/routing`,
        `/platform/support/organizations/${a.orgId}/dispatch`,
      ]) {
        const res = await api().get(url(path)).set('authorization', `Bearer ${token}`);
        expect([path, res.status]).toEqual([path, 200]);
        expect([path, keys(res.body).filter((k) => PROHIBITED.test(k))]).toEqual([path, []]);
        expect([path, EMAIL.test(JSON.stringify(res.body))]).toEqual([path, false]);
      }
    });

    it('P-06 the identity is refused provider administration and any platform-role grant', async () => {
      const providers = await api().get(url('/providers')).set('authorization', `Bearer ${token}`);
      expect([providers.status, providers.body.error?.code]).toEqual([
        403,
        ERROR_CODES.AUTHZ_SCOPE_DENIED,
      ]);
      const grant = await api()
        .post(url('/role-assignments'))
        .set('authorization', `Bearer ${token}`)
        .set('x-acc-organization', a.orgId)
        .send({
          userId: s.userId,
          roleId: await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
          scopeType: 'organization',
          scopeId: a.orgId,
        });
      expect([400, 403]).toContain(grant.status);
      expect(await grantsOf(s.userId)).toHaveLength(1);
    });

    it('P-07 status reports the identity from a READ ONLY transaction', async () => {
      const spy = jest.spyOn(h.admin, 'transaction');
      try {
        const report = await platformSupportStatus(h.admin, APP_ENV, s.email.toUpperCase());
        expect(report).toMatchObject({
          classification: 'platform_support_active',
          userId: s.userId,
          status: 'active',
          hasPassword: true,
          mfaEnabled: false,
          hasMfaSecretRef: false,
          grants: [
            { roleKey: PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT, scopeType: 'platform', scopeId: null },
          ],
          usableApiKeys: 0,
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]![1]).toEqual({ accessMode: 'read only' });
      } finally {
        spy.mockRestore();
      }
      // The access mode really is enforced by PostgreSQL.
      const write = await h.admin
        .transaction(
          async (tx) => tx.execute(sql`UPDATE users SET updated_at = now() WHERE id = ${s.userId}`),
          {
            accessMode: 'read only',
          },
        )
        .catch((e: unknown) => e);
      expect(String((write as { cause?: { code?: string } }).cause?.code ?? write)).toMatch(
        /25006/,
      );
      expect(
        (await platformSupportStatus(h.admin, APP_ENV, address('absent'))).classification,
      ).toBe('not_found');
      await expect(platformSupportStatus(h.admin, 'production', s.email)).rejects.toBeInstanceOf(
        PlatformSupportRefusal,
      );
    });
  });

  // --- revoke and the five credential-clearing proofs ---------------------------------------------

  describe('P-08 … C-05 — revoke removes access and every credential, atomically', () => {
    let s: Awaited<ReturnType<typeof newSupport>>;
    let accessToken: string;
    let refreshCookie: string;
    let sessionIds: string[];
    let auditBefore: Record<string, unknown>[];
    let revoked: Awaited<ReturnType<typeof revoke>>;

    beforeAll(async () => {
      s = await newSupport('revoke');
      // C-02 fixture: a stored MFA configuration, planted by the owner.
      await h.admin
        .update(schema.users)
        .set({ mfaEnabled: true, mfaSecretRef: MFA_REF })
        .where(eq(schema.users.id, s.userId));
      const first = await login(s.email, SUPPORT_PASSWORD);
      const second = await login(s.email, SUPPORT_PASSWORD);
      expect([first.status, second.status]).toEqual([200, 200]);
      accessToken = first.token!;
      refreshCookie = second.refreshCookie!;
      expect(refreshCookie).toMatch(/^acc_refresh=/);
      await api().get(url('/auth/me')).set('authorization', `Bearer ${accessToken}`).expect(200);
      sessionIds = (
        await h.admin
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.userId, s.userId))
      ).map((r) => r.id);
      expect(await liveSessions(s.userId)).toBe(2);
      auditBefore = await auditAbout(s.userId);
      revoked = await revoke(s.email);
    });

    it('P-08 grant removed, identity disabled, password digest and MFA reference cleared, sessions revoked, audited with the email', async () => {
      expect(revoked).toMatchObject({
        userId: s.userId,
        revokedGrantId: s.grantId,
        sessionsRevoked: 2,
      });
      expect(await grantsOf(s.userId)).toEqual([]);
      expect(await userByEmail(s.email)).toMatchObject({
        status: 'disabled',
        passwordHash: null,
        mfaEnabled: false,
        mfaSecretRef: null,
      });
      const rows = await h.admin
        .select({ revokedAt: schema.sessions.revokedAt, reason: schema.sessions.revokedReason })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, s.userId));
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) expect(r.revokedAt).not.toBeNull();
      expect(
        rows.filter((r) => r.reason === PLATFORM_SUPPORT_SESSION_REVOCATION_REASON),
      ).toHaveLength(2);

      const audit = (await auditAbout(s.userId)).filter(
        (r) => r.correlation_id === revoked.correlationId,
      );
      expect(audit.map((r) => r.action)).toEqual([
        AUDIT_ACTIONS.USER_ROLE_REVOKED,
        AUDIT_ACTIONS.USER_DISABLED,
      ]);
      for (const r of audit) {
        expect(r).toMatchObject({
          outcome: 'success',
          scope_type: 'platform',
          actor_user_id: operator.userId,
        });
        expect((r.metadata as Record<string, unknown>).email).toBe(s.email);
      }
      expect(audit[1]!.metadata).toMatchObject({ sessionsRevoked: 2 });
      expect(audit[1]!.after).toMatchObject({ status: 'disabled', credentialCleared: true });
      expect((await platformSupportStatus(h.admin, APP_ENV, s.email)).classification).toBe(
        'revoked',
      );
    });

    it('C-01 the previous password cannot authenticate', async () => {
      const attempt = await login(s.email, SUPPORT_PASSWORD);
      expect([attempt.status, attempt.code]).toEqual([401, ERROR_CODES.AUTH_INVALID_CREDENTIALS]);
      expect(attempt.token).toBeUndefined();
      const after = await h.admin
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, s.userId));
      expect(after.map((r) => r.id).sort()).toEqual([...sessionIds].sort());
      expect((await userByEmail(s.email))!.passwordHash).toBeNull();
    });

    it('C-02 the previous MFA configuration cannot authenticate: cleared, and no MFA sign-in route exists', async () => {
      const row = (await userByEmail(s.email))!;
      expect([row.mfaEnabled, row.mfaSecretRef]).toEqual([false, null]);
      expect((await login(s.email, SUPPORT_PASSWORD)).status).toBe(401);
      const spec = JSON.parse(
        readFileSync(resolve(API_DIR, 'openapi/openapi.v1.json'), 'utf8'),
      ) as {
        paths: Record<string, unknown>;
      };
      expect(
        Object.keys(spec.paths).filter((p) => /mfa|otp|totp|second-factor|2fa/i.test(p)),
      ).toEqual([]);
    });

    it('C-03 access and refresh tokens issued before revocation are rejected on first use', async () => {
      const me = await api().get(url('/auth/me')).set('authorization', `Bearer ${accessToken}`);
      expect([me.status, me.body.error?.code]).toEqual([401, ERROR_CODES.AUTH_SESSION_REVOKED]);
      const cockpit = await api()
        .get(url(`/platform/support/organizations/${a.orgId}/overview`))
        .set('authorization', `Bearer ${accessToken}`);
      expect(cockpit.status).toBe(401);
      await h.clearRateLimits();
      const refreshed = await api()
        .post(url('/auth/refresh'))
        .set('x-acc-refresh', '1')
        .set('cookie', refreshCookie);
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.data?.accessToken).toBeUndefined();
      expect(await liveSessions(s.userId)).toBe(0);
    });

    it('C-04 no supported reactivation or identity-reuse path restores access', async () => {
      const opToken = await w.login(operator.email);
      const orgAdmin = await w.admin(a, 'psp-orgadmin');
      const adminToken = await w.login(orgAdmin.email);

      // C-04a reactivation through the API: the identity is in no organization.
      for (const t of [opToken, adminToken]) {
        const res = await api()
          .post(url(`/users/${s.userId}/reactivate`))
          .set('authorization', `Bearer ${t}`)
          .set('x-acc-organization', a.orgId);
        expect(res.status).toBe(404);
      }
      // C-04b the activation CLI.
      const activation = await activateInvitedUser(
        h.admin,
        { users, audit: ownerAuditWriter() },
        {
          operatorEmail: operator.email,
          organization: a.orgId,
          userEmail: s.email,
          password: SUPPORT_PASSWORD,
        },
      ).catch((e: unknown) => e);
      expect(activation).toBeInstanceOf(ActivationRefusal);
      expect((activation as ActivationRefusal).reason).toMatch(/is disabled, not invited/);

      // C-04c identity reuse: the CLI (exact and other case) and POST /users.
      await refused(create(s.email), 'duplicate_identity');
      await refused(create(s.email.toUpperCase()), 'duplicate_identity');
      const viaApi = await api()
        .post(url('/users'))
        .set('authorization', `Bearer ${adminToken}`)
        .set('x-acc-organization', a.orgId)
        .send({
          email: s.email,
          initialRole: {
            roleId: a.roles[TENANT_ROLE_KEYS.READ_ONLY],
            scopeType: 'organization',
            scopeId: a.orgId,
          },
        });
      expect(viaApi.status).toBe(409);

      // C-04d a grant to the disabled identity: tenant role refused; platform role refused.
      const tenantGrant = await api()
        .post(url('/role-assignments'))
        .set('authorization', `Bearer ${adminToken}`)
        .set('x-acc-organization', a.orgId)
        .send({
          userId: s.userId,
          roleId: a.roles[TENANT_ROLE_KEYS.READ_ONLY],
          scopeType: 'organization',
          scopeId: a.orgId,
        });
      expect([403, 404, 409, 422]).toContain(tenantGrant.status);
      const platformGrant = await api()
        .post(url('/role-assignments'))
        .set('authorization', `Bearer ${opToken}`)
        .set('x-acc-organization', a.orgId)
        .send({
          userId: s.userId,
          roleId: await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
          scopeType: 'organization',
          scopeId: a.orgId,
        });
      expect([400, 403, 422]).toContain(platformGrant.status);

      // C-04e bootstrap is a no-op on an already-bootstrapped database.
      const outcome = await h.admin.transaction((tx) =>
        runBootstrap(tx, {
          email: s.email,
          password: SUPPORT_PASSWORD,
          credentials,
          users,
          audit: ownerAuditWriter(),
        }),
      );
      expect(outcome.created).toBe(false);

      // C-04f defence in depth (owner harness, not a supported path): the database
      // refuses `active` without a credential; `invited` still cannot sign in.
      const forced = await h.admin
        .update(schema.users)
        .set({ status: 'active' })
        .where(eq(schema.users.id, s.userId))
        .catch((e: unknown) => e);
      expect(String((forced as { cause?: { code?: string } }).cause?.code ?? forced)).toMatch(
        /23514/,
      );
      await h.admin
        .update(schema.users)
        .set({ status: 'invited' })
        .where(eq(schema.users.id, s.userId));
      expect((await login(s.email, SUPPORT_PASSWORD)).status).toBe(401);
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, s.userId));

      expect(await grantsOf(s.userId)).toEqual([]);
      expect(await userByEmail(s.email)).toMatchObject({
        status: 'disabled',
        passwordHash: null,
        mfaSecretRef: null,
      });
    });

    it('C-05 audit history is intact (append-only) and carries no credential material', async () => {
      const after = await auditAbout(s.userId);
      // C-05a every earlier row is unchanged; revoke only appended rows.
      expect(after.slice(0, auditBefore.length)).toEqual(auditBefore);
      expect(
        after.filter((r) => r.correlation_id === revoked.correlationId).map((r) => r.action),
      ).toEqual([AUDIT_ACTIONS.USER_ROLE_REVOKED, AUDIT_ACTIONS.USER_DISABLED]);
      const tampered = await h.admin
        .execute(
          sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${after[0]!.id as string}`,
        )
        .catch((e: unknown) => e);
      expect(
        String((tampered as { cause?: { message?: string } }).cause?.message ?? tampered),
      ).toMatch(/append-only/);
      const deleted = await h.admin
        .execute(sql`DELETE FROM audit_logs WHERE id = ${after[0]!.id as string}`)
        .catch((e: unknown) => e);
      expect(
        String((deleted as { cause?: { message?: string } }).cause?.message ?? deleted),
      ).toMatch(/append-only/);
      // C-05b no password, digest, MFA reference, session id or token in any audit column.
      expectNoCredentialMaterial(
        [...after, ...(await auditByEmail(s.email))],
        [accessToken, ...sessionIds],
      );
      expect(
        after.filter((r) => (r.metadata as Record<string, unknown> | null)?.email === s.email)
          .length,
      ).toBeGreaterThanOrEqual(5);
    });
  });

  // --- C-06 / N-19 rollback ----------------------------------------------------------------------

  describe('C-06 / N-19 — a failure at any step rolls back everything', () => {
    const boom = (at: PlatformSupportCheckpoint) => async (p: PlatformSupportCheckpoint) => {
      if (p === at) throw new Error(`injected failure at ${p}`);
    };

    it.each([
      'create:after-invite',
      'create:after-grant',
      'create:after-activate',
      'create:after-audit',
    ] as const)('create rolls back completely when %s fails', async (point) => {
      const email = address('rb-create');
      await expect(create(email, {}, boom(point))).rejects.toThrow(/injected failure/);
      expect(await userByEmail(email)).toBeNull();
      expect(await auditByEmail(email)).toEqual([]);
    });

    it.each([
      'revoke:after-grant-delete',
      'revoke:after-sessions',
      'revoke:after-credentials',
      'revoke:after-audit',
    ] as const)('revoke rolls back completely when %s fails', async (point) => {
      const s = await newSupport('rb-revoke');
      const signedIn = await login(s.email, SUPPORT_PASSWORD);
      const before = await userByEmail(s.email);
      const auditCount = (await auditAbout(s.userId)).length;
      await expect(revoke(s.email, {}, boom(point))).rejects.toThrow(/injected failure/);
      expect(await userByEmail(s.email)).toEqual(before);
      expect((await grantsOf(s.userId)).map((g) => g.roleKey)).toEqual([
        PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT,
      ]);
      expect(await liveSessions(s.userId)).toBe(1);
      expect((await auditAbout(s.userId)).length).toBe(auditCount);
      await api().get(url('/auth/me')).set('authorization', `Bearer ${signedIn.token}`).expect(200);
    });
  });

  // --- N: refusals --------------------------------------------------------------------------------

  describe('N — refusals change nothing', () => {
    it('N-01…N-06 operator: unknown, support, org admin, reseller admin, disabled super admin, wrong password', async () => {
      const supportOp = await newSupport('as-operator');
      const orgAdmin = await w.admin(a, 'psp-n-orgadmin');
      const resellerAdmin = await w.resellerAdmin(w.resellerId, 'psp-n-reselleradmin');
      const disabledOp = await w.superAdmin('psp-n-disabled');
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, disabledOp.userId));

      const cases: { op: string; password: string; code: string; actor: string | null }[] = [
        { op: address('nobody'), password: PASSWORD, code: 'operator_unknown', actor: null },
        {
          op: supportOp.email,
          password: SUPPORT_PASSWORD,
          code: 'operator_not_eligible',
          actor: supportOp.userId,
        },
        {
          op: orgAdmin.email,
          password: PASSWORD,
          code: 'operator_not_eligible',
          actor: orgAdmin.userId,
        },
        {
          op: resellerAdmin.email,
          password: PASSWORD,
          code: 'operator_not_eligible',
          actor: resellerAdmin.userId,
        },
        {
          op: disabledOp.email,
          password: PASSWORD,
          code: 'operator_not_eligible',
          actor: disabledOp.userId,
        },
        {
          op: operator.email,
          password: 'not-the-operator-password-1',
          code: 'operator_authentication_failed',
          actor: operator.userId,
        },
      ];
      for (const c of cases) {
        const target = address('n-op-target');
        await refused(
          create(target, { operatorEmail: c.op, operatorPassword: c.password }),
          c.code,
        );
        expect(await userByEmail(target)).toBeNull();
        const rows = await auditByEmail(target);
        if (c.actor === null) {
          expect(rows).toEqual([]);
        } else {
          expect(
            rows.map((r) => [
              r.outcome,
              r.actor_user_id,
              (r.metadata as Record<string, unknown>).reason,
            ]),
          ).toEqual([['denied', c.actor, c.code]]);
          expect((rows[0]!.metadata as Record<string, unknown>).operatorAuthenticated).toBe(false);
          expectNoCredentialMaterial(rows, ['not-the-operator-password-1']);
        }
      }
      // The same refusals apply to revoke.
      const victim = await newSupport('n-op-victim');
      await refused(
        revoke(victim.email, { operatorEmail: orgAdmin.email }),
        'operator_not_eligible',
      );
      await refused(
        revoke(victim.email, { operatorPassword: 'not-the-operator-password-1' }),
        'operator_authentication_failed',
      );
      expect(await grantsOf(victim.userId)).toHaveLength(1);
    });

    it('N-07 the operator is re-validated inside the transaction (disabled, demoted or password changed meanwhile)', async () => {
      const mutations: Record<string, (id: string) => Promise<unknown>> = {
        disabled: (id) =>
          h.admin.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, id)),
        demoted: async (id) => {
          await h.admin.transaction(async (tx) => {
            await tx.execute(
              sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
            );
            await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
            await tx.execute(
              sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
            );
          });
        },
        'password changed': async (id) =>
          h.admin
            .update(schema.users)
            .set({ passwordHash: await credentials.hash('a-different-operator-passphrase') })
            .where(eq(schema.users.id, id)),
      };
      for (const [label, mutate] of Object.entries(mutations)) {
        const op = await w.superAdmin(`psp-n7-${label.replace(/ /g, '-')}`);
        const target = address('n7');
        await refused(
          create(target, { operatorEmail: op.email }, async (p) => {
            if (p === 'before-transaction') await mutate(op.userId);
          }),
          'operator_changed',
        );
        expect([label, await userByEmail(target)]).toEqual([label, null]);
      }
    });

    it('N-08 an existing address in any status or letter case is never reused', async () => {
      const invited = await w.person('psp-n8-invited', 'invited');
      const active = await w.person('psp-n8-active');
      const disabled = await w.person('psp-n8-disabled');
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, disabled.userId));
      for (const email of [
        invited.email,
        active.email,
        disabled.email,
        active.email.toUpperCase(),
      ]) {
        const before = await userByEmail(email);
        await refused(create(email), 'duplicate_identity');
        expect(await userByEmail(email)).toEqual(before);
        expect(await grantsOf(before!.id)).toEqual([]);
      }
    });

    it('N-09 two concurrent creates of one address: exactly one succeeds', async () => {
      const email = address('n9');
      const results = await Promise.allSettled([create(email), create(email)]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const no = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(no).toHaveLength(1);
      expect((no[0]!.reason as PlatformSupportRefusal).code).toBe('duplicate_identity');
      const row = (await userByEmail(email))!;
      w.createdUsers.push(row.id);
      expect(await grantsOf(row.id)).toHaveLength(1);
    });

    it('N-10 self-revocation is refused', async () => {
      await refused(revoke(operator.email), 'self_revocation');
      expect((await grantsOf(operator.userId)).map((g) => g.roleKey)).toEqual([
        PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN,
      ]);
      const [denied] = (await auditByEmail(operator.email)).filter(
        (r) => (r.metadata as Record<string, unknown>).reason === 'self_revocation',
      );
      expect(denied).toMatchObject({ outcome: 'denied', actor_user_id: operator.userId });
      expect((denied!.metadata as Record<string, unknown>).operatorAuthenticated).toBe(true);
    });

    it('N-11 revoke touches nothing but a platform-support identity', async () => {
      const otherAdmin = await w.superAdmin('psp-n11-sa');
      const tenantUser = await w.admin(a, 'psp-n11-tenant');
      const extra = await newSupport('n11-extra');
      await w.grant(extra.userId, a.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', a.orgId);
      const bare = await w.person('psp-n11-bare');
      const twice = await newSupport('n11-twice');
      await revoke(twice.email);

      for (const [label, email, code] of [
        ['super admin', otherAdmin.email, 'target_not_platform_support'],
        ['tenant user', tenantUser.email, 'target_not_platform_support'],
        ['support plus tenant grant', extra.email, 'target_not_platform_support'],
        ['no grant', bare.email, 'target_not_platform_support'],
        ['already revoked', twice.email, 'target_not_platform_support'],
        ['unknown', address('n11-unknown'), 'target_not_found'],
      ] as const) {
        const before = await userByEmail(email);
        const grantsBefore = before ? await grantsOf(before.id) : [];
        const liveBefore = before ? await liveSessions(before.id) : 0;
        await refused(revoke(email), code);
        expect([label, await userByEmail(email)]).toEqual([label, before]);
        if (before) {
          expect([label, await grantsOf(before.id)]).toEqual([label, grantsBefore]);
          expect([label, await liveSessions(before.id)]).toEqual([label, liveBefore]);
        }
      }
    });

    it('N-12 an identity with a usable API key is refused, unchanged', async () => {
      const s = await newSupport('n12');
      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      await h.admin.insert(schema.apiKeys).values({
        orgId: a.orgId,
        name: `psp-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(`s${uuidv7()}`),
        scopes: ['workspaces.read'],
        createdBy: s.userId,
      });
      const before = await userByEmail(s.email);
      await refused(revoke(s.email), 'usable_api_key');
      expect(await userByEmail(s.email)).toEqual(before);
      expect(await grantsOf(s.userId)).toHaveLength(1);
      // A revoked key does not block revocation.
      await h.admin
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(schema.apiKeys.keyPrefix, prefix));
      await revoke(s.email);
      expect((await userByEmail(s.email))!.status).toBe('disabled');
    });

    it('N-13 the logic itself refuses production and an unknown or missing APP_ENV', async () => {
      for (const appEnv of ['production', 'prod', '', undefined]) {
        const email = address('n13');
        await refused(create(email, { appEnv }), 'environment');
        expect(await userByEmail(email)).toBeNull();
      }
    });

    it('N-17 a password outside the rule, or equal to the operator password, is refused and audited without the secret', async () => {
      const short = address('n17-short');
      await refused(create(short, { password: 'too-short' }), 'password_rule');
      const same = address('n17-same');
      await refused(create(same, { password: PASSWORD }), 'password_reuse');
      for (const email of [short, same]) {
        expect(await userByEmail(email)).toBeNull();
        const rows = await auditByEmail(email);
        expect(rows.map((r) => r.outcome)).toEqual(['denied']);
        expect((rows[0]!.metadata as Record<string, unknown>).operatorAuthenticated).toBe(true);
        expectNoCredentialMaterial(rows, ['too-short']);
      }
    });
  });

  // --- the command itself (stdin only; output never carries a secret) --------------------------------

  describe('N-14 … N-18 — the command: environment gate, stdin only, nothing secret in output', () => {
    const run = (args: string[], input: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync(
        process.execPath,
        [
          resolve(API_DIR, '../../node_modules/tsx/dist/cli.mjs'),
          'src/cli/platform-support.ts',
          ...args,
        ],
        { cwd: API_DIR, input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 90_000 },
      );
    const createArgs = (email: string, confirm = APP_ENV) => [
      'create',
      '--operator',
      operator.email,
      '--email',
      email,
      '--password-stdin',
      '--confirm-environment',
      confirm,
    ];
    const noSecrets = (r: { stdout: string; stderr: string }) => {
      for (const s of [PASSWORD, SUPPORT_PASSWORD, '$argon2'])
        expect(`${r.stdout}${r.stderr}`).not.toContain(s);
    };

    it('creates, reports and revokes end to end with NODE_ENV=production and APP_ENV=test', async () => {
      const email = address('cli');
      const env = { APP_ENV, NODE_ENV: 'production' };
      const made = run(createArgs(email), `${PASSWORD}\n${SUPPORT_PASSWORD}\n`, env);
      expect([made.status, made.stderr.trim()]).toEqual([0, '']);
      expect(made.stdout).toMatch(/Platform support user created: psp-cli-/);
      noSecrets(made);
      const row = (await userByEmail(email))!;
      w.createdUsers.push(row.id);

      const status = run(['status', '--email', email], '', env);
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(/classification: platform_support_active/);
      expect(status.stdout).toMatch(/grants: alendei_support@platform/);
      noSecrets(status);

      const gone = run(
        [
          'revoke',
          '--operator',
          operator.email,
          '--email',
          email,
          '--password-stdin',
          '--confirm-environment',
          APP_ENV,
        ],
        `${PASSWORD}\n`,
        env,
      );
      expect([gone.status, gone.stderr.trim()]).toEqual([0, '']);
      expect(gone.stdout).toMatch(
        /Platform support access revoked: psp-cli-.*\n.*password and MFA reference cleared/,
      );
      noSecrets(gone);
      expect((await platformSupportStatus(h.admin, APP_ENV, email)).classification).toBe('revoked');
    });

    it('refuses production (even confirmed), an unknown APP_ENV and a confirmation mismatch before connecting', async () => {
      const unreachable = 'postgres://nobody@127.0.0.1:1/never';
      for (const [env, confirm, message] of [
        [
          { APP_ENV: 'production' },
          'production',
          /APP_ENV is production; platform support provisioning is prohibited/,
        ],
        [{ APP_ENV: 'production', NODE_ENV: 'development' }, 'production', /prohibited/],
        [{ APP_ENV: 'qa' }, 'qa', /APP_ENV must be one of staging, test, development/],
        [{ APP_ENV }, 'staging', /--confirm-environment must equal APP_ENV exactly/],
      ] as const) {
        const email = address('n14');
        const r = run(createArgs(email, confirm), `${PASSWORD}\n${SUPPORT_PASSWORD}\n`, {
          ...env,
          DATABASE_ADMIN_URL: unreachable,
        });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(message);
        expect(r.stderr).not.toMatch(/database error|ECONNREFUSED/);
        noSecrets(r);
        expect(await userByEmail(email)).toBeNull();
      }
    });

    it('refuses a password on the command line and a wrong stdin line count, echoing no secret', async () => {
      const email = address('n16');
      const asArg = run([...createArgs(email), '--password', SUPPORT_PASSWORD], '', { APP_ENV });
      expect(asArg.status).toBe(1);
      expect(asArg.stderr).toMatch(/unexpected argument --password/);
      noSecrets(asArg);
      const oneLine = run(createArgs(email), `${PASSWORD}\n`, { APP_ENV });
      expect(oneLine.status).toBe(1);
      expect(oneLine.stderr).toMatch(/exactly 2 line/);
      noSecrets(oneLine);
      const refusedRun = run(
        createArgs(email),
        `not-the-operator-password-1\n${SUPPORT_PASSWORD}\n`,
        { APP_ENV },
      );
      expect(refusedRun.status).toBe(1);
      expect(refusedRun.stderr).toMatch(
        /platform support refused: the operator password was not accepted/,
      );
      expect(`${refusedRun.stdout}${refusedRun.stderr}`).not.toContain(
        'not-the-operator-password-1',
      );
      noSecrets(refusedRun);
      expect(await userByEmail(email)).toBeNull();
    });
  });
});
