/**
 * Audit contract (`SECURITY.md` §4, `DATABASE.md` §12).
 *
 * Security-sensitive actions are written synchronously: the triggering request
 * fails if its audit row cannot be written.
 */
import type { ActorType } from './tenancy';

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
 * Actions classified as security-sensitive (`SECURITY.md` §4): their audit write
 * is synchronous and failing it fails the request.
 */
export const SECURITY_SENSITIVE_AUDIT_ACTIONS: readonly AuditAction[] = Object.freeze([
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
  readonly orgId: string | null;
  readonly workspaceId: string | null;
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
  readonly correlationId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}
