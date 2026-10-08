/**
 * Shared fixtures for the ADR-015 R-11 suites (`role-revocation.sec-spec.ts`,
 * `organization-admin-liveness.sec-spec.ts`).
 *
 * Organizations are provisioned exactly as production provisions them —
 * `TenantRoleProvisioner.seedTenantRoles` — so every role here is the real
 * seeded role with its real permission set, never the harness's stand-in.
 * A role that carries a tenant-content key is a **disposable-test fixture**
 * (ADR-015 follow-up decision 6): the owner attaches the key on this clone;
 * `TENANT_ROLE_DEFINITIONS` is never changed.
 *
 * Teardown deletes each organization, so its organization-scope grants, roles
 * and role permissions cascade with it — the one exemption of the
 * last-organization-administrator rule (migration `0028`). Nothing here
 * disables that rule's triggers.
 */
import { AUDIT_ACTIONS, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, type Harness } from './auth-harness';

export interface Org {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly roles: Record<string, string>;
}

export interface Person {
  readonly userId: string;
  readonly email: string;
}

export const url = (p: string) => `/${PREFIX}${p}`;
export const suffix = () => uuidv7().replace(/-/g, '').slice(-10);

export class RevocationWorld {
  readonly createdUsers: string[] = [];
  readonly createdOrgs: string[] = [];
  readonly createdPlatformRoles: string[] = [];
  private credentials: CredentialService;
  private hash: string | null = null;
  resellerId = '';

  constructor(readonly h: Harness) {
    this.credentials = h.app.get(CredentialService);
  }

  async init(label: string): Promise<void> {
    const [r] = await this.h.admin
      .insert(schema.resellers)
      .values({ name: `R11 ${label}`, slug: `r11-${label}-${suffix()}` })
      .returning({ id: schema.resellers.id });
    this.resellerId = r!.id;
  }

  async person(label: string, status: 'active' | 'invited' = 'active'): Promise<Person> {
    this.hash ??= await this.credentials.hash(PASSWORD);
    const email = `${label}-${suffix()}@example.test`;
    const [row] = await this.h.admin
      .insert(schema.users)
      .values(
        status === 'active'
          ? { email, status, passwordHash: this.hash, passwordUpdatedAt: new Date() }
          : { email, status },
      )
      .returning({ id: schema.users.id });
    this.createdUsers.push(row!.id);
    return { userId: row!.id, email };
  }

