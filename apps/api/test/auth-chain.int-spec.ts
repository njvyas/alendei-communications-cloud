/**
 * Phase 1B.3 chain test — the exit criterion recorded in `ROADMAP.md` §4a.
 *
 * Asserts every link of the request-to-database path individually, so a failure
 * names the link that broke:
 *
 *   AuthGuard → RequestContext.setPrincipal() → ScopeResolver → TenantContext
 *   → X-Acc-Organization → withRequestTenant() → SET LOCAL → acc_app → RLS
 *   → scoped query → AuditWriter
 */
import { AUDIT_ACTIONS } from '@acc/contracts';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { CredentialService } from '../src/iam/credential.service';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { REFRESH_COOKIE } from '../src/auth/auth.controller';
import { SESSION_VARS } from '@acc/db';
import { TenantDatabase } from '../src/database/tenant-database.service';
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

const url = (path: string) => `/${PREFIX}${path}`;

describe('authenticated request chain', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let orgB: TenantFixture;

  const login = (email: string) =>
    request(h.app.getHttpServer()).post(url('/auth/login')).send({ email, password: PASSWORD });

  const tokenFor = async (email: string) => {
    await h.clearRateLimits();
    const res = await login(email).expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'chain-a', credentials);
    orgB = await createTenant(h.admin, 'chain-b', credentials);
  }, 60_000);

  afterAll(async () => {
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  afterEach(() => purgeAudit(h.admin, sql`true`));

  describe('each link', () => {
    it('1. AuthGuard turns a credential into a principal, and refuses without one', async () => {
      await request(h.app.getHttpServer()).get(url('/tenants/workspaces')).expect(401);
      const token = await tokenFor(orgA.email);
      await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('2. the principal reaches RequestContext with identity and method', async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.userId).toBe(orgA.userId);
      expect(res.body.authMethod).toBe('session');
      expect(res.body.sessionId).toBe((jwt.decode(token) as { sid: string }).sid);
    });

    it('3. ScopeResolver derives grants from the database, not the token', async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.roles).toHaveLength(1);
      expect(res.body.roles[0]).toMatchObject({ scopeType: 'organization', scopeId: orgA.orgId });
      expect(res.body.permissions).toContain('workspaces.read');

      // Revoking the grant takes effect on the next request, with the same token.
      await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${orgA.userId}`);
      try {
        const after = await request(h.app.getHttpServer())
          .get(url('/auth/me'))
          .set('authorization', `Bearer ${token}`)
          .expect(200);
        expect(after.body.roles).toHaveLength(0);
        expect(after.body.permissions).toHaveLength(0);
      } finally {
        await h.admin.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await h.admin.execute(
          sql`INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
              VALUES (${orgA.userId}, ${orgA.roleId}, 'organization', ${orgA.orgId})`,
        );
      }
    });

    it('4-5. TenantContext resolves the organization; the selector chooses it', async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .set('x-acc-organization', orgA.orgId)
        .expect(200);
      expect(res.body.workspaces[0].orgId).toBe(orgA.orgId);
    });

    it('6-7. withRequestTenant sets the context transaction-locally', async () => {
      const db = h.app.get(TenantDatabase);

      const inside = await db.withTenant({ orgId: orgA.orgId }, async (tx) => {
        const { rows } = await tx.execute<{ v: string }>(
          sql`SELECT current_setting(${SESSION_VARS.ORG_ID}, true) AS v`,
        );
        return rows[0]!.v;
      });
      expect(inside).toBe(orgA.orgId);

      // A later transaction on the same pool must not inherit it — this is what
      // SET LOCAL buys, and what a connection-level SET would break.
      const after = await db.withTenant({}, async (tx) => {
        const { rows } = await tx.execute<{ v: string | null }>(
          sql`SELECT nullif(current_setting(${SESSION_VARS.ORG_ID}, true), '') AS v`,
        );
        return rows[0]!.v;
      });
      expect(after).toBeNull();
    });

    it('8-9. acc_app + RLS scope the query with no application-side filter', async () => {
      // The handler issues `SELECT ... FROM workspaces` with no tenant predicate.
      // Everything that scopes the result is RLS.
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      const ids = res.body.workspaces.map((w: { id: string }) => w.id);
      expect(ids).toEqual([orgA.workspaceId]);
      expect(ids).not.toContain(orgB.workspaceId);
    });

    it('10. AuditWriter records the authentication that started the chain', async () => {
      await h.clearRateLimits();
      await login(orgA.email).expect(200);
      const { rows } = await h.admin.execute<{ action: string; actor_user_id: string }>(
        sql`SELECT action, actor_user_id FROM audit_logs WHERE action = ${AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_user_id).toBe(orgA.userId);
    });
  });

  describe('audit atomicity on the authentication path', () => {
    it('commits the session and its audit row together', async () => {
      await h.clearRateLimits();
      const res = await login(orgA.email).expect(200);
      const sid = (jwt.decode(res.body.accessToken as string) as { sid: string }).sid;

      const session = await h.admin.execute(sql`SELECT id FROM sessions WHERE id = ${sid}`);
      const audited = await h.admin.execute(
        sql`SELECT id FROM audit_logs WHERE resource_id = ${sid} AND action = ${AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED}`,
      );
      expect(session.rows).toHaveLength(1);
      expect(audited.rows).toHaveLength(1);
    });

    it('rolls the session back when its audit row cannot be written', async () => {
      // Breaking the acc_auth insert policy makes every audit write from the
      // login path fail. The session must not survive it.
      await h.admin.execute(
        sql`ALTER POLICY audit_logs_auth_insert ON audit_logs WITH CHECK (false)`,
      );
      const before = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM sessions WHERE user_id = ${orgB.userId}`,
      );
      try {
        await h.clearRateLimits();
        await login(orgB.email).expect(500);
      } finally {
        await h.admin.execute(
          sql`ALTER POLICY audit_logs_auth_insert ON audit_logs WITH CHECK (
                scope_type = 'platform'
                AND app_is_auth_audit_action(action)
                AND (
                  actor_type IN ('user','api_key')
                  OR (actor_type = 'system' AND action = 'auth.login.failed'
                      AND actor_label = 'anonymous_login_attempt')
                ))`,
        );
      }

      const after = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM sessions WHERE user_id = ${orgB.userId}`,
      );
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    });

    it('records an unknown-address failure with the anonymous actor', async () => {
      await h.clearRateLimits();
      await login(`ghost-${Date.now()}@example.test`).expect(401);
      const { rows } = await h.admin.execute<{
        actor_type: string;
        actor_label: string;
        actor_user_id: string | null;
        metadata: Record<string, unknown>;
      }>(sql`SELECT actor_type, actor_label, actor_user_id, metadata FROM audit_logs
             WHERE action = ${AUDIT_ACTIONS.AUTH_LOGIN_FAILED}`);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('system');
      expect(rows[0]!.actor_label).toBe('anonymous_login_attempt');
      expect(rows[0]!.actor_user_id).toBeNull();
      // The attempted address is never recorded: it is unverified input, and
      // storing it would turn the audit log into a list of probed addresses.
      expect(JSON.stringify(rows[0]!.metadata)).not.toContain('ghost-');
    });

    it('records logout and session revocation', async () => {
      const token = await tokenFor(orgA.email);
      await request(h.app.getHttpServer())
        .post(url('/auth/logout'))
        .set('authorization', `Bearer ${token}`)
        .set(CSRF_HEADER, '1')
        .expect(204);

      const { rows } = await h.admin.execute<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE action = ${AUDIT_ACTIONS.AUTH_LOGOUT}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('records a token refresh', async () => {
      await h.clearRateLimits();
      const first = await login(orgA.email).expect(200);
      const cookies = first.headers['set-cookie'] as unknown as string[];
      const cookie = cookies.find((c) => c.startsWith(REFRESH_COOKIE))!.split(';')[0]!;

      await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .expect(200);

      const { rows } = await h.admin.execute<{ outcome: string }>(
        sql`SELECT outcome FROM audit_logs WHERE action = ${AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe('success');
    });

    it('never writes a credential into an audit row', async () => {
      await h.clearRateLimits();
      await login(orgA.email).expect(200);
      const { rows } = await h.admin.execute<Record<string, unknown>>(
        sql`SELECT before, after, metadata FROM audit_logs`,
      );
      const serialized = JSON.stringify(rows);
      for (const secret of [PASSWORD, 'argon2', 'refresh_token', 'Bearer ']) {
        expect(serialized).not.toContain(secret);
      }
    });
  });

  describe('logout semantics', () => {
    it('revokes only the presenting session, not every device', async () => {
      // Phase 1B.3 logout is deliberately "this session". Sign-out-everywhere is
      // a separate, explicit action.
      const first = await tokenFor(orgA.email);
      const second = await tokenFor(orgA.email);

      await request(h.app.getHttpServer())
        .post(url('/auth/logout'))
        .set('authorization', `Bearer ${first}`)
        .set(CSRF_HEADER, '1')
        .expect(204);

      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${first}`)
        .expect(401);
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${second}`)
        .expect(200);
    });
  });
});
