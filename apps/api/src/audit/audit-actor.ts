import { anonymousLoginFailureActor, type AuditRecordInput } from '@acc/contracts';

import { RequestContext } from '../common/context/request-context';

/** The actor half of an audit record. */
export type AuditActor = Pick<
  AuditRecordInput,
  'actorType' | 'actorUserId' | 'actorApiKeyId' | 'actorLabel'
>;

/**
 * Derives the actor from the authenticated principal on the current request.
 *
 * Returns `null` when there is no principal — the caller then has to say what
 * the actor is, rather than getting a plausible-looking default. An audit row
 * that misattributes an action is worse than one that refuses to be written.
 *
 * `audit_logs_actor_shape` enforces the pairings this produces at the database:
 * a `user` row carries a user id and no key id, an `api_key` row the reverse.
 */
export function actorFromRequest(): AuditActor | null {
  const principal = RequestContext.get()?.principal;
  if (!principal) return null;

  return {
    actorType: principal.actorType,
    actorUserId: principal.userId,
    actorApiKeyId: principal.apiKeyId,
    actorLabel: null,
  };
}

/**
 * The actor for a login attempt against an identity that does not exist
 * (ADR-003 R4). Re-exported here so audit callers reach for one module.
 */
export { anonymousLoginFailureActor };
