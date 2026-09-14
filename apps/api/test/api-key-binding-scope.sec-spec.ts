/**
 * API-key creator authority at the key's binding scope (Phase 1B.5.1, ADR-005 D-4).
 *
 * `RBAC.md` §5c defines the middle term of the effective-permission intersection
 * as what the creator holds **at a scope covering the key's own binding** — not
 * everything the creator holds anywhere. The implementation previously used the
 * creator's flattened union across every grant, which is the same cross-product
 * error the evaluator had, applied to the creator instead of the caller.
 *
 * Concretely, what these prevent: a creator who administers one workspace, or a
 * different organization, minting a key that carries that authority somewhere it
 * was never granted. A credential must not be a way to move permissions between
 * scopes.
 *
 * Every case here drives the real application over HTTP with real keys, real
 * grants and the real guard.
 */
import { PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  destroyUser,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

/** The permission every fixture role below actually carries. */
const HELD = PERMISSIONS.WORKSPACES_READ;

describe('API-key creator authority at the binding scope', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let credentials: CredentialService;

  /** A second workspace in Organization A, for the sibling cases. */
  let workspaceTwoId: string;
  /** A role in Organization A carrying no permissions at all. */
  let emptyRoleId: string;

  let workspaceOneCreator: { userId: string; email: string };
  let workspaceTwoCreator: { userId: string; email: string };
  let crossOrgCreator: { userId: string; email: string };
  let splitCreator: { userId: string; email: string };
  let resellerCreator: { userId: string; email: string };

  const issueKey = async (options: {
    tenant: TenantFixture;
    createdBy: string | null;
    workspaceId?: string | null;
    scopes?: string[];
  }): Promise<string> => {
    const secret = `secret-${uuidv7()}`;
    const prefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: options.tenant.orgId,
      workspaceId: options.workspaceId ?? null,
      name: `key-${prefix}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      createdBy: options.createdBy,
      scopes: options.scopes ?? [HELD],
    });
    return `${prefix}.${secret}`;
  };

  /** The key's effective permissions, as the application actually resolves them. */
  const effectivePermissionsOf = async (credential: string): Promise<string[]> => {
    const me = await request(h.app.getHttpServer())
      .get(url('/auth/me'))
      .set('authorization', `Bearer ${credential}`)
      .expect(200);
    return me.body.permissions as string[];
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'bind-a', credentials);
    orgB = await createTenant(h.admin, 'bind-b', credentials);

    const [workspaceTwo] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: orgA.orgId, name: 'Second', slug: 'second' })
      .returning({ id: schema.workspaces.id });
    workspaceTwoId = workspaceTwo!.id;

    // A role in Organization A with an empty permission set. It exists to be the
    // grant that supplies *scope* without supplying *permission* — the other
    // half of a creator-side cross-product.
    const [empty] = await h.admin
      .insert(schema.roles)
      .values({ orgId: orgA.orgId, key: 'empty_role', name: 'Empty', isSystemRole: false })
      .returning({ id: schema.roles.id });
    emptyRoleId = empty!.id;

    workspaceOneCreator = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'bind-ws1',
    );
    workspaceTwoCreator = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      workspaceTwoId,
      'bind-ws2',
    );
    // Holds an organization-scoped grant in Organization B and nothing in A.
    crossOrgCreator = await createScopedUser(
      h.admin,
      orgB,
      credentials,
      'organization',
      orgB.orgId,
      'bind-cross',
    );

    // Two grants in Organization A: the organization-scoped one carries no
    // permissions, the workspace-scoped one carries `workspaces.read`.
    splitCreator = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'bind-split',
    );
    await h.admin.insert(schema.userRoles).values({
      userId: splitCreator.userId,
      roleId: emptyRoleId,
      scopeType: 'organization',
      scopeId: orgA.orgId,
    });

    // A reseller-scoped creator, over Organization A's own reseller.
    resellerCreator = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'organization',
      orgA.orgId,
      'bind-reseller',
    );
    await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${resellerCreator.userId}`);
    const [resellerRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, 'reseller_admin'));
    // A reseller grant uses a platform-level role, which the scope trigger only
    // admits for a platform admin — the same elevation `seed.ts` uses. The GUC
    // is transaction-local, so it and the insert must share one transaction.
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: resellerCreator.userId,
        roleId: resellerRole!.id,
        scopeType: 'reseller',
        scopeId: orgA.resellerId,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await h.admin.execute(sql`DELETE FROM api_keys WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})`);
    for (const u of [
      workspaceOneCreator,
      workspaceTwoCreator,
      crossOrgCreator,
      splitCreator,
      resellerCreator,
    ]) {
      await destroyUser(h.admin, u.userId);
    }
    await h.admin.execute(sql`DELETE FROM role_permissions WHERE role_id = ${emptyRoleId}`);
    await h.admin.execute(sql`DELETE FROM roles WHERE id = ${emptyRoleId}`);
    await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceTwoId}`);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  afterEach(() => purgeAudit(h.admin, sql`true`));

  // ---------------------------------------------------------------------------
  describe('A. creator holds the permission at exactly the binding scope', () => {
    it('an organization-bound key created by an organization-scoped creator carries it', async () => {
      const credential = await issueKey({ tenant: orgA, createdBy: orgA.userId });
      expect(await effectivePermissionsOf(credential)).toContain(HELD);
    });

    it('a workspace-bound key created by that workspace’s creator carries it', async () => {
      const credential = await issueKey({
        tenant: orgA,
        createdBy: workspaceOneCreator.userId,
        workspaceId: orgA.workspaceId,
      });
      expect(await effectivePermissionsOf(credential)).toContain(HELD);
    });
  });

  // ---------------------------------------------------------------------------
  describe('B. creator holds it only at a sibling scope', () => {
    it('a key bound to workspace one does not inherit from a workspace-two creator', async () => {
      // Horizontal isolation on the creator side. RLS carries no workspace term
      // (`TENANCY.md` §3a), so this boundary exists only here.
      const credential = await issueKey({
        tenant: orgA,
        createdBy: workspaceTwoCreator.userId,
        workspaceId: orgA.workspaceId,
      });
      expect(await effectivePermissionsOf(credential)).not.toContain(HELD);
      expect(await effectivePermissionsOf(credential)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('C. creator holds it only at a narrower child scope', () => {
    it('an organization-bound key does not inherit upward from a workspace-scoped creator', async () => {
      // `scopeCovers` is downward-only (`TENANCY.md` §1a.4): a workspace grant
      // never reaches the organization above it. Nothing is invented here — the
      // case is decided by the same rule the evaluator uses.
      const credential = await issueKey({
        tenant: orgA,
        createdBy: workspaceOneCreator.userId,
      });
      expect(await effectivePermissionsOf(credential)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('D. creator holds it in an unrelated organization', () => {
    it('a key bound to Organization A does not inherit a creator’s Organization B authority', async () => {
      const credential = await issueKey({ tenant: orgA, createdBy: crossOrgCreator.userId });
      expect(await effectivePermissionsOf(credential)).toEqual([]);
    });

    it('and the key still authenticates — this is authorization, not credential validity', async () => {
      const credential = await issueKey({ tenant: orgA, createdBy: crossOrgCreator.userId });
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${credential}`)
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('E. creator-side cross-product', () => {
    it('does not combine one grant’s permission with another grant’s scope', async () => {
      // The creator holds an organization-scoped grant carrying nothing, and a
      // workspace-scoped grant carrying `workspaces.read`. Neither grant confers
      // `workspaces.read` at the organization, so an organization-bound key must
      // receive nothing. A flattened creator union would hand it over.
      const credential = await issueKey({ tenant: orgA, createdBy: splitCreator.userId });
      expect(await effectivePermissionsOf(credential)).toEqual([]);
    });

    it('but still grants it where one coherent creator grant does cover the binding', async () => {
      // The positive control for the case above, on the same creator: bound to
      // the workspace the permission-carrying grant actually covers.
      const credential = await issueKey({
        tenant: orgA,
        createdBy: splitCreator.userId,
        workspaceId: orgA.workspaceId,
      });
      expect(await effectivePermissionsOf(credential)).toContain(HELD);
    });
  });

  // ---------------------------------------------------------------------------
  describe('legitimate downward inheritance is preserved', () => {
    it('an organization-scoped creator covers a workspace-bound key', async () => {
      // The correction must narrow the creator's reach to the binding scope,
      // not break inheritance into it.
      const credential = await issueKey({
        tenant: orgA,
        createdBy: orgA.userId,
        workspaceId: orgA.workspaceId,
      });
      expect(await effectivePermissionsOf(credential)).toContain(HELD);
    });

    it('a reseller-scoped creator covers an organization-bound key beneath that reseller', async () => {
      // Requires the chain's reseller term: without it `scopeCovers` cannot see
      // that the organization sits under the creator's reseller, and every key a
      // reseller admin creates would silently resolve to no permissions.
      const credential = await issueKey({ tenant: orgA, createdBy: resellerCreator.userId });
      expect(await effectivePermissionsOf(credential)).toContain(HELD);
    });

    it('but a reseller-scoped creator does not reach another reseller’s organization', async () => {
      const credential = await issueKey({ tenant: orgB, createdBy: resellerCreator.userId });
      expect(await effectivePermissionsOf(credential)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('F. requested permissions exceeding creator authority at the binding', () => {
    it('restricts the key to the intersection rather than refusing it', async () => {
      const credential = await issueKey({
        tenant: orgA,
        createdBy: orgA.userId,
        scopes: [HELD, PERMISSIONS.ROLES_DELETE, PERMISSIONS.API_KEYS_CREATE],
      });
      const effective = await effectivePermissionsOf(credential);
      expect(effective).toContain(HELD);
      expect(effective).not.toContain(PERMISSIONS.ROLES_DELETE);
      expect(effective).not.toContain(PERMISSIONS.API_KEYS_CREATE);
    });

    it('resolves to nothing when the creator is unknown, whatever the key requests', async () => {
      const credential = await issueKey({
        tenant: orgA,
        createdBy: null,
        scopes: [HELD, PERMISSIONS.ROLES_DELETE],
      });
      expect(await effectivePermissionsOf(credential)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('G-I. authentication, binding and bookkeeping are unchanged', () => {
    it('a valid key still authenticates and reaches its own tenant data', async () => {
      const credential = await issueKey({ tenant: orgA, createdBy: orgA.userId });
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${credential}`)
        .expect(200);
      const ids = res.body.workspaces.map((w: { id: string }) => w.id);
      expect(ids).toContain(orgA.workspaceId);
      expect(ids).not.toContain(orgB.workspaceId);
    });

    it('still records last_used_at and an api_key.authenticated audit row', async () => {
      const credential = await issueKey({ tenant: orgA, createdBy: orgA.userId });
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${credential}`)
        .expect(200);

      const touched = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM api_keys WHERE org_id = ${orgA.orgId} AND last_used_at IS NOT NULL`,
      );
      expect(Number(touched.rows[0]!.count)).toBeGreaterThan(0);

      const audited = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM audit_logs WHERE action = 'api_key.authenticated'`,
      );
      expect(Number(audited.rows[0]!.count)).toBeGreaterThan(0);
    });

    it('still refuses an X-Acc-Organization naming another organization', async () => {
      const credential = await issueKey({ tenant: orgA, createdBy: orgA.userId });
      await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${credential}`)
        .set('x-acc-organization', orgB.orgId)
        .expect(403);
    });

    it('still binds a workspace-scoped key to its workspace grant', async () => {
      const credential = await issueKey({
        tenant: orgA,
        createdBy: orgA.userId,
        workspaceId: orgA.workspaceId,
      });
      const me = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${credential}`)
        .expect(200);
      expect(me.body.roles).toHaveLength(1);
      expect(me.body.roles[0]).toMatchObject({
        roleKey: 'api_key',
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });
    });
  });
});
