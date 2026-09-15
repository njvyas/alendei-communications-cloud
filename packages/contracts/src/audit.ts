/**
 * Audit contract (`SECURITY.md` §4, `DATABASE.md` §12).
 *
 * Security-sensitive actions are written synchronously: the triggering request
 * fails if its audit row cannot be written.
 */
import type { ActorType, ScopeType } from './tenancy';

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_ACTIONS = {
  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',
  SESSION_REVOKED: 'session.revoked',
  SESSION_REVOKED_ALL: 'session.revoked_all',

  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
  API_KEY_AUTHENTICATED: 'api_key.authenticated',

  WS_TICKET_ISSUED: 'ws_ticket.issued',
  WS_TICKET_CONSUMED: 'ws_ticket.consumed',
  WS_TICKET_REJECTED: 'ws_ticket.rejected',

  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  TEAM_CREATED: 'team.created',
  TEAM_UPDATED: 'team.updated',

  USER_INVITED: 'user.invited',
  USER_UPDATED: 'user.updated',
  USER_DISABLED: 'user.disabled',

  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  USER_ROLE_GRANTED: 'user_role.granted',
  USER_ROLE_REVOKED: 'user_role.revoked',

  AUTHORIZATION_DENIED: 'authorization.denied',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * The only actions the identity database role (`acc_auth`) may record, and only
 * ever at `platform` scope (ADR-002, `DATABASE.md` §2a).
 *
 * These are exactly the events that happen *before* a tenant context exists, so
 * they cannot be RLS-filtered by organization and must instead be bounded by
 * vocabulary. The database enforces this list in `app_is_auth_audit_action()`;
 * `audit.int-spec.ts` asserts the two lists have not drifted apart.
 */
export const AUTH_ROLE_AUDIT_ACTIONS: readonly AuditAction[] = Object.freeze([
  AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
  AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
  AUDIT_ACTIONS.AUTH_LOGOUT,
  AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED,
  AUDIT_ACTIONS.API_KEY_AUTHENTICATED,
]);

export function isAuthRoleAuditAction(action: string): boolean {
  return (AUTH_ROLE_AUDIT_ACTIONS as readonly string[]).includes(action);
}

/**
 * The actor label recorded when an authentication attempt cannot be associated
 * with a real user — an unknown email address (ADR-003 R4, `SECURITY.md` §4).
 *
 * Such an attempt is never omitted from the audit trail, and a fictitious
 * `actorUserId` is never invented for it: the row is written with
 * `actorType: 'system'` and this label instead.
 *
 * The value is load-bearing, not descriptive. The `audit_logs_auth_insert`
 * policy admits a `system` actor through `acc_auth` only when the action is
 * exactly `auth.login.failed` AND the label is exactly this string, so a change
 * here without the matching migration silently disables the anonymous-failure
 * audit path. `audit.int-spec.ts` asserts the two agree.
 */
export const ANONYMOUS_LOGIN_ACTOR_LABEL = 'anonymous_login_attempt';

/**
 * The audit record for a login attempt against an unknown identity. Exported as
 * one helper so every caller produces the exact shape the database policy
 * admits, rather than assembling it from the constants by hand.
 */
export function anonymousLoginFailureActor(): Pick<
  AuditRecordInput,
  'actorType' | 'actorUserId' | 'actorApiKeyId' | 'actorLabel'
> {
  return {
    actorType: 'system',
    actorUserId: null,
    actorApiKeyId: null,
    actorLabel: ANONYMOUS_LOGIN_ACTOR_LABEL,
  };
}

/**
 * Actions classified as security-sensitive (`SECURITY.md` §4): their audit write
 * is synchronous and failing it fails the request.
 *
 * `AUTHORIZATION_DENIED` is here for the same reason as the mutations: a refused
 * escalation is precisely the event worth having a record of (`RBAC.md` §7), so
 * a denial whose record could not be written must not be reported as an
 * ordinary refusal. It differs from the others only in what it couples to —
 * having no business mutation of its own, it commits in its own transaction
 * before the refusal is raised (ADR-005 D-6).
 */
export const SECURITY_SENSITIVE_AUDIT_ACTIONS: readonly AuditAction[] = Object.freeze([
  AUDIT_ACTIONS.AUTHORIZATION_DENIED,
  AUDIT_ACTIONS.API_KEY_CREATED,
  AUDIT_ACTIONS.API_KEY_REVOKED,
  AUDIT_ACTIONS.ROLE_CREATED,
  AUDIT_ACTIONS.ROLE_UPDATED,
  AUDIT_ACTIONS.ROLE_DELETED,
  AUDIT_ACTIONS.USER_ROLE_GRANTED,
  AUDIT_ACTIONS.USER_ROLE_REVOKED,
  AUDIT_ACTIONS.USER_DISABLED,
  AUDIT_ACTIONS.SESSION_REVOKED,
  AUDIT_ACTIONS.SESSION_REVOKED_ALL,
]);

export function isSecuritySensitiveAction(action: string): boolean {
  return (SECURITY_SENSITIVE_AUDIT_ACTIONS as readonly string[]).includes(action);
}

export interface AuditRecordInput {
  /**
   * The scope at which the action occurred (`TENANCY.md` §1a, ADR-002).
   * `scopeId` is the row named by `scopeType`, and is `null` only for
   * `platform`. The database DERIVES `reseller_id`/`org_id`/`workspace_id`/
   * `team_id` from this pair — a caller never supplies them, and a caller that
   * tried could not widen its own reach by doing so.
   */
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly actorType: ActorType;
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
  readonly actorLabel: string | null;
  readonly action: AuditAction | string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: AuditOutcome;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  /** Never carries credential material — see `SECURITY.md` §2. */
  readonly metadata: Record<string, unknown>;
  /**
   * Constant for every record produced by one originating request or job — the
   * value that ties logs, traces, events, ledger entries and audit rows together
   * (`OBSERVABILITY.md` §2).
   */
  readonly correlationId: string;
  /**
   * The immediate cause of this action: the id of the request or event that
   * triggered it (`EVENTS.md` §2). Changes at every hop, where `correlationId`
   * does not — which is what allows a causal chain to be ordered, not merely
   * grouped. `null` when this action originated the chain.
   */
  readonly causationId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}
