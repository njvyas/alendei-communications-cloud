import { HttpStatus, Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, ERROR_CODES, type AuthPrincipal, type ScopeType } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';

export interface RoleView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly orgId: string | null;
  readonly isSystemRole: boolean;
  readonly allowedScopeTypes: readonly ScopeType[];
  readonly permissions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRoleInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
  readonly allowedScopeTypes: readonly ScopeType[];
  readonly permissions: readonly string[];
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly allowedScopeTypes?: readonly ScopeType[];
  readonly permissions?: readonly string[];
}

/**
 * Role administration (Phase 1B.5.4, `RBAC.md` §§7-8, `API.md` §3c).
 *
 * Every method authorizes through `AuthorizationService` against the caller's
 * own organization as the target scope, inside the caller's tenant transaction —
 * so the chain is read under the same `SET LOCAL` context the mutation runs in
 * and RLS filters it (ADR-005 D-5). Nothing here reimplements coverage or reads
 * `principal.permissions` as an authorization decision.
 *
 * Four guards beyond the permission check, each here because the permission
 * alone does not express it:
 *
 * 1. **A tenant never touches a system role.** `roles.update` is authority to
 *    compose roles within an organization, not to rewrite what `org_admin`
 *    means. Refused in the service for a clear `403`, and refused again by
 *    migration `0004`'s trigger for anyone who reaches the table another way.
 *
 * 2. **Composition cannot exceed the actor's own authority.** A role may only
 *    be given permissions the actor itself holds at the role's organization.
 *    Without this, `roles.create` would be a universal escalation primitive:
 *    compose a role carrying anything, then have it granted. The check runs
 *    through `AuthorizationService.allows`, so it asks the same coherent-grant
 *    question every other decision asks (`RBAC.md` §7, row 1).
 *
 * 3. **A platform permission never lands on a tenant role.** Enforced by
 *    `fn_validate_role_permission` since migration `0000`; refused here first so
 *    the caller gets a `403` rather than a constraint error.
 *
 * 4. **Deletion is refused while grants exist.** `409`, so every revocation
 *    stays an explicit audited act. `ON DELETE RESTRICT` (migration `0004`)
 *    makes it true with the service bypassed (ADR-005 D-8).
 *
 * **Not here:** grant administration, and any enforcement of
 * `allowedScopeTypes` at grant time. This phase gives the column its value;
 * Phase 1B.5.5 is what consults it (`RBAC.md` §7, `ROADMAP.md` 1B.5.5).
 */
