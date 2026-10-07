import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ScopeRef } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { eq } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';

/**
 * Lifecycle preconditions for writing *into* a scope (Phase 1C.1b, ADR-012
 * F-5, F-6), read inside the caller's own transaction.
 *
 * These are state checks, not authorization: every caller has already been
 * authorized for the target by `AuthorizationService.assert`, and runs these
 * afterwards so that a principal that may not act on a scope never learns its
 * state. Each read takes `FOR SHARE` on the row it judges, so a concurrent
 * lifecycle transition — which `UPDATE`s that row — waits for this transaction
 * to finish, or this one waits for it and then sees its result. The state that
 * was checked is therefore the state the write commits against.
 */

export function workspaceLifecycleConflict(
  status: string,
  extra: Record<string, unknown> = {},
): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.WORKSPACE_LIFECYCLE_CONFLICT,
    message: `This workspace is ${status}; the operation is not permitted in that state`,
    details: { status, ...extra },
  });
}

export function teamLifecycleConflict(status: string): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.TEAM_LIFECYCLE_CONFLICT,
    message: `This team is ${status}; the operation is not permitted in that state`,
    details: { status },
  });
}

/**
 * The organization must be `active` for a tenant-data mutation (ADR-012 F-5).
 *
 * `AuthGuard` already refuses a mutating request in a non-active organization's
 * context; this is the same rule held at the row, inside the mutation's
 * transaction, so a suspension committed between authentication and the write
 * cannot be raced past.
 */
export async function assertOrganizationActive(tx: Transaction, orgId: string): Promise<void> {
  const [org] = await tx
    .select({ status: schema.organizations.status })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId))
    .for('share');
  if (!org) {
    throw new AppException({
      status: HttpStatus.NOT_FOUND,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'Organization not found',
    });
  }
  if (org.status !== 'active') {
    throw new AppException({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT,
      message: `This organization is ${org.status}; the operation is not permitted in that state`,
      details: { status: org.status },
      logContext: { refusedOrganizationStatus: org.status },
    });
  }
}

/**
 * The organization owning `target`, read from the database: the scope itself for
 * an organization, the row's own `org_id` for a workspace or team, and `null`
 * for `platform` and `reseller`, which belong to no organization. A workspace or
 * team that does not resolve is a `404` — callers have already authorized the
 * target, so this is defensive, and it fails closed rather than skipping the
 * lifecycle check.
 */
export async function organizationOfScope(
  tx: Transaction,
  target: ScopeRef,
): Promise<string | null> {
  if (!target.scopeId) return null;
  if (target.scopeType === 'organization') return target.scopeId;

  let row: { orgId: string } | undefined;
  if (target.scopeType === 'workspace') {
    [row] = await tx
      .select({ orgId: schema.workspaces.orgId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, target.scopeId));
  } else if (target.scopeType === 'team') {
    [row] = await tx
      .select({ orgId: schema.teams.orgId })
      .from(schema.teams)
      .where(eq(schema.teams.id, target.scopeId));
  } else {
    return null;
  }
  if (!row) {
    throw new AppException({
      status: HttpStatus.NOT_FOUND,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'Scope not found',
    });
  }
  return row.orgId;
}

/**
 * The organization owning the *target* of a mutation must be `active`
 * (ADR-012 F-5) — not merely the selected one.
 *
 * Role grants, role revocations and API keys name their target scope
 * explicitly, and a principal whose authority spans several organizations (a
 * reseller administrator, a platform administrator) can name a scope in an
 * organization other than the one it selected. `AuthGuard` only judges the
 * selected organization, so without this a suspended or closed organization
 * could be changed from an active one's context. The owning organization is
 * derived from the target's database row, never from the request, and is read
 * `FOR SHARE` as in `assertOrganizationActive`, so a concurrent transition
 * serializes against the write.
 *
 * Call it after `AuthorizationService.assert`, so only a principal that may act
 * on the target learns its organization's state, and before any workspace or
 * team lock, to keep the lock order organization → workspace → team.
 */
export async function assertTargetOrganizationActive(
  tx: Transaction,
  target: ScopeRef,
): Promise<void> {
  const orgId = await organizationOfScope(tx, target);
  if (orgId) await assertOrganizationActive(tx, orgId);
}

/**
 * An archived workspace or team cannot receive new teams, grants or API keys
 * (ADR-012 F-6). Organization and higher scopes have no archived state here —
 * organization status is F-5's concern — so they pass unchanged.
 *
 * A team is judged together with its workspace: an active team in an archived
 * workspace is unrepresentable through the API (archiving a workspace requires
 * its teams archived first, and restoring a team requires its workspace
 * active), but the check does not rely on that.
 */
export async function assertScopeAcceptsNewMembers(
  tx: Transaction,
  target: ScopeRef,
): Promise<void> {
  if (target.scopeType === 'workspace' && target.scopeId) {
    const [workspace] = await tx
      .select({ status: schema.workspaces.status })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, target.scopeId))
      .for('share');
    if (workspace && workspace.status !== 'active') {
      throw workspaceLifecycleConflict(workspace.status);
    }
    return;
  }

  if (target.scopeType === 'team' && target.scopeId) {
    const [team] = await tx
      .select({ status: schema.teams.status, workspaceId: schema.teams.workspaceId })
      .from(schema.teams)
      .where(eq(schema.teams.id, target.scopeId))
      .for('share');
    if (!team) return;
    if (team.status !== 'active') throw teamLifecycleConflict(team.status);
    await assertScopeAcceptsNewMembers(tx, { scopeType: 'workspace', scopeId: team.workspaceId });
  }
}
