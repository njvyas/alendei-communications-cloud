/**
 * ADR-015 R-11 (MEDIUM-3) — revocation is symmetric with granting, and role
 * edits check removed permissions — plus the revoke side of R-6 delegation.
 *
 *   * `DELETE /role-assignments/:id` requires, beyond `role_assignments.revoke`
 *     at the grant's own scope, that the actor holds every permission of the
 *     grant's role at a scope covering the grant — guard 4 of `grant`, the same
 *     function (`assertWithinActorAuthority`), the role row locked `FOR SHARE`
 *     before its permissions are read. Refusal: `403
 *     AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION`, `details.rejected`, row untouched.
 *   * The delegation exception (`RBAC.md` §7b) decides a revocation under
 *     exactly the grant-side constraints, through the same evaluator; a
 *     delegated revocation's audit row carries `metadata.delegation` and the
 *     sorted `delegatedPermissions`.
 *   * `PATCH /roles/:id` refuses removing a permission the actor does not hold.
 *
 * Every role carrying a tenant-content key is a disposable-test fixture
 * (follow-up decision 6). The last-organization-administrator rule is covered
 * in `organization-admin-liveness.sec-spec.ts`; every case here keeps another
 * administrator in place so that rule is never the reason for an outcome.
 */
import { randomBytes } from 'node:crypto';
import {
  ERROR_CODES,
  PERMISSIONS,
  PLATFORM_ROLE_DEFINITIONS,
  PLATFORM_ROLE_KEYS,
  TENANT_ROLE_DEFINITIONS,
  TENANT_ROLE_KEYS,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url, type Org, type Person } from './revocation-fixtures';

const DELEGATE = PERMISSIONS.PLATFORM_ROLES_DELEGATE_TENANT;
const defn = (key: string) =>
  [...TENANT_ROLE_DEFINITIONS, ...PLATFORM_ROLE_DEFINITIONS].find((r) => r.key === key)!
    .permissions as readonly string[];
const ORG_ADMIN = defn(TENANT_ROLE_KEYS.ORG_ADMIN);
const WORKSPACE_MANAGER = defn(TENANT_ROLE_KEYS.WORKSPACE_MANAGER);
const RESELLER_ADMIN = defn(PLATFORM_ROLE_KEYS.RESELLER_ADMIN);
const minus = (a: readonly string[], b: readonly string[]) =>
  a.filter((k) => !b.includes(k)).sort();
/** Fixture content keys on T's org_admin (sorted). */
const FIXTURE_CONTENT = ['contacts.read', 'templates.read'];

