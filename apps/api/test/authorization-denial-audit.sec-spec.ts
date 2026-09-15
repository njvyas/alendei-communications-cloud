/**
 * `authorization.denied` auditing (Phase 1B.5.3, ADR-005 D-6).
 *
 * A refused escalation is precisely the event worth having a record of
 * (`RBAC.md` §7), so the record is a security control in its own right and is
 * tested as one. Three properties carry the weight:
 *
 *   1. **It exists.** The record commits in its own transaction *before* the
 *      refusal is thrown. Written into the caller's transaction it would be
 *      rolled back by that very throw, and the control would report nothing
 *      while appearing to work.
 *   2. **It says where the actor legitimately was**, never where it tried to
 *      reach. The database derives the row's tenancy from that pair, so naming
 *      the attempted target would file the record under a tenant the actor was
 *      never in.
 *   3. **It fails closed.** A denial whose record cannot be written does not
 *      become a quiet refusal.
 *
 * And one thing it must *not* do: fire for a target that never resolved. A
 * `404` means no authorizable target was established, so there is nothing to
 * deny and nothing to record — auditing it would also make the trail an
 * existence oracle for anyone who can read it.
 */
import { PERMISSIONS, type AuthPrincipal, type RoleGrant, type ScopeType } from '@acc/contracts';
import { createDatabase, createPool, schema, type Database, type TenantSession } from '@acc/db';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AuthorizationService } from '../src/auth/authorization.service';
import { PermissionEvaluator } from '../src/auth/permission-evaluator.service';
import { ScopeChainResolver } from '../src/auth/scope-chain-resolver.service';
import { AuditWriter } from '../src/audit/audit-writer.service';
import { AUTH_DB } from '../src/database/database.tokens';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import { RequestContext } from '../src/common/context/request-context';
import { AppException } from '../src/common/errors/app.exception';
import {
  createScopedUser,
  createTenant,
  destroyTenant,
  destroyUser,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const READ = PERMISSIONS.WORKSPACES_READ;
const DENIED = 'authorization.denied';

interface DenialRow {
  scope_type: string;
  scope_id: string | null;
  org_id: string | null;
  workspace_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  correlation_id: string;
  before: unknown;
  after: unknown;
}

describe('authorization.denied auditing', () => {
  let h: Harness;
  let authz: AuthorizationService;
  let audit: AuditWriter;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let workspaceTwoId: string;
  let workspaceUser: { userId: string; email: string };
  let apiKeyId: string;

  beforeAll(async () => {
    h = await startHarness();
    authz = h.app.get(AuthorizationService);
    audit = h.app.get(AuditWriter);
    db = h.app.get(TenantDatabase);
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'deny-a', credentials);
    orgB = await createTenant(h.admin, 'deny-b', credentials);

    const [second] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: orgA.orgId, name: 'Second', slug: 'second' })
      .returning({ id: schema.workspaces.id });
    workspaceTwoId = second!.id;

    workspaceUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'deny-ws',
    );

    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: orgA.orgId,
        name: 'denial-key',
        keyPrefix: `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`,
        keyHash: await credentials.hash('a-secret-value-never-audited'),
        createdBy: orgA.userId,
        scopes: [READ],
      })
      .returning({ id: schema.apiKeys.id });
    apiKeyId = key!.id;
  }, 60_000);

  afterAll(async () => {
    await h.admin.execute(sql`DELETE FROM api_keys WHERE org_id = ${orgA.orgId}`);
    await destroyUser(h.admin, workspaceUser.userId);
    await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceTwoId}`);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  // Each case counts rows, so each starts from an empty trail.
  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(() => purgeAudit(h.admin, sql`true`));

  // --- fixtures -------------------------------------------------------------

  const grant = (
    scopeType: ScopeType,
    scopeId: string | null,
    permissions: readonly string[] = [READ],
  ): RoleGrant => ({
    roleId: `role-${scopeType}-${scopeId ?? 'platform'}`,
    roleKey: scopeType,
    scopeType,
    scopeId,
    orgId: scopeType === 'platform' || scopeType === 'reseller' ? null : orgA.orgId,
    permissions,
  });

  const userPrincipal = (
    roles: RoleGrant[],
    tenant: Partial<AuthPrincipal['tenant']> = {},
  ): AuthPrincipal => ({
    actorType: 'user',
    userId: orgA.userId,
    apiKeyId: null,
    sessionId: null,
    tenant: {
      orgId: orgA.orgId,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
      ...tenant,
    },
    roles,
    permissions: [...new Set(roles.flatMap((r) => r.permissions))],
  });

  const apiKeyPrincipal = (): AuthPrincipal => ({
    actorType: 'api_key',
    userId: null,
    apiKeyId,
    sessionId: null,
    tenant: {
      orgId: orgA.orgId,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    // Bound to the organization but carrying nothing, so every target is denied.
    roles: [{ ...grant('organization', orgA.orgId, []), roleKey: 'api_key' }],
    permissions: [],
  });

  const sessionFor = (t: TenantFixture): TenantSession => ({
    orgId: t.orgId,
    resellerId: t.resellerId,
  });

  const inRequest = <T>(principal: AuthPrincipal, work: () => Promise<T>): Promise<T> =>
    RequestContext.run(
      {
        correlationId: uuidv7(),
        requestId: uuidv7(),
        causationId: null,
        traceId: null,
        principal,
        ip: null,
        userAgent: null,
      },
      work,
    );

  /** Attempts an authorization exactly as a handler does, returning the status. */
  const attempt = async (
    principal: AuthPrincipal,
    scopeType: ScopeType,
    scopeId: string | null,
    options: { session?: TenantSession; resourceType?: string; permission?: string } = {},
  ): Promise<number | 'allowed'> => {
    try {
      await inRequest(principal, () =>
        db.withTenant(options.session ?? sessionFor(orgA), (tx) =>
          authz.assert(tx, {
            principal,
            permission: options.permission ?? READ,
            target: { scopeType, scopeId },
            // `'resourceType' in options` rather than `??`, so a case can
            // deliberately omit it and exercise the service's own default.
            resourceType: 'resourceType' in options ? options.resourceType : 'Workspace',
          }),
        ),
      );
      return 'allowed';
    } catch (error) {
      if (typeof (error as AppException).getStatus === 'function') {
        return (error as AppException).getStatus();
      }
      throw error;
    }
  };

  const denialRows = async (): Promise<DenialRow[]> => {
    const { rows } = await h.admin.execute<DenialRow>(
      sql`SELECT * FROM audit_logs WHERE action = ${DENIED} ORDER BY occurred_at`,
    );
    return rows;
  };

  const auditRowCount = async (): Promise<number> => {
    const { rows } = await h.admin.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM audit_logs`,
    );
    return Number(rows[0]!.count);
  };

  // ---------------------------------------------------------------------------
  describe('A-F. a resolved target the principal cannot reach', () => {
    it('A. writes exactly one authorization.denied record', async () => {
      const principal = userPrincipal([grant('workspace', orgA.workspaceId)], {
        workspaceId: orgA.workspaceId,
      });
      expect(await attempt(principal, 'workspace', workspaceTwoId)).toBe(403);

      const rows = await denialRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe('denied');
    });

    it('B. attributes it to the authenticated principal', async () => {
      const principal = userPrincipal([grant('workspace', orgA.workspaceId)], {
        workspaceId: orgA.workspaceId,
      });
      await attempt(principal, 'workspace', workspaceTwoId);

      const [row] = await denialRows();
      expect(row!.actor_type).toBe('user');
      expect(row!.actor_user_id).toBe(orgA.userId);
      expect(row!.actor_api_key_id).toBeNull();
    });

    it('C. records the actor’s legitimate scope, not the scope it attempted', async () => {
      // The principal is pinned to workspace one and reached for workspace two.
      // The row must say workspace one.
      const principal = userPrincipal([grant('workspace', orgA.workspaceId)], {
        workspaceId: orgA.workspaceId,
      });
      await attempt(principal, 'workspace', workspaceTwoId);

      const [row] = await denialRows();
      expect(row!.scope_type).toBe('workspace');
      expect(row!.scope_id).toBe(orgA.workspaceId);
      expect(row!.scope_id).not.toBe(workspaceTwoId);
      // Derived tenancy follows the actor's scope, so the record files under the
      // tenant the actor was actually in.
      expect(row!.workspace_id).toBe(orgA.workspaceId);
      expect(row!.org_id).toBe(orgA.orgId);
    });

    it('C2. uses the narrowest legitimate scope available', async () => {
      // An organization-scoped principal has no workspace pinned, so the honest
      // statement of where it was is the organization.
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      await attempt(principal, 'workspace', orgA.workspaceId);

      const [row] = await denialRows();
      expect(row!.scope_type).toBe('organization');
      expect(row!.scope_id).toBe(orgA.orgId);
    });

    it('D. records the attempted target separately from the actor scope', async () => {
      const principal = userPrincipal([grant('workspace', orgA.workspaceId)], {
        workspaceId: orgA.workspaceId,
      });
      await attempt(principal, 'workspace', workspaceTwoId);

      const [row] = await denialRows();
      expect(row!.resource_id).toBe(workspaceTwoId);
      expect(row!.metadata.attemptedScopeType).toBe('workspace');
      expect(row!.metadata.attemptedScopeId).toBe(workspaceTwoId);
      // The two never collapse into one another.
      expect(row!.metadata.attemptedScopeId).not.toBe(row!.scope_id);
    });

    it('E. records the attempted permission', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [READ])]);
      await attempt(principal, 'organization', orgA.orgId, {
        permission: PERMISSIONS.ROLES_DELETE,
      });

      const [row] = await denialRows();
      expect(row!.metadata.permission).toBe(PERMISSIONS.ROLES_DELETE);
      expect(row!.metadata.denialReason).toBe('AUTHZ_SCOPE_DENIED');
    });

    it('F. records the resource type, defaulting to the target level', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      await attempt(principal, 'team', orgA.teamId, { resourceType: 'Team' });
      expect((await denialRows())[0]!.resource_type).toBe('Team');

      await purgeAudit(h.admin, sql`true`);
      await attempt(principal, 'team', orgA.teamId, { resourceType: undefined });
      expect((await denialRows())[0]!.resource_type).toBe('team');
    });

    it('carries the request correlation id', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      await attempt(principal, 'workspace', orgA.workspaceId);
      expect((await denialRows())[0]!.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('G-I, K. what must NOT be audited', () => {
    it('G. a successful authorization writes nothing', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [READ])]);
      expect(await attempt(principal, 'workspace', orgA.workspaceId)).toBe('allowed');
      expect(await auditRowCount()).toBe(0);
    });

    it('H. a nonexistent target is 404 and writes nothing', async () => {
      // No authorizable target was established, so there is no denial to record.
      const principal = userPrincipal([grant('organization', orgA.orgId, [READ])]);
      expect(await attempt(principal, 'workspace', uuidv7())).toBe(404);
      expect(await auditRowCount()).toBe(0);
    });

    it('I. an RLS-invisible foreign target is 404 and writes nothing', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [READ])]);
      expect(await attempt(principal, 'workspace', orgB.workspaceId)).toBe(404);
      expect(await auditRowCount()).toBe(0);
    });

    it('K. a cross-reseller target is 404 and writes nothing', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [READ])]);
      expect(await attempt(principal, 'organization', orgB.orgId)).toBe(404);
      expect(await auditRowCount()).toBe(0);
      // The trail must not become the existence oracle the 404 exists to avoid:
      // an unknown id and a real foreign one are indistinguishable in both the
      // response and the audit log.
      expect(await attempt(principal, 'organization', uuidv7())).toBe(404);
      expect(await auditRowCount()).toBe(0);
    });

    it('the non-throwing capability probe writes nothing', async () => {
      // `allows` asks a hypothetical for listings and UI affordances. Auditing
      // it would write a row per candidate per render.
      const principal = userPrincipal([grant('workspace', orgA.workspaceId, [])], {
        workspaceId: orgA.workspaceId,
      });
      const allowed = await inRequest(principal, () =>
        db.withTenant(sessionFor(orgA), (tx) =>
          authz.allows(tx, {
            principal,
            permission: READ,
            target: { scopeType: 'workspace', scopeId: workspaceTwoId },
          }),
        ),
      );
      expect(allowed).toBe(false);
      expect(await auditRowCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('J. a sibling target resolves, so it is audited', () => {
    it('records a denial for a sibling workspace in the same organization', async () => {
      // RLS carries no workspace term, so the sibling is visible and genuinely
      // resolvable — the refusal is the authorization layer's, and it is the
      // kind of attempt worth a record.
      const principal = userPrincipal([grant('workspace', orgA.workspaceId)], {
        workspaceId: orgA.workspaceId,
      });
      expect(await attempt(principal, 'workspace', workspaceTwoId)).toBe(403);

      const rows = await denialRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resource_id).toBe(workspaceTwoId);
    });
  });

  // ---------------------------------------------------------------------------
  describe('L. API-key denial', () => {
    it('attributes the key by id, with no user actor', async () => {
      const principal = apiKeyPrincipal();
      expect(await attempt(principal, 'workspace', orgA.workspaceId)).toBe(403);

      const [row] = await denialRows();
      expect(row!.actor_type).toBe('api_key');
      expect(row!.actor_api_key_id).toBe(apiKeyId);
      expect(row!.actor_user_id).toBeNull();
    });

    it('writes no credential material anywhere in the record', async () => {
      const principal = apiKeyPrincipal();
      await attempt(principal, 'workspace', orgA.workspaceId);

      const [row] = await denialRows();
      const serialized = JSON.stringify(row);
      for (const forbidden of [
        'a-secret-value-never-audited',
        '$argon2',
        'ak_test_',
        'Bearer',
        'password',
        'refresh',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('metadata is structured and minimal', () => {
    it('carries exactly the four security fields and nothing else', async () => {
      // A denial record must stay useful to an administrator without becoming a
      // data-exfiltration surface: no request, no headers, no principal, no
      // token, no cookies.
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      await attempt(principal, 'workspace', orgA.workspaceId);

      const [row] = await denialRows();
      expect(Object.keys(row!.metadata).sort()).toEqual([
        'attemptedScopeId',
        'attemptedScopeType',
        'denialReason',
        'permission',
      ]);
      expect(row!.before).toBeNull();
      expect(row!.after).toBeNull();
    });

    it('contains no key that the redactor treats as sensitive', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      await attempt(principal, 'workspace', orgA.workspaceId);

      const [row] = await denialRows();
      for (const key of Object.keys(row!.metadata)) {
        expect(key).not.toMatch(/secret|token|password|credential|hash/i);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('M. fail-closed when the record cannot be written', () => {
    it('does not allow the request when the audit write fails', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      const boom = new Error('audit unavailable');
      const spy = jest.spyOn(audit, 'record').mockRejectedValue(boom);

      try {
        await expect(
          inRequest(principal, () =>
            db.withTenant(sessionFor(orgA), (tx) =>
              authz.assert(tx, {
                principal,
                permission: READ,
                target: { scopeType: 'workspace', scopeId: orgA.workspaceId },
                resourceType: 'Workspace',
              }),
            ),
          ),
          // The failure surfaces rather than being swallowed into a plain 403.
        ).rejects.toThrow('audit unavailable');
      } finally {
        spy.mockRestore();
      }

      // And nothing was recorded, so the refusal never looked audited.
      expect(await auditRowCount()).toBe(0);
    });

    it('never converts an audit failure into a silent success', async () => {
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      const spy = jest.spyOn(audit, 'record').mockRejectedValue(new Error('audit unavailable'));
      let outcome: string;
      try {
        await inRequest(principal, () =>
          db.withTenant(sessionFor(orgA), (tx) =>
            authz.assert(tx, {
              principal,
              permission: READ,
              target: { scopeType: 'workspace', scopeId: orgA.workspaceId },
              resourceType: 'Workspace',
            }),
          ),
        );
        outcome = 'allowed';
      } catch {
        outcome = 'refused';
      } finally {
        spy.mockRestore();
      }
      expect(outcome).toBe('refused');
    });
  });

  // ---------------------------------------------------------------------------
  describe('N. transaction semantics', () => {
    it('the denial record survives the surrounding transaction rolling back', async () => {
      // This is the property the whole design turns on (ADR-005 D-6). The
      // refusal is thrown out of the caller's transaction, which rolls it back —
      // so a record written *there* would be discarded every single time.
      // Committing separately, before the throw, is what makes it exist.
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);

      await expect(
        inRequest(principal, () =>
          db.withTenant(sessionFor(orgA), async (tx) => {
            await authz.assert(tx, {
              principal,
              permission: READ,
              target: { scopeType: 'workspace', scopeId: orgA.workspaceId },
              resourceType: 'Workspace',
            });
          }),
        ),
      ).rejects.toBeInstanceOf(AppException);

      expect(await denialRows()).toHaveLength(1);
    });

    it('survives a rollback caused by something else entirely', async () => {
      // Even when the caller swallows the refusal and then fails its own
      // transaction for an unrelated reason, the attempt still happened and the
      // record still stands.
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);

      await expect(
        inRequest(principal, () =>
          db.withTenant(sessionFor(orgA), async (tx) => {
            await authz
              .assert(tx, {
                principal,
                permission: READ,
                target: { scopeType: 'workspace', scopeId: orgA.workspaceId },
                resourceType: 'Workspace',
              })
              .catch(() => undefined);
            throw new Error('unrelated business failure');
          }),
        ),
      ).rejects.toThrow('unrelated business failure');

      expect(await denialRows()).toHaveLength(1);
    });

    it('writes the record before the refusal reaches the caller', async () => {
      // Ordering matters: a record written after the throw would depend on the
      // caller not short-circuiting.
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);
      let countAtThrow = -1;

      await inRequest(principal, () =>
        db
          .withTenant(sessionFor(orgA), (tx) =>
            authz.assert(tx, {
              principal,
              permission: READ,
              target: { scopeType: 'workspace', scopeId: orgA.workspaceId },
              resourceType: 'Workspace',
            }),
          )
          .catch(async () => {
            countAtThrow = (await denialRows()).length;
          }),
      );

      expect(countAtThrow).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('O. an exhausted connection pool', () => {
    // The denial record is written on a *second* connection, checked out of the
    // same pool the caller's transaction already holds one from. That is what
    // makes the record survive the caller's rollback — and it is also the one
    // place the design can deadlock: with `DATABASE_POOL_MAX=1` the caller holds
    // the only connection, so the audit write can never obtain one.
    //
    // The outcome must be a bounded, loud failure, never a quiet 403. `pg`
    // bounds a queued acquisition with `connectionTimeoutMillis` (defaulted to
    // five seconds by `createPool`), which is what turns an otherwise indefinite
    // wait into an error. A short timeout is used here so the case stays fast;
    // the mechanism is identical at the production default.
    const ACQUIRE_TIMEOUT_MS = 750;

    it('fails closed and bounded rather than hanging or returning a plain 403', async () => {
      const pool = createPool({
        connectionString: process.env.DATABASE_URL!,
        max: 1,
        connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
        applicationName: 'acc-test-denial-pool-1',
      });
      const constrainedDb: Database = createDatabase(pool);
      const constrained = new TenantDatabase(constrainedDb, h.app.get<Database>(AUTH_DB));
      // The real resolver, evaluator and writer; only the pool is constrained.
      const service = new AuthorizationService(
        h.app.get(ScopeChainResolver),
        h.app.get(PermissionEvaluator),
        audit,
        constrained,
      );
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);

      const startedAt = Date.now();
      let outcome: 'allowed' | 'refused' = 'allowed';
      let failure: unknown;
      try {
        await inRequest(principal, () =>
          // The caller's transaction holds the pool's only connection for as
          // long as the denial path runs inside it.
          constrained.withTenant(sessionFor(orgA), (tx) =>
            service.assert(tx, {
              principal,
              permission: READ,
              target: { scopeType: 'workspace', scopeId: orgA.workspaceId },
              resourceType: 'Workspace',
            }),
          ),
        );
      } catch (error) {
        outcome = 'refused';
        failure = error;
      } finally {
        await pool.end();
      }

      // No bypass: the request did not proceed.
      expect(outcome).toBe('refused');
      // And it was not the 403 — an unrecorded denial must not be reported as a
      // cleanly audited one. The exception filter renders this as a 500.
      expect(failure).not.toBeInstanceOf(AppException);
      expect(String((failure as Error).message)).toMatch(
        /timeout exceeded when trying to connect/i,
      );
      // Bounded, not an indefinite hang.
      expect(Date.now() - startedAt).toBeLessThan(ACQUIRE_TIMEOUT_MS * 8);
      // Nothing was recorded, so nothing claims the denial was audited.
      expect(await auditRowCount()).toBe(0);
    }, 20_000);

    it('recovers once a connection is available again', async () => {
      // The exhaustion is a resource condition, not a poisoned code path: the
      // same service on the same constrained pool records normally as soon as
      // the pool can serve two connections.
      const pool = createPool({
        connectionString: process.env.DATABASE_URL!,
        max: 2,
        connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
        applicationName: 'acc-test-denial-pool-2',
      });
      const constrained = new TenantDatabase(createDatabase(pool), h.app.get<Database>(AUTH_DB));
      const service = new AuthorizationService(
        h.app.get(ScopeChainResolver),
        h.app.get(PermissionEvaluator),
        audit,
        constrained,
      );
      const principal = userPrincipal([grant('organization', orgA.orgId, [])]);

      try {
        await expect(
          inRequest(principal, () =>
            constrained.withTenant(sessionFor(orgA), (tx) =>
              service.assert(tx, {
                principal,
                permission: READ,
                target: { scopeType: 'workspace', scopeId: orgA.workspaceId },
                resourceType: 'Workspace',
              }),
            ),
          ),
        ).rejects.toBeInstanceOf(AppException);
      } finally {
        await pool.end();
      }

      expect(await denialRows()).toHaveLength(1);
    }, 20_000);
  });
});
