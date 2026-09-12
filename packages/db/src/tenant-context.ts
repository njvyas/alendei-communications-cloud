import { sql, type SQL } from 'drizzle-orm';

import { SESSION_VARS } from './constants';

/**
 * The authoritative tenant context a transaction runs under.
 *
 * It is always derived from validated authentication material (an HTTP request's
 * resolved principal) or from an event/job envelope's designated authoritative
 * fields (`TENANCY.md` §5) — never from arbitrary request or payload data.
 */
export interface TenantSession {
  readonly orgId?: string | null;
  readonly workspaceId?: string | null;
  readonly resellerId?: string | null;
  readonly userId?: string | null;
  /** Only true when the principal actually holds a platform-scoped role. */
  readonly isPlatformAdmin?: boolean;
  /**
   * Set exclusively by the tenant-provisioning path, together with `orgId` set
   * to the organization being created. It permits that one organization INSERT
   * and widens nothing else.
   */
  readonly provisioning?: boolean;
}

/** A tenant session with every variable explicitly cleared. */
export const EMPTY_TENANT_SESSION: TenantSession = Object.freeze({
  orgId: null,
  workspaceId: null,
  resellerId: null,
  userId: null,
  isPlatformAdmin: false,
  provisioning: false,
});

function localSetting(name: string, value: string): SQL {
  // `set_config(..., true)` is the parameterizable form of `SET LOCAL`, and is
  // what keeps the value bound to this transaction only.
  return sql`select set_config(${name}, ${value}, true)`;
}

/**
 * The statements that establish tenant context for one transaction.
 *
 * Every variable is written on every transaction — including the empty string
 * for absent ones — so a value can never be inherited from whatever ran on this
 * pooled connection before.
 */
export function tenantContextStatements(session: TenantSession): SQL[] {
  return [
    localSetting(SESSION_VARS.ORG_ID, session.orgId ?? ''),
    localSetting(SESSION_VARS.WORKSPACE_ID, session.workspaceId ?? ''),
    localSetting(SESSION_VARS.RESELLER_ID, session.resellerId ?? ''),
    localSetting(SESSION_VARS.USER_ID, session.userId ?? ''),
    localSetting(SESSION_VARS.IS_PLATFORM_ADMIN, session.isPlatformAdmin ? 'on' : 'off'),
    localSetting(SESSION_VARS.PROVISIONING, session.provisioning ? 'on' : 'off'),
  ];
}
