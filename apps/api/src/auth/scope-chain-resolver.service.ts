import { Injectable } from '@nestjs/common';
import type { ScopeChain, ScopeRef } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { eq } from 'drizzle-orm';

/**
 * Resolves a target's authoritative scope ancestry from the database
 * (ADR-005 D-5).
 *
 * `scopeCovers` decides coverage from a grant, a target and the target's
 * *chain* — and it is only as correct as that chain. A workspace id alone says
 * nothing about whether an organization-scoped grant reaches it; the answer is
 * the workspace's real parent, and the only place that lives is the database.
 *
 * So this class exists to make one rule structural: **a caller may name the
 * target, and may never state its ancestry.** There is deliberately no
 * parameter here through which a chain could be supplied — a forged
 * `organization_id` or `reseller_id` on a request has nowhere to enter, rather
 * than being accepted and then filtered.
 *
 * It resolves and nothing else. It holds no permission logic (that is
 * `PermissionEvaluator`) and makes no decision (that is
 * `AuthorizationService`).
 *
 * **Visibility is part of the answer.** Every read runs as `acc_app` inside the
 * request's own tenant transaction, so RLS applies: a target belonging to
 * another organization is not merely unresolvable in principle, it is invisible
 * in fact. `null` therefore means "no such target, for you" and becomes a `404`
 * that confirms nothing (`API.md` §3a) — never a `403`, which would disclose
 * that the row exists somewhere else.
 *
 * It lives beside `ScopeResolver` rather than in `tenancy` because the two do
 * the same kind of work — reading tenancy rows to answer an authorization
 * question — and because `ScopeResolver.tenantContextFor` already reads
 * `teams` and `organizations` for exactly this purpose.
 */
@Injectable()
export class ScopeChainResolver {
  /**
   * The authoritative ancestry of `target`, or `null` when the target does not
   * exist or is not visible in the current tenant context.
   *
   * The chain is built from columns the database guarantees: `workspaces.org_id`
   * is `NOT NULL`, and `teams` carries both `workspace_id` and `org_id` under a
   * composite foreign key to `workspaces(id, org_id)` — so a team whose
   * organization disagrees with its workspace is unrepresentable
   * (`TENANCY.md` §1a.3) and its ancestry needs no join to be trustworthy.
   */
  async resolve(tx: Transaction, target: ScopeRef): Promise<ScopeChain | null> {
    switch (target.scopeType) {
      case 'platform':
        // The root has no ancestry. A platform *grant* covers everything by
        // short-circuit in `scopeCovers`; a platform *target* simply has
        // nothing above it.
        return {};

      case 'reseller':
        return target.scopeId ? this.resellerChain(tx, target.scopeId) : null;

      case 'organization':
        return target.scopeId ? this.organizationChain(tx, target.scopeId) : null;

      case 'workspace':
        return target.scopeId ? this.workspaceChain(tx, target.scopeId) : null;

      case 'team':
        return target.scopeId ? this.teamChain(tx, target.scopeId) : null;

      default:
        // Unreachable for `ScopeType`, but an unknown level resolves to nothing
        // rather than to an empty chain that would cover by accident.
        return null;
    }
  }

  private async resellerChain(tx: Transaction, resellerId: string): Promise<ScopeChain | null> {
    const [row] = await tx
      .select({ id: schema.resellers.id })
      .from(schema.resellers)
      .where(eq(schema.resellers.id, resellerId));
    return row ? { resellerId: row.id } : null;
  }

  private async organizationChain(tx: Transaction, orgId: string): Promise<ScopeChain | null> {
    const [row] = await tx
      .select({ id: schema.organizations.id, resellerId: schema.organizations.resellerId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    // `reseller_id` is nullable; a null term simply covers nothing, which is
    // the fail-closed direction.
    return row ? { resellerId: row.resellerId, orgId: row.id } : null;
  }

  private async workspaceChain(tx: Transaction, workspaceId: string): Promise<ScopeChain | null> {
    // One join, because a workspace carries its organization but not its
    // reseller. The organization is read from `workspaces.org_id`, never from
    // anything the caller sent.
    const [row] = await tx
      .select({
        id: schema.workspaces.id,
        orgId: schema.workspaces.orgId,
        resellerId: schema.organizations.resellerId,
      })
      .from(schema.workspaces)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.orgId))
      .where(eq(schema.workspaces.id, workspaceId));

    return row ? { resellerId: row.resellerId, orgId: row.orgId, workspaceId: row.id } : null;
  }

  private async teamChain(tx: Transaction, teamId: string): Promise<ScopeChain | null> {
    const [row] = await tx
      .select({
        id: schema.teams.id,
        workspaceId: schema.teams.workspaceId,
        orgId: schema.teams.orgId,
        resellerId: schema.organizations.resellerId,
      })
      .from(schema.teams)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.teams.orgId))
      .where(eq(schema.teams.id, teamId));

    return row
      ? {
          resellerId: row.resellerId,
          orgId: row.orgId,
          workspaceId: row.workspaceId,
          teamId: row.id,
        }
      : null;
  }
}