  /** An owner-planted grant (the platform-admin flag admits platform roles). */
  async grant(
    userId: string,
    roleId: string,
    scopeType: 'platform' | 'reseller' | 'organization' | 'workspace',
    scopeId: string | null,
  ): Promise<string> {
    return this.h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [row] = await tx
        .insert(schema.userRoles)
        .values({ userId, roleId, scopeType, scopeId })
        .returning({ id: schema.userRoles.id });
      return row!.id;
    });
  }

  async permissionIds(keys: readonly string[]): Promise<string[]> {
    const rows = await this.h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(inArray(schema.permissions.key, [...keys]));
    if (rows.length !== keys.length) throw new Error(`unknown permission in ${keys.join(',')}`);
    return rows.map((r) => r.id);
  }

  /** Owner-only fixture write to a (possibly system) role's permission set. */
  async attach(roleId: string, keys: readonly string[]): Promise<void> {
    const ids = await this.permissionIds(keys);
    await this.h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const permissionId of ids) {
        await tx.insert(schema.rolePermissions).values({ roleId, permissionId });
      }
    });
  }

  async detach(roleId: string, keys: readonly string[]): Promise<void> {
    const ids = await this.permissionIds(keys);
    await this.h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx
        .delete(schema.rolePermissions)
        .where(
          and(
            eq(schema.rolePermissions.roleId, roleId),
            inArray(schema.rolePermissions.permissionId, ids),
          ),
        );
    });
  }

  /** A provisioned organization: the five seeded tenant roles and a default workspace. */
  async org(label: string): Promise<Org> {
    const [org] = await this.h.admin
      .insert(schema.organizations)
      .values({
        name: `R11 ${label}`,
        slug: `r11-${label}-${suffix()}`,
        resellerId: this.resellerId,
      })
      .returning({ id: schema.organizations.id });
    this.createdOrgs.push(org!.id);
    const [ws] = await this.h.admin
      .insert(schema.workspaces)
      .values({ orgId: org!.id, name: 'Default', slug: 'default', isDefault: true })
      .returning({ id: schema.workspaces.id });
    const provisioner = this.h.app.get(TenantRoleProvisioner);
    await this.h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, org!.id, {
        correlationId: uuidv7(),
      });
    });
    const rows = await this.h.admin
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, org!.id));
    return {
      orgId: org!.id,
      workspaceId: ws!.id,
      roles: Object.fromEntries(rows.map((r) => [r.key, r.id])),
    };
  }

  /** A fresh active user holding the organization's real `org_admin`. */
  async admin(org: Org, label: string): Promise<Person & { grantId: string }> {
    const person = await this.person(label);
    const grantId = await this.grant(
      person.userId,
      org.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
      'organization',
      org.orgId,
    );
    return { ...person, grantId };
  }

  /** A custom platform role at {platform} carrying exactly `keys`. */
  async platformRole(label: string, keys: readonly string[]): Promise<string> {
    const ids = await this.permissionIds(keys);
    return this.h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: null,
          key: `r11_${label}_${suffix()}`,
          name: `R11 test ${label}`,
          isSystemRole: false,
          allowedScopeTypes: ['platform'],
        })
        .returning({ id: schema.roles.id });
      this.createdPlatformRoles.push(role!.id);
      for (const permissionId of ids) {
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId });
      }
      return role!.id;
    });
  }

  async seededPlatformRole(key: string): Promise<string> {
    const [r] = await this.h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return r!.id;
  }

  async superAdmin(label: string): Promise<Person> {
    const person = await this.person(label);
    await this.grant(
      person.userId,
      await this.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    return person;
  }

  async login(email: string): Promise<string> {
    await this.h.clearRateLimits();
    const res = await request(this.h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  revoke(token: string, org: string, id: string) {
    return request(this.h.app.getHttpServer())
      .delete(url(`/role-assignments/${id}`))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', org);
  }

  disable(token: string, org: string, userId: string) {
    return request(this.h.app.getHttpServer())
      .post(url(`/users/${userId}/disable`))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', org);
  }

  async grantExists(id: string): Promise<boolean> {
    const rows = await this.h.admin
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.id, id));
    return rows.length === 1;
  }

  async revokedAudit(resourceId: string) {
    return (
      await this.h.admin.execute<{ metadata: Record<string, unknown>; actor_user_id: string }>(
        sql`SELECT metadata, actor_user_id FROM audit_logs
            WHERE action = ${AUDIT_ACTIONS.USER_ROLE_REVOKED} AND resource_id = ${resourceId}`,
      )
    ).rows;
  }

  /** The invariant's own count (migration `0028`). */
  async admins(orgId: string): Promise<number> {
    const { rows } = await this.h.admin.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM user_roles ur
        JOIN users u ON u.id = ur.user_id
        JOIN roles r ON r.id = ur.role_id
       WHERE ur.scope_type = 'organization' AND ur.scope_id = ${orgId}
         AND r.org_id = ${orgId} AND r.key = 'org_admin' AND r.is_system_role
         AND u.status = 'active'`);
    return Number(rows[0]!.n);
  }

  /** Deletes one organization through its cascade (the rule's exemption). */
  async deleteOrg(orgId: string): Promise<void> {
    await purgeAudit(
      this.h.admin,
      sql`org_id = ${orgId} OR actor_api_key_id IN (SELECT id FROM api_keys WHERE org_id = ${orgId})`,
    );
    await this.h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`DELETE FROM user_roles WHERE org_id = ${orgId} AND scope_type <> 'organization'`,
      );
      for (const table of ['api_keys', 'idempotency_keys', 'teams', 'workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${orgId}`);
      }
      await tx.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
    });
  }

  async teardown(): Promise<void> {
    await this.h.clearRateLimits();
    const list = (ids: readonly string[]) =>
      sql.join(
        (ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']).map((id) => sql`${id}`),
        sql`, `,
      );
    await purgeAudit(
      this.h.admin,
      sql`org_id IN (${list(this.createdOrgs)}) OR actor_user_id IN (${list(this.createdUsers)})
          OR reseller_id = ${this.resellerId}`,
    );
    for (const orgId of this.createdOrgs) {
      const [exists] = await this.h.admin
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      if (exists) await this.deleteOrg(orgId);
    }
    // What remains are platform and reseller grants of this suite's users. The
    // platform liveness trigger is disabled for the statement, as every suite
    // that plants a platform administrator does (`removeIdentities`).
    await this.h.admin.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(sql`DELETE FROM user_roles WHERE user_id IN (${list(this.createdUsers)})`);
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      await tx.execute(
        sql`DELETE FROM role_permissions WHERE role_id IN (${list(this.createdPlatformRoles)})`,
      );
      await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(this.createdPlatformRoles)})`);
    });
    await this.h.admin.execute(
      sql`DELETE FROM sessions WHERE user_id IN (${list(this.createdUsers)})`,
    );
    await this.h.admin.execute(
      sql`DELETE FROM api_keys WHERE created_by IN (${list(this.createdUsers)})`,
    );
    await this.h.admin.delete(schema.users).where(inArray(schema.users.id, this.createdUsers));
    await this.h.admin.execute(sql`DELETE FROM resellers WHERE id = ${this.resellerId}`);
  }
}
