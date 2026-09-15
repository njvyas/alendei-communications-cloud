import { Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, TENANT_ROLE_DEFINITIONS, type RoleDefinition } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AuditWriter } from '../audit/audit-writer.service';

/** What one provisioning run did, so a caller can report it without re-reading. */
export interface TenantRoleProvisionResult {
  /** Roles this run actually created. Empty on a repeat run. */
  readonly created: readonly string[];
  /** Roles that already existed and were left exactly as they were. */
  readonly existing: readonly string[];
}

/**
 * Seeds an organization's canonical tenant roles (`RBAC.md` §4, Phase 1B.5.4).
 *
 * `TENANT_ROLE_DEFINITIONS` has been defined since Phase 1 and seeded nowhere —
 * `seed.ts` deliberately covers only the platform roles, because tenant roles
 * belong to an organization that does not exist at seed time. This is the
 * sanctioned mechanism that closes that gap.
 *
 * **It does not create organizations, and it is not a provisioning lifecycle.**
 * It takes an organization that already exists and gives it the roles it should
 * have had from the moment it was created. Wiring it into organization creation
 * is Phase 1B.8's, because that is the phase that introduces organization
 * creation at all; until then this is called by the bootstrap paths and by its
 * own tests.
 *
 * Three properties carry the weight:
 *
 * 1. **Transaction-bound.** Everything runs inside the caller's `tx`. There is
 *    no transaction of its own and no partial commit: if the caller rolls back —
 *    for any reason, including a failure of its own after this returns — the
 *    whole seeding disappears with it. That is what makes an organization
 *    creation that fails half-way leave no half-seeded tenant behind.
 *
 * 2. **Idempotent, and honestly so.** A repeat run creates nothing and reports
 *    nothing created. It does *not* reconcile an existing role back to the
 *    definition: these roles are tenant-editable by design (`RBAC.md` §4), so
 *    overwriting an organization's deliberate edit would be data loss disguised
 *    as idempotency. Existing roles are left exactly as they are.
 *
 * 3. **`role.created` is emitted only for a role actually created.** A retry
 *    writes no audit rows at all. An audit trail that gains a `role.created`
 *    every time provisioning is retried would report creations that never
 *    happened, which is worse than a missing record because it cannot be
 *    distinguished from a real one.
 */
@Injectable()
export class TenantRoleProvisioner {
  constructor(private readonly audit: AuditWriter) {}

  /**
   * Seeds `TENANT_ROLE_DEFINITIONS` for one organization.
   *
   * @param tx the caller's open transaction. Its tenant context must already
   *   cover `orgId`, and must carry `provisioning` — these roles are system
   *   roles, and migration `0004`'s trigger admits their composition only under
   *   `app_is_provisioning()` or `app_is_platform_admin()`. The provisioning
   *   flag is used rather than platform-admin precisely so a tenant transaction
   *   never has to claim platform-admin, which would widen RLS for everything
   *   else running in it.
   */
  async seedTenantRoles(
    tx: Transaction,
    orgId: string,
    options: { readonly correlationId?: string } = {},
  ): Promise<TenantRoleProvisionResult> {
    // One read of what is already there, rather than a probe per definition:
    // the decision this makes is "which of these keys is missing", and asking
    // that once keeps the answer consistent across the whole run.
    const definedKeys = TENANT_ROLE_DEFINITIONS.map((definition) => definition.key);
    const present = await tx
      .select({ key: schema.roles.key })
      .from(schema.roles)
      .where(and(eq(schema.roles.orgId, orgId), inArray(schema.roles.key, definedKeys)));
    const presentKeys = new Set(present.map((row) => row.key));

    const created: string[] = [];
    for (const definition of TENANT_ROLE_DEFINITIONS) {
      if (presentKeys.has(definition.key)) continue;
      await this.createRole(tx, orgId, definition, options.correlationId);
      created.push(definition.key);
    }

    return {
      created,
      existing: definedKeys.filter((key) => presentKeys.has(key)),
    };
  }

  private async createRole(
    tx: Transaction,
    orgId: string,
    definition: RoleDefinition,
    correlationId?: string,
  ): Promise<void> {
    const [role] = await tx
      .insert(schema.roles)
      .values({
        orgId,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        // Seeded roles are system roles: their *definition* is the platform's,
        // even though their permission composition is tenant-editable through
        // the role administration surface.
        isSystemRole: true,
        allowedScopeTypes: [...definition.allowedScopeTypes],
      })
      // A concurrent provisioning run for the same organization must not produce
      // two copies of one role. The partial unique index on (org_id, key) is
      // what decides the race; the loser inserts nothing and — because
      // `created` is driven by the returned row — records nothing either.
      .onConflictDoNothing()
      .returning({ id: schema.roles.id });

    if (!role) return;

    for (const permissionKey of definition.permissions) {
      const [permission] = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, permissionKey));

      if (!permission) {
        // The catalogue is seeded before any organization can exist, so a
        // missing permission means the catalogue and the definitions have
        // drifted. Failing loudly rolls the caller's transaction back rather
        // than quietly provisioning a role with a hole in it.
        throw new Error(
          `tenant role provisioning: permission ${permissionKey} is missing from the catalogue`,
        );
      }

      await tx
        .insert(schema.rolePermissions)
        .values({ roleId: role.id, permissionId: permission.id })
        .onConflictDoNothing();
    }

    // In the caller's transaction, so the record and the role share a fate
    // (`SECURITY.md` §4): a rolled-back provisioning leaves no claim that a role
    // was created, and an audit failure takes the role with it.
    await this.audit.record(
      {
        // Supplied explicitly when provisioning runs outside a request (a CLI,
        // a job): `AuditWriter` refuses a row it cannot tie to a correlation id
        // rather than inventing one, and provisioning must not be the caller
        // that discovers that at runtime.
        ...(correlationId ? { correlationId } : {}),
        scopeType: 'organization',
        scopeId: orgId,
        actorType: 'system',
        actorUserId: null,
        actorApiKeyId: null,
        actorLabel: 'tenant_role_provisioning',
        action: AUDIT_ACTIONS.ROLE_CREATED,
        resourceType: 'Role',
        resourceId: role.id,
        outcome: 'success',
        before: null,
        after: { key: definition.key, isSystemRole: true },
        metadata: {
          roleKey: definition.key,
          permissionCount: definition.permissions.length,
          provisioned: true,
        },
      },
      tx,
    );
  }

  /**
   * The roles an organization is missing, without writing anything.
   *
   * Exists so a caller — a health check, or Phase 1B.8's provisioning path
   * deciding whether it has work to do — can ask the question without a
   * transaction that might write.
   */
  async missingRoles(tx: Transaction, orgId: string): Promise<readonly string[]> {
    const definedKeys = TENANT_ROLE_DEFINITIONS.map((definition) => definition.key);
    const present = await tx
      .select({ key: schema.roles.key })
      .from(schema.roles)
      .where(and(eq(schema.roles.orgId, orgId), inArray(schema.roles.key, definedKeys)));
    const presentKeys = new Set(present.map((row) => row.key));
    return definedKeys.filter((key) => !presentKeys.has(key));
  }
}