describe('symmetric revocation, role-edit removal and delegated revocation (ADR-015 R-11, R-6)', () => {
  let h: Harness;
  let w: RevocationWorld;
  /** Production roles, no content key. */
  let c: Org;
  /** org_admin carries FIXTURE_CONTENT; workspace_manager carries contacts.read. */
  let t: Org;
  /** org_admin widened (fixture) to organization+workspace, carrying contacts.read. */
  let t2: Org;
  /** An organization whose `org_admin` is a NON-system role carrying contacts.read. */
  let v: { orgId: string; roleId: string };
  let customContentRole: string;
  const people: Record<string, Person> = {};
  const tokens: Record<string, string> = {};

  /** The ordinary refusal: 403, the exact rejected keys, and the grant untouched. */
  async function expectRefused(
    res: request.Response,
    grantId: string,
    rejected: readonly string[],
  ) {
    expect([res.status, res.body.error?.code]).toEqual([
      403,
      ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
    ]);
    expect([...(res.body.error.details.rejected as string[])].sort()).toEqual([...rejected].sort());
    expect(await w.grantExists(grantId)).toBe(true);
    expect(await w.revokedAudit(grantId)).toEqual([]);
  }

  /** A fresh grant of `roleKey` in `org` to a fresh user. */
  async function grantOf(
    org: Org,
    roleKey: string,
    scope: 'organization' | 'workspace' = 'organization',
  ) {
    const person = await w.person(`rv-${roleKey}`);
    return w.grant(
      person.userId,
      org.roles[roleKey]!,
      scope,
      scope === 'organization' ? org.orgId : org.workspaceId,
    );
  }

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('revocation');

    c = await w.org('c');
    t = await w.org('t');
    t2 = await w.org('t2');
    await w.attach(t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, FIXTURE_CONTENT);
    await w.attach(t.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!, ['contacts.read']);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx
        .update(schema.roles)
        .set({ allowedScopeTypes: ['organization', 'workspace'] })
        .where(eq(schema.roles.id, t2.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!));
    });
    await w.attach(t2.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, ['contacts.read']);

    const [custom] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: t.orgId,
        key: 'content_custom',
        name: 'Custom with content',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    customContentRole = custom!.id;
    await w.attach(customContentRole, ['contacts.read', 'users.read']);

    // An organization whose role keyed `org_admin` is NOT a system role (no
    // provisioning, so the key is free).
    const [vOrg] = await h.admin
      .insert(schema.organizations)
      .values({ name: 'R11 v', slug: `r11-v-${uuidv7().slice(-10)}`, resellerId: w.resellerId })
      .returning({ id: schema.organizations.id });
    w.createdOrgs.push(vOrg!.id);
    const [vRole] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: vOrg!.id,
        key: TENANT_ROLE_KEYS.ORG_ADMIN,
        name: 'Not the system org_admin',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    await w.attach(vRole!.id, [...ORG_ADMIN, 'contacts.read']);
    v = { orgId: vOrg!.id, roleId: vRole!.id };

    // Every organization keeps administrators of its own, so the liveness rule
    // is never what decides a case here.
    for (const org of [c, t, t2]) {
      await w.admin(org, 'rv-keeper-1');
      await w.admin(org, 'rv-keeper-2');
    }

    people.superAdmin = await w.superAdmin('rv-super');
    people.delegator = await w.person('rv-delegator');
    await w.grant(
      people.delegator.userId,
      await w.platformRole('full', [DELEGATE, ...ORG_ADMIN]),
      'platform',
      null,
    );
    people.noDisable = await w.person('rv-nodisable');
    await w.grant(
      people.noDisable.userId,
      await w.platformRole(
        'nodisable',
        [DELEGATE, ...ORG_ADMIN].filter((k) => k !== PERMISSIONS.USERS_DISABLE),
      ),
      'platform',
      null,
    );
    people.tenantsManager = await w.person('rv-tm');
    await w.grant(
      people.tenantsManager.userId,
      await w.platformRole('tm', [PERMISSIONS.PLATFORM_TENANTS_MANAGE, ...ORG_ADMIN]),
      'platform',
      null,
    );
    people.noDelegate = await w.person('rv-nodelegate');
    await w.grant(
      people.noDelegate.userId,
      await w.platformRole('nodelegate', [...ORG_ADMIN]),
      'platform',
      null,
    );
    people.cAdmin = await w.admin(c, 'rv-c-admin');
    people.cWm = await w.person('rv-c-wm');
    await w.grant(
      people.cWm.userId,
      c.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!,
      'organization',
      c.orgId,
    );
    people.reseller = await w.person('rv-reseller');
    await w.grant(
      people.reseller.userId,
      await w.seededPlatformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      w.resellerId,
    );
    // Coherent-grant actor: revoke across the organization through a custom
    // role, teams.create only inside one workspace (workspace_manager there).
    const [revoker] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: c.orgId,
        key: `revoker_${uuidv7().slice(-6)}`,
        name: 'Revoker',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    await w.attach(revoker!.id, [
      PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE,
      PERMISSIONS.ROLE_ASSIGNMENTS_READ,
      PERMISSIONS.USERS_READ,
    ]);
    people.coherent = await w.person('rv-coherent');
    await w.grant(people.coherent.userId, revoker!.id, 'organization', c.orgId);
    await w.grant(
      people.coherent.userId,
      c.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!,
      'workspace',
      c.workspaceId,
    );
    // Role-edit actor: may update roles, holds users.read but not audit.read.
    const [editor] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: c.orgId,
        key: `editor_${uuidv7().slice(-6)}`,
        name: 'Editor',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    await w.attach(editor!.id, [
      PERMISSIONS.ROLES_UPDATE,
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.USERS_READ,
      PERMISSIONS.WORKSPACES_READ,
    ]);
    people.editor = await w.person('rv-editor');
    await w.grant(people.editor.userId, editor!.id, 'organization', c.orgId);

    for (const [name, person] of Object.entries(people)) tokens[name] = await w.login(person.email);
  }, 240_000);

  afterAll(async () => {
    await w.teardown();
    await h.close();
  }, 120_000);

  // ===========================================================================
  describe('A. symmetric revocation (R1) — allowed', () => {
    it('an org_admin revokes a workspace_manager grant', async () => {
      const id = await grantOf(c, TENANT_ROLE_KEYS.WORKSPACE_MANAGER);
      expect((await w.revoke(tokens.cAdmin!, c.orgId, id)).status).toBe(204);
      expect((await w.revokedAudit(id))[0]!.metadata).toEqual({
        roleKey: TENANT_ROLE_KEYS.WORKSPACE_MANAGER,
        revokedFrom: expect.any(String),
      });
    });

    it('an org_admin revokes a peer org_admin, and itself, while others remain', async () => {
      const peer = await w.admin(c, 'rv-peer');
      expect((await w.revoke(tokens.cAdmin!, c.orgId, peer.grantId)).status).toBe(204);
      const self = await w.admin(c, 'rv-self');
      const token = await w.login(self.email);
      expect((await w.revoke(token, c.orgId, self.grantId)).status).toBe(204);
    });

    it('a workspace_manager revokes agent and campaign_editor grants (it holds their permissions)', async () => {
      for (const key of [TENANT_ROLE_KEYS.AGENT, TENANT_ROLE_KEYS.CAMPAIGN_EDITOR]) {
        const id = await grantOf(c, key);
        expect([key, (await w.revoke(tokens.cWm!, c.orgId, id)).status]).toEqual([key, 204]);
      }
    });

    it('a super admin revokes a content-free tenant grant, recorded without delegation', async () => {
      const id = await grantOf(c, TENANT_ROLE_KEYS.WORKSPACE_MANAGER);
      expect((await w.revoke(tokens.superAdmin!, c.orgId, id)).status).toBe(204);
      expect(Object.keys((await w.revokedAudit(id))[0]!.metadata).sort()).toEqual([
        'revokedFrom',
        'roleKey',
      ]);
    });
  });

  // ===========================================================================
  describe('B. symmetric revocation (R1) — refused, row untouched', () => {
    it('a workspace_manager at organization scope cannot revoke an org_admin', async () => {
      const target = await w.admin(c, 'rv-wm-target');
      const res = await w.revoke(tokens.cWm!, c.orgId, target.grantId);
      await expectRefused(res, target.grantId, minus(ORG_ADMIN, WORKSPACE_MANAGER));
    });

    it('a workspace_manager cannot revoke read_only: it does not hold audit.read (symmetric with granting)', async () => {
      const id = await grantOf(c, TENANT_ROLE_KEYS.READ_ONLY);
      await expectRefused(await w.revoke(tokens.cWm!, c.orgId, id), id, [PERMISSIONS.AUDIT_READ]);
    });

    it('a reseller_admin cannot revoke an org_admin of its organization', async () => {
      const target = await w.admin(c, 'rv-rs-target');
      const res = await w.revoke(tokens.reseller!, c.orgId, target.grantId);
      await expectRefused(res, target.grantId, minus(ORG_ADMIN, RESELLER_ADMIN));
    });

    it('an API key holding only role_assignments.revoke cannot revoke an org_admin', async () => {
      const target = await w.admin(c, 'rv-key-target');
      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      const secret = uuidv7();
      await h.admin.insert(schema.apiKeys).values({
        orgId: c.orgId,
        name: 'revoke-only',
        keyPrefix: prefix,
        keyHash: await h.app.get(CredentialService).hash(secret),
        createdBy: people.cAdmin!.userId,
        scopes: [PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE],
      });
      const res = await w.revoke(`${prefix}.${secret}`, c.orgId, target.grantId);
      await expectRefused(
        res,
        target.grantId,
        minus(ORG_ADMIN, [PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE]),
      );
    });

    it('coherent grant: revoke across the organization, teams.create only in one workspace — cannot revoke an organization-scope workspace_manager', async () => {
      const id = await grantOf(c, TENANT_ROLE_KEYS.WORKSPACE_MANAGER);
      const res = await w.revoke(tokens.coherent!, c.orgId, id);
      const held = [
        PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE,
        PERMISSIONS.ROLE_ASSIGNMENTS_READ,
        PERMISSIONS.USERS_READ,
      ];
      await expectRefused(res, id, minus(WORKSPACE_MANAGER, held));
      expect(res.body.error.details.rejected).toContain(PERMISSIONS.TEAMS_CREATE);
    });
  });

  // ===========================================================================
  describe('C. delegated revocation (R-6, revoke side)', () => {
    it('super admin revokes an org_admin carrying content keys it does not hold: 204, audited as delegation', async () => {
      const target = await w.admin(t, 'rv-dlg-target');
      expect((await w.revoke(tokens.superAdmin!, t.orgId, target.grantId)).status).toBe(204);
      expect(await w.revokedAudit(target.grantId)).toEqual([
        {
          actor_user_id: people.superAdmin!.userId,
          metadata: {
            roleKey: TENANT_ROLE_KEYS.ORG_ADMIN,
            revokedFrom: target.userId,
            delegation: true,
            delegatedPermissions: FIXTURE_CONTENT,
          },
        },
      ]);
    });

    it('any platform principal holding delegate_tenant and every non-content key qualifies', async () => {
      const target = await w.admin(t, 'rv-dlg-target2');
      expect((await w.revoke(tokens.delegator!, t.orgId, target.grantId)).status).toBe(204);
      expect((await w.revokedAudit(target.grantId))[0]!.metadata).toMatchObject({
        delegation: true,
        delegatedPermissions: FIXTURE_CONTENT,
      });
    });

    it('refused: an actor without delegate_tenant', async () => {
      const target = await w.admin(t, 'rv-n-nodelegate');
      const res = await w.revoke(tokens.noDelegate!, t.orgId, target.grantId);
      await expectRefused(res, target.grantId, FIXTURE_CONTENT);
    });

    it('refused: platform.tenants.manage does not stand in for delegate_tenant', async () => {
      const target = await w.admin(t, 'rv-n-tm');
      const res = await w.revoke(tokens.tenantsManager!, t.orgId, target.grantId);
      await expectRefused(res, target.grantId, FIXTURE_CONTENT);
    });

    it('refused: a custom role carrying a content key', async () => {
      const person = await w.person('rv-n-custom');
      const id = await w.grant(person.userId, customContentRole, 'organization', t.orgId);
      await expectRefused(await w.revoke(tokens.superAdmin!, t.orgId, id), id, ['contacts.read']);
    });

    it('refused: a NON-system role keyed org_admin carrying a content key', async () => {
      const person = await w.person('rv-n-lookalike');
      const id = await w.grant(person.userId, v.roleId, 'organization', v.orgId);
      await expectRefused(await w.revoke(tokens.superAdmin!, v.orgId, id), id, ['contacts.read']);
    });

    it('refused: a system role outside the delegable set (workspace_manager carrying a content key)', async () => {
      const id = await grantOf(t, TENANT_ROLE_KEYS.WORKSPACE_MANAGER);
      await expectRefused(await w.revoke(tokens.superAdmin!, t.orgId, id), id, ['contacts.read']);
    });

    it('a stored grant cannot pair one organization’s org_admin with another organization’s scope (the ownership condition is structural on revoke)', async () => {
      const person = await w.person('rv-n-cross');
      await expect(
        w.grant(person.userId, t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, 'organization', c.orgId),
      ).rejects.toBeDefined();
    });

    it('refused: a grant at workspace scope (org_admin widened by fixture to admit it)', async () => {
      const id = await grantOf(t2, TENANT_ROLE_KEYS.ORG_ADMIN, 'workspace');
      await expectRefused(await w.revoke(tokens.superAdmin!, t2.orgId, id), id, ['contacts.read']);
    });

    it('revoking one’s own org_admin grant is never a delegation: the actor holds the role through that grant (condition 6 is the grant side’s)', async () => {
      // The grant being revoked confers its own permissions — content keys
      // included — at its scope, so the ordinary rule already admits the
      // holder; the delegation constraints are never consulted. Revoking
      // oneself by delegation is therefore unreachable on this path, and the
      // self condition is exercised where it can decide: the grant side
      // (`role-assignment-delegation.sec-spec.ts`, "delegating to oneself").
      const id = await w.grant(
        people.superAdmin!.userId,
        t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
        'organization',
        t.orgId,
      );
      expect((await w.revoke(tokens.superAdmin!, t.orgId, id)).status).toBe(204);
      expect((await w.revokedAudit(id))[0]!.metadata).toEqual({
        roleKey: TENANT_ROLE_KEYS.ORG_ADMIN,
        revokedFrom: people.superAdmin!.userId,
      });
    });

    it('refused: an actor lacking a NON-content permission of org_admin', async () => {
      const target = await w.admin(t, 'rv-n-nodisable');
      const res = await w.revoke(tokens.noDisable!, t.orgId, target.grantId);
      await expectRefused(res, target.grantId, [PERMISSIONS.USERS_DISABLE, ...FIXTURE_CONTENT]);
    });
  });

  // ===========================================================================
  describe('D. role edits check removed permissions (R2)', () => {
    let roleId: string;
    beforeEach(async () => {
      const [role] = await h.admin
        .insert(schema.roles)
        .values({
          orgId: c.orgId,
          key: `edited_${uuidv7().slice(-8)}`,
          name: 'Edited',
          isSystemRole: false,
          allowedScopeTypes: ['organization'],
        })
        .returning({ id: schema.roles.id });
      roleId = role!.id;
      await w.attach(roleId, [PERMISSIONS.USERS_READ, PERMISSIONS.AUDIT_READ]);
    });

    const patch = (permissions: string[]) =>
      request(h.app.getHttpServer())
        .patch(url(`/roles/${roleId}`))
        .set('authorization', `Bearer ${tokens.editor!}`)
        .set('x-acc-organization', c.orgId)
        .send({ permissions });

    const carried = async () =>
      (
        await h.admin
          .select({ key: schema.permissions.key })
          .from(schema.rolePermissions)
          .innerJoin(
            schema.permissions,
            eq(schema.permissions.id, schema.rolePermissions.permissionId),
          )
          .where(eq(schema.rolePermissions.roleId, roleId))
      )
        .map((r) => r.key)
        .sort();

    it('removing a permission the actor does not hold is 403, and the role is unchanged', async () => {
      const res = await patch([PERMISSIONS.USERS_READ]);
      expect([res.status, res.body.error?.code, res.body.error?.details]).toEqual([
        403,
        ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
        { rejected: [PERMISSIONS.AUDIT_READ] },
      ]);
      expect(await carried()).toEqual([PERMISSIONS.AUDIT_READ, PERMISSIONS.USERS_READ]);
    });

    it('removing a permission the actor holds is allowed', async () => {
      await w.detach(roleId, [PERMISSIONS.AUDIT_READ]);
      await w.attach(roleId, [PERMISSIONS.WORKSPACES_READ]);
      const res = await patch([PERMISSIONS.USERS_READ]);
      expect(res.status).toBe(200);
      expect(await carried()).toEqual([PERMISSIONS.USERS_READ]);
    });
  });

  // ===========================================================================
  describe('E. the role is locked FOR SHARE before a revocation reads its permissions', () => {
    it('an edit of the role in flight is waited for, and the revocation is judged on the committed set', async () => {
      const roleId = c.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!;
      const id = await grantOf(c, TENANT_ROLE_KEYS.WORKSPACE_MANAGER);
      const [contacts] = await w.permissionIds(['contacts.read']);
      const owner = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 2 });
      const holder = await owner.connect();
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT set_config('app.provisioning', 'on', true)");
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]
          .pid as number;
        await holder.query('UPDATE roles SET updated_at = now() WHERE id = $1', [roleId]);

        let settled = false;
        const pending = w.revoke(tokens.cAdmin!, c.orgId, id).then((r) => {
          settled = true;
          return r;
        });

        // A revocation that does not wait for the edit settles first: the loop
        // ends and the assertions below fail, rather than the test timing out.
        let waited = false;
        const deadline = Date.now() + 8_000;
        while (!waited && !settled && Date.now() < deadline) {
          const { rows } = await owner.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))',
            [holderPid],
          );
          waited = rows[0]!.n > 0;
          if (!waited) await new Promise((r) => setTimeout(r, 25));
        }
        await holder.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)',
          [roleId, contacts],
        );
        await holder.query('COMMIT');

        const res = await pending;
        expect(waited).toBe(true);
        // Judged on the committed set: the org_admin does not hold the content
        // key it would now be removing.
        await expectRefused(res, id, ['contacts.read']);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await w.detach(roleId, ['contacts.read']);
        await owner.end();
      }
    }, 30_000);
  });
});
