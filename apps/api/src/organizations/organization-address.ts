import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type AuthPrincipal, type TenantContext } from '@acc/contracts';
import { schema, type TenantSession } from '@acc/db';
import { eq } from 'drizzle-orm';

import type { ResolvedPrincipal } from '../auth/auth.guard';
import { organizationInactiveError } from '../auth/scope-resolver.service';
import { AppException } from '../common/errors/app.exception';
import type { TenantDatabase } from '../database/tenant-database.service';

/** The tenant session for acting on one organization, and the actor as it stands there. */
export interface AddressedOrganization {
  readonly session: TenantSession;
  readonly actor: AuthPrincipal;
}

/**
 * Resolves the context for acting on organization `id` named by a URL path,
 * exactly as selecting it with `X-Acc-Organization` would. Used by every route
 * that addresses an organization by path under `@NoTenantContext()`
 * (`/organizations/:id/...`, including the U12 domain and branding routes).
 *
 * - The organization is looked up on the identity plane (`acc_auth`), never
 *   through the caller's RLS view.
 * - A principal without a platform-scope grant must be connected to the
 *   organization: an inactive one is refused as selecting it would be, and one
 *   it holds no grant in is reported exactly like an organization that does not
 *   exist (`404 RESOURCE_NOT_FOUND`). Nothing distinguishes "exists but not
 *   yours" from "does not exist", and no tenant session is ever opened for it.
 * - Otherwise the returned session's organization claim is that organization,
 *   with a reseller claim only for a reseller grant the principal holds over its
 *   reseller; and `actor` is the principal placed in that organization, so an
 *   `authorization.denied` row for a permission it lacks there is attributed to
 *   the organization it is connected to (ADR-005 D-6) — never left without a
 *   scope, which would turn a refusal into a 500.
 */
export async function addressOrganization(
  db: TenantDatabase,
  principal: ResolvedPrincipal,
  id: string,
): Promise<AddressedOrganization> {
  const [org] = await db.auth
    .select({ resellerId: schema.organizations.resellerId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, id));
  if (!org) throw organizationNotFound(id);

  const platformGrant = principal.roles.some((g) => g.scopeType === 'platform');
  if (!platformGrant) {
    const inactive = principal.inactiveOrganizations[id];
    if (inactive) throw organizationInactiveError(id, inactive);
    if (!principal.authorizedOrganizationIds.includes(id)) throw organizationNotFound(id);
  }

  const heldResellers = principal.roles
    .filter((g) => g.scopeType === 'reseller' && g.scopeId)
    .map((g) => g.scopeId!);
  const tenant: TenantContext = {
    orgId: id,
    workspaceId: null,
    resellerId: org.resellerId && heldResellers.includes(org.resellerId) ? org.resellerId : null,
    isPlatformAdmin: principal.tenant.isPlatformAdmin,
  };
  return {
    session: { ...tenant, userId: principal.userId },
    actor: { ...principal, tenant },
  };
}

export function organizationNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Organization not found',
    logContext: { requestedOrganizationId: id },
  });
}