@Injectable()
export class RoleAdministrationService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Roles visible to the caller: its organization's own, plus the platform
   * definitions, which every tenant may read but none may modify.
   *
   * Deliberately unpaginated, matching the conventions that exist today
   * (`API.md`). A tenant's role list is small and bounded by its own
   * composition. Normalizing this onto the list conventions is Phase 1B.5.8's,
   * recorded there rather than pre-empted here.
   */
  async list(tx: Transaction, principal: AuthPrincipal): Promise<readonly RoleView[]> {
    const orgId = this.requireOrg(principal);
    await this.assertPermission(tx, principal, 'roles.read', orgId);

    const rows = await tx
      .select()
      .from(schema.roles)
      .where(or(eq(schema.roles.orgId, orgId), isNull(schema.roles.orgId)))
      .orderBy(asc(schema.roles.key));

    return this.withPermissions(tx, rows);
  }

  async get(tx: Transaction, principal: AuthPrincipal, roleId: string): Promise<RoleView> {
    const orgId = this.requireOrg(principal);
    await this.assertPermission(tx, principal, 'roles.read', orgId);

    const role = await this.loadVisible(tx, orgId, roleId);
    const [view] = await this.withPermissions(tx, [role]);
    return view!;
  }

  async create(
    tx: Transaction,
    principal: AuthPrincipal,
    input: CreateRoleInput,
  ): Promise<RoleView> {
    const orgId = this.requireOrg(principal);
    await this.assertPermission(tx, principal, 'roles.create', orgId);
    this.assertTenantScopeTypes(input.allowedScopeTypes);
    await this.assertComposable(tx, principal, orgId, input.permissions);

    const existing = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.key, input.key)));
    if (existing.length > 0) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.RESOURCE_CONFLICT,
        message: 'A role with that key already exists in this organization',
      });
    }

    const [created] = await tx
      .insert(schema.roles)
      .values({
        orgId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        // A role created through the API is never a system role. Migration
        // `0004`'s trigger refuses the promotion independently.
        isSystemRole: false,
        allowedScopeTypes: [...input.allowedScopeTypes],
      })
      .returning();

    await this.replacePermissions(tx, created!.id, input.permissions);

    await this.record(tx, principal, orgId, AUDIT_ACTIONS.ROLE_CREATED, created!.id, {
      before: null,
      after: {
        key: created!.key,
        name: created!.name,
        allowedScopeTypes: input.allowedScopeTypes,
        permissions: input.permissions,
      },
    });

    const [view] = await this.withPermissions(tx, [created!]);
    return view!;
  }

  async update(
    tx: Transaction,
    principal: AuthPrincipal,
    roleId: string,
    input: UpdateRoleInput,
  ): Promise<RoleView> {
    const orgId = this.requireOrg(principal);
    await this.assertPermission(tx, principal, 'roles.update', orgId);

    const role = await this.loadVisible(tx, orgId, roleId);
    this.assertMutable(role);
    if (input.allowedScopeTypes) this.assertTenantScopeTypes(input.allowedScopeTypes);
    if (input.permissions) {
      await this.assertComposable(tx, principal, orgId, input.permissions);
    }

    const [before] = await this.withPermissions(tx, [role]);

    const [updated] = await tx
      .update(schema.roles)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.allowedScopeTypes ? { allowedScopeTypes: [...input.allowedScopeTypes] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.roles.id, roleId))
      .returning();

    if (input.permissions) {
      await this.replacePermissions(tx, roleId, input.permissions);
    }

    const [after] = await this.withPermissions(tx, [updated!]);

    await this.record(tx, principal, orgId, AUDIT_ACTIONS.ROLE_UPDATED, roleId, {
      before: { name: before!.name, permissions: before!.permissions },
      after: { name: after!.name, permissions: after!.permissions },
    });

    return after!;
  }

  async remove(tx: Transaction, principal: AuthPrincipal, roleId: string): Promise<void> {
    const orgId = this.requireOrg(principal);
    await this.assertPermission(tx, principal, 'roles.delete', orgId);

    const role = await this.loadVisible(tx, orgId, roleId);
    this.assertMutable(role);

    // Checked here so the caller gets a `409` naming the reason rather than a
    // foreign-key error. `ON DELETE RESTRICT` is what makes it true regardless
    // (ADR-005 D-8) — this check is the message, not the control.
    const grants = await tx
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.roleId, roleId))
      .limit(1);
    if (grants.length > 0) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.RESOURCE_CONFLICT,
        message: 'This role is still granted to at least one user; revoke those grants first',
      });
    }

    const [before] = await this.withPermissions(tx, [role]);

    await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
    await tx.delete(schema.roles).where(eq(schema.roles.id, roleId));

    await this.record(tx, principal, orgId, AUDIT_ACTIONS.ROLE_DELETED, roleId, {
      before: { key: before!.key, name: before!.name, permissions: before!.permissions },
      after: null,
    });
  }

  /** The system-defined permission catalogue. Global, read-only, not tenant data. */
  async listPermissions(
    tx: Transaction,
    principal: AuthPrincipal,
  ): Promise<
    readonly { key: string; domain: string; action: string; description: string | null }[]
  > {
    const orgId = this.requireOrg(principal);
    await this.assertPermission(tx, principal, 'permissions.read', orgId);

    return tx
      .select({
        key: schema.permissions.key,
        domain: schema.permissions.domain,
        action: schema.permissions.action,
        description: schema.permissions.description,
      })
      .from(schema.permissions)
      .orderBy(asc(schema.permissions.key));
  }

  // --- guards ---------------------------------------------------------------

  private requireOrg(principal: AuthPrincipal): string {
    const orgId = principal.tenant.orgId;
    if (!orgId) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }
    return orgId;
  }

  /**
   * The one authorization call. Target is the organization the role lives in, so
   * the chain is resolved from the database and a grant at workspace or team
   * level does not reach it.
   */
  private async assertPermission(
    tx: Transaction,
    principal: AuthPrincipal,
    permission: string,
    orgId: string,
  ): Promise<void> {
    await this.authorization.assert(tx, {
      principal,
      permission,
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'Role',
    });
  }

  private assertMutable(role: typeof schema.roles.$inferSelect): void {
    if (role.orgId === null || role.isSystemRole) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        message: 'System-defined roles cannot be modified or deleted',
        logContext: { roleKey: role.key, isSystemRole: role.isSystemRole },
      });
    }
  }

  /** A tenant role exists at tenant levels; platform and reseller are not its to claim. */
  private assertTenantScopeTypes(scopeTypes: readonly ScopeType[]): void {
    if (scopeTypes.length === 0) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'A role must admit at least one scope type',
      });
    }
    const allowed: readonly ScopeType[] = ['organization', 'workspace', 'team'];
    const rejected = scopeTypes.filter((scopeType) => !allowed.includes(scopeType));
    if (rejected.length > 0) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'A tenant role may only admit organization, workspace or team scope',
        details: { rejected },
      });
    }
  }

  /**
   * Every permission asked for must be one the actor itself holds at this
   * organization (`RBAC.md` §7, row 1).
   *
   * Asked one permission at a time through the authorization boundary rather
   * than against `principal.permissions`: the flattened list is exactly the
   * artefact ADR-005 removed from the decision path, and a check written against
   * it would let a permission held only at a narrower scope authorize
   * composition at the organization.
   */
  private async assertComposable(
    tx: Transaction,
    principal: AuthPrincipal,
    orgId: string,
    permissions: readonly string[],
  ): Promise<void> {
    // The same test `fn_validate_role_permission` applies at the database
    // (migration `0000`): the `platform.` domain is what makes a permission
    // platform-only, so a new one added to the catalogue is covered without this
    // list being revisited.
    const platform = permissions.filter((permission) => permission.startsWith('platform.'));
    if (platform.length > 0) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
        message: 'Platform permissions cannot be attached to a tenant role',
        details: { rejected: platform },
      });
    }

    const unheld: string[] = [];
    for (const permission of new Set(permissions)) {
      const held = await this.authorization.allows(tx, {
        principal,
        permission,
        target: { scopeType: 'organization', scopeId: orgId },
      });
      if (!held) unheld.push(permission);
    }

    if (unheld.length > 0) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
        message: 'A role cannot carry a permission you do not hold at this organization',
        // The rejected keys are the caller's own input, so echoing them
        // discloses nothing it did not send.
        details: { rejected: unheld },
      });
    }
  }

  // --- reads ----------------------------------------------------------------

  /**
   * A role the caller may see: its own organization's, or a platform
   * definition. Anything else is `404` — RLS has already filtered it, and the
   * response must not confirm that a role exists in another tenant.
   */
  private async loadVisible(
    tx: Transaction,
    orgId: string,
    roleId: string,
  ): Promise<typeof schema.roles.$inferSelect> {
    const [role] = await tx
      .select()
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.id, roleId),
          or(eq(schema.roles.orgId, orgId), isNull(schema.roles.orgId)),
        ),
      );

    if (!role) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Role not found',
        logContext: { requestedRoleId: roleId },
      });
    }
    return role;
  }

  private async withPermissions(
    tx: Transaction,
    roles: readonly (typeof schema.roles.$inferSelect)[],
  ): Promise<readonly RoleView[]> {
    if (roles.length === 0) return [];

    const rows = await tx
      .select({ roleId: schema.rolePermissions.roleId, key: schema.permissions.key })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(
        inArray(
          schema.rolePermissions.roleId,
          roles.map((role) => role.id),
        ),
      );

    const byRole = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = byRole.get(row.roleId);
      if (bucket) bucket.push(row.key);
      else byRole.set(row.roleId, [row.key]);
    }

    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      orgId: role.orgId,
      isSystemRole: role.isSystemRole,
      allowedScopeTypes: role.allowedScopeTypes as readonly ScopeType[],
      permissions: (byRole.get(role.id) ?? []).sort(),
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString(),
    }));
  }

  // --- writes ---------------------------------------------------------------

  /**
   * Rebuilds a role's permission set.
   *
   * Replace rather than diff: a removed permission must actually disappear, and
   * §6n case 17 turns on that — the next request re-derives authorization from
   * current state, so a permission left behind here stays effective.
   */
  private async replacePermissions(
    tx: Transaction,
    roleId: string,
    permissions: readonly string[],
  ): Promise<void> {
    await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));

    const keys = [...new Set(permissions)];
    if (keys.length === 0) return;

    const rows = await tx
      .select({ id: schema.permissions.id, key: schema.permissions.key })
      .from(schema.permissions)
      .where(inArray(schema.permissions.key, keys));

    if (rows.length !== keys.length) {
      const found = new Set(rows.map((row) => row.key));
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'One or more permissions are not in the catalogue',
        details: { unknown: keys.filter((key) => !found.has(key)) },
      });
    }

    for (const row of rows) {
      await tx
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId: row.id })
        .onConflictDoNothing();
    }
  }

  /**
   * Writes the mutation's audit row inside the mutation's own transaction.
   *
   * Every role action is security-sensitive (`SECURITY.md` §4), so `AuditWriter`
   * requires the transaction and the two share a fate: an audit failure rolls
   * the role change back with it.
   */
  private async record(
    tx: Transaction,
    principal: AuthPrincipal,
    orgId: string,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    roleId: string,
    payload: { before: Record<string, unknown> | null; after: Record<string, unknown> | null },
  ): Promise<void> {
    await this.audit.record(
      {
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action,
        resourceType: 'Role',
        resourceId: roleId,
        outcome: 'success',
        before: payload.before,
        after: payload.after,
        metadata: { roleId },
      },
      tx,
    );
  }
}
