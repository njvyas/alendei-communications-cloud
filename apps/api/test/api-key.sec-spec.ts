/**
 * API-key authentication and authorization (Phase 1B.3).
 *
 * Added after an independent review found that API-key principals authenticated
 * and were then denied everything, because the principal carried no scoped
 * grant for `PermissionEvaluator` to evaluate coverage against. The whole method
 * had no test coverage, which is why a green suite reported it working.
 */
import { AUDIT_ACTIONS, ERROR_CODES } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

interface IssuedKey {
  readonly id: string;
  readonly credential: string;
}

describe('API-key authentication', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let credentials: CredentialService;

  /** Plants a key directly; key *administration* is Phase 1B.6. */
  const issueKey = async (
    tenant: TenantFixture,
    options: {
      scopes?: string[];
      createdBy?: string | null;
      workspaceId?: string | null;
      revoked?: boolean;
      expired?: boolean;
    } = {},
  ): Promise<IssuedKey> => {
    const secret = `secret-${uuidv7()}`;
    const prefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
    const [row] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        workspaceId: options.workspaceId ?? null,
        name: `key-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: options.createdBy === undefined ? tenant.userId : options.createdBy,
        scopes: options.scopes ?? ['workspaces.read'],
        revokedAt: options.revoked ? new Date() : null,
        expiresAt: options.expired ? new Date(Date.now() - 60_000) : null,
      })
      .returning({ id: schema.apiKeys.id });
    return { id: row!.id, credential: `${prefix}.${secret}` };
  };

  const get = (path: string, credential?: string) => {
    const req = request(h.app.getHttpServer()).get(url(path));
    return credential ? req.set('authorization', `Bearer ${credential}`) : req;
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'key-a', credentials);
    orgB = await createTenant(h.admin, 'key-b', credentials);
  }, 60_000);

  afterAll(async () => {
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  afterEach(() => purgeAudit(h.admin, sql`true`));

  // ---------------------------------------------------------------------------
  describe('the effective-permission intersection', () => {
    it('A. authorizes when the creator holds the requested permission', async () => {
      const key = await issueKey(orgA, { scopes: ['workspaces.read'] });
      const res = await get('/tenants/workspaces', key.credential).expect(200);
      expect(res.body.workspaces.map((w: { id: string }) => w.id)).toEqual([orgA.workspaceId]);
    });

    it('B. denies when the creator does not hold the requested permission', async () => {
      // The key asks for a permission its creator never had. Placing a scope
      // string on the key must not conjure authority.
      const key = await issueKey(orgA, { scopes: ['roles.delete', 'workspaces.read'] });
      const me = await get('/auth/me', key.credential).expect(200);
      expect(me.body.permissions).toContain('workspaces.read');
      expect(me.body.permissions).not.toContain('roles.delete');
    });

    it('B2. a key requesting only unheld permissions is authenticated but authorizes nothing', async () => {
      const key = await issueKey(orgA, { scopes: ['roles.delete'] });
      await get('/auth/me', key.credential).expect(200);
      const res = await get('/tenants/workspaces', key.credential).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('C. loses a permission as soon as its creator does — never snapshotted', async () => {
      const key = await issueKey(orgA, { scopes: ['workspaces.read'] });
      await get('/tenants/workspaces', key.credential).expect(200);

      // Strip workspaces.read from the creator's role.
      const [permission] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, 'workspaces.read'));
      await h.admin.execute(
        sql`DELETE FROM role_permissions WHERE role_id = ${orgA.roleId} AND permission_id = ${permission!.id}`,
      );

      try {
        const after = await get('/tenants/workspaces', key.credential).expect(403);
        expect(after.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
        const me = await get('/auth/me', key.credential).expect(200);
        expect(me.body.permissions).not.toContain('workspaces.read');
      } finally {
        await h.admin
          .insert(schema.rolePermissions)
          .values({ roleId: orgA.roleId, permissionId: permission!.id })
          .onConflictDoNothing();
      }
    });

    it('resolves no permissions for a key whose creator is unknown', async () => {
      const key = await issueKey(orgA, { createdBy: null, scopes: ['workspaces.read'] });
      const me = await get('/auth/me', key.credential).expect(200);
      expect(me.body.permissions).toEqual([]);
      await get('/tenants/workspaces', key.credential).expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  describe('the synthesized grant', () => {
    it("carries exactly one grant, at the key's own binding and never platform", async () => {
      const key = await issueKey(orgA);
      const me = await get('/auth/me', key.credential).expect(200);

      expect(me.body.roles).toHaveLength(1);
      expect(me.body.roles[0]).toMatchObject({
        roleKey: 'api_key',
        scopeType: 'organization',
        scopeId: orgA.orgId,
        orgId: orgA.orgId,
      });
      expect(me.body.roles[0].scopeType).not.toBe('platform');
      expect(me.body.tenant.isPlatformAdmin).toBe(false);
    });

    it('binds a workspace-scoped key to its workspace', async () => {
      const key = await issueKey(orgA, { workspaceId: orgA.workspaceId });
      const me = await get('/auth/me', key.credential).expect(200);
      expect(me.body.roles[0]).toMatchObject({
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });
      expect(me.body.tenant.workspaceId).toBe(orgA.workspaceId);
    });

    it('refuses a workspace-bound key an organization-wide operation', async () => {
      // Downward-only inheritance: a workspace grant does not cover an
      // organization-scoped target, so narrowing genuinely narrows.
      const key = await issueKey(orgA, { workspaceId: orgA.workspaceId });
      const res = await get('/tenants/workspaces', key.credential).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });
  });

  // ---------------------------------------------------------------------------
  describe('organization binding', () => {
    it("reaches only its own organization's data", async () => {
      const key = await issueKey(orgA);
      const res = await get('/tenants/workspaces', key.credential).expect(200);
      const ids = res.body.workspaces.map((w: { id: string }) => w.id);
      expect(ids).toContain(orgA.workspaceId);
      expect(ids).not.toContain(orgB.workspaceId);
    });

    it('refuses a selector naming another organization, never substituting', async () => {
      const key = await issueKey(orgA);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${key.credential}`)
        .set('x-acc-organization', orgB.orgId)
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      expect(res.body).not.toHaveProperty('workspaces');
    });

    it('accepts a selector naming its own organization', async () => {
      const key = await issueKey(orgA);
      await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${key.credential}`)
        .set('x-acc-organization', orgA.orgId)
        .expect(200);
    });

    it("returns 404 for another organization's workspace id", async () => {
      const key = await issueKey(orgA);
      const res = await get(`/tenants/workspaces/${orgB.workspaceId}`, key.credential).expect(404);
      expect(JSON.stringify(res.body)).not.toContain(orgB.workspaceId);
    });
  });

  // ---------------------------------------------------------------------------
  describe('credential failure cases', () => {
    it('refuses a revoked key with 401', async () => {
      const key = await issueKey(orgA, { revoked: true });
      const res = await get('/auth/me', key.credential).expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_API_KEY_INVALID);
    });

    it('refuses an expired key with 401', async () => {
      const key = await issueKey(orgA, { expired: true });
      await get('/auth/me', key.credential).expect(401);
    });

    it('refuses a valid prefix with the wrong secret', async () => {
      const key = await issueKey(orgA);
      const [prefix] = key.credential.split('.');
      await get('/auth/me', `${prefix}.the-wrong-secret`).expect(401);
    });

    it('refuses an unknown prefix, indistinguishably from a wrong secret', async () => {
      const key = await issueKey(orgA);
      const [prefix] = key.credential.split('.');
      const unknown = await get(
        '/auth/me',
        `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}.whatever`,
      ).expect(401);
      const wrongSecret = await get('/auth/me', `${prefix}.the-wrong-secret`).expect(401);
      // Existence of a key must not be disclosed by the response.
      expect(unknown.body.error.code).toBe(wrongSecret.body.error.code);
      expect(unknown.body.error.message).toBe(wrongSecret.body.error.message);
    });

    it('treats a malformed key as a bearer token and refuses it', async () => {
      for (const bad of ['ak_test_short.secret', 'ak_bogus_aaaaaaaaaaaaaaaa.s', 'no-dot-at-all']) {
        await get('/auth/me', bad).expect(401);
      }
    });

    it('never echoes the presented credential in an error', async () => {
      const key = await issueKey(orgA);
      const [prefix] = key.credential.split('.');
      const res = await get('/auth/me', `${prefix}.the-wrong-secret`).expect(401);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(prefix);
      expect(body).not.toContain('the-wrong-secret');
    });
  });

  // ---------------------------------------------------------------------------
  describe('audit', () => {
    it('records api_key.authenticated with the key as actor and no credential', async () => {
      const key = await issueKey(orgA);
      await get('/tenants/workspaces', key.credential).expect(200);

      const { rows } = await h.admin.execute<{
        actor_type: string;
        actor_api_key_id: string;
        actor_user_id: string | null;
        scope_type: string;
        outcome: string;
        metadata: Record<string, unknown>;
      }>(sql`SELECT actor_type, actor_api_key_id, actor_user_id, scope_type, outcome, metadata
             FROM audit_logs WHERE action = ${AUDIT_ACTIONS.API_KEY_AUTHENTICATED}`);

      expect(rows.length).toBeGreaterThanOrEqual(1);
      const row = rows[0]!;
      expect(row.actor_type).toBe('api_key');
      expect(row.actor_api_key_id).toBe(key.id);
      expect(row.actor_user_id).toBeNull();
      expect(row.scope_type).toBe('platform');
      expect(row.outcome).toBe('success');

      const serialized = JSON.stringify(rows);
      const [prefix, secret] = key.credential.split('.');
      expect(serialized).not.toContain(prefix);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('Bearer');
    });

    it('writes no audit row for a failed key authentication', async () => {
      const key = await issueKey(orgA);
      const [prefix] = key.credential.split('.');
      await get('/auth/me', `${prefix}.wrong`).expect(401);

      const { rows } = await h.admin.execute(
        sql`SELECT id FROM audit_logs WHERE action = ${AUDIT_ACTIONS.API_KEY_AUTHENTICATED}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('updates last_used_at in the same transaction as the audit row', async () => {
      const key = await issueKey(orgA);
      await get('/auth/me', key.credential).expect(200);

      const [row] = (
        await h.admin.execute<{ last_used_at: string | null }>(
          sql`SELECT last_used_at FROM api_keys WHERE id = ${key.id}`,
        )
      ).rows;
      expect(row!.last_used_at).not.toBeNull();

      const audited = await h.admin.execute(
        sql`SELECT id FROM audit_logs WHERE action = ${AUDIT_ACTIONS.API_KEY_AUTHENTICATED} AND resource_id = ${key.id}`,
      );
      expect(audited.rows).toHaveLength(1);
    });

    it('rolls back bookkeeping and the request when the audit row is refused', async () => {
      // The bookkeeping and its audit row share one transaction: if the audit
      // write is impossible, the authentication does not quietly proceed with
      // an unrecorded last_used_at.
      const key = await issueKey(orgA);
      await h.admin.execute(
        sql`ALTER POLICY audit_logs_auth_insert ON audit_logs WITH CHECK (false)`,
      );
      try {
        await get('/auth/me', key.credential).expect(500);
        const [row] = (
          await h.admin.execute<{ last_used_at: string | null }>(
            sql`SELECT last_used_at FROM api_keys WHERE id = ${key.id}`,
          )
        ).rows;
        expect(row!.last_used_at).toBeNull();
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
    });
  });
});
