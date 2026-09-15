import {
  anonymousLoginFailureActor,
  type AuditRecordInput,
  type AuthPrincipal,
} from '@acc/contracts';

import { RequestContext } from '../common/context/request-context';

/** The actor half of an audit record. */
export type AuditActor = Pick<
  AuditRecordInput,
  'actorType' | 'actorUserId' | 'actorApiKeyId' | 'actorLabel'
>;

/**
 * The one mapping from a principal to an audit actor.
 *
 * Identity only — never a credential, a prefix, or anything derived from one.
 * An API-key actor is identified by its row id and nothing else, which is what
 * lets a key be attributed without its secret half ever reaching an
 * append-only row (`SECURITY.md` §2).
 *
 * `audit_logs_actor_shape` enforces the pairings this produces at the database:
 * a `user` row carries a user id and no key id, an `api_key` row the reverse.
 */
export function actorFromPrincipal(principal: AuthPrincipal): AuditActor {
  return {
    actorType: principal.actorType,
    actorUserId: principal.userId,
    actorApiKeyId: principal.apiKeyId,
    actorLabel: null,
  };
}

/**
 * Derives the actor from the authenticated principal on the current request.
 *
 * Returns `null` when there is no principal — the caller then has to say what
 * the actor is, rather than getting a plausible-looking default. An audit row
 * that misattributes an action is worse than one that refuses to be written.
 *
 * Delegates to `actorFromPrincipal` rather than repeating the field mapping: a
 * caller holding a principal already (an authorization decision, say) needs the
 * same translation without the ambient lookup, and two copies of it would be
 * two places for the actor shape to drift.
 */
export function actorFromRequest(): AuditActor | null {
  const principal = RequestContext.get()?.principal;
  return principal ? actorFromPrincipal(principal) : null;
}

/**
 * The actor for a login attempt against an identity that does not exist
 * (ADR-003 R4). Re-exported here so audit callers reach for one module.
 */
export { anonymousLoginFailureActor };
