import { PERMISSIONS, type AuthPrincipal } from '@acc/contracts';
import type { Transaction } from '@acc/db';

import type { AuthorizationService } from '../../auth/authorization.service';

declare const submissionAuthorizationBrand: unique symbol;

/**
 * Opaque proof that `messages.send` was asserted for one organization inside
 * one transaction (Phase 7 PR 7-3, handover §5.2).
 *
 * It is a programming-error guard, not a new authorization rule: the permission,
 * scope, target and denial audit are exactly the check `POST /messages` has always
 * made. It exists so that no caller of `MessageSubmissionCore` can reach message
 * creation without that check, on HTTP or off it.
 */
export type SubmissionAuthorization = { readonly [submissionAuthorizationBrand]: true };

/** Proofs minted by this module, each bound to its transaction and organization. */
const minted = new WeakMap<object, { readonly tx: Transaction; readonly orgId: string }>();

/**
 * Asserts `messages.send` at organization scope — unchanged from the pre-7-3
 * send path — and returns a proof bound to `tx` and `orgId`. A refusal throws
 * (and records its `authorization.denied` row) exactly as before.
 */
export async function authorizeSubmission(
  authorization: AuthorizationService,
  tx: Transaction,
  principal: AuthPrincipal,
  orgId: string,
): Promise<SubmissionAuthorization> {
  await authorization.assert(tx, {
    principal,
    permission: PERMISSIONS.MESSAGES_SEND,
    target: { scopeType: 'organization', scopeId: orgId },
    resourceType: 'Organization',
  });
  const proof = Object.freeze({}) as SubmissionAuthorization;
  minted.set(proof, { tx, orgId });
  return proof;
}

/**
 * Refuses, before anything is read, a proof that this module did not mint, or
 * one minted for another transaction or organization. Not reachable from any
 * request input; a failure is a defect in the caller and surfaces as a `500`.
 */
export function assertSubmissionAuthorized(
  proof: SubmissionAuthorization,
  tx: Transaction,
  orgId: string,
): void {
  const binding = typeof proof === 'object' && proof !== null ? minted.get(proof) : undefined;
  if (!binding || binding.tx !== tx || binding.orgId !== orgId) {
    throw new Error(
      'message submission: no messages.send authorization bound to this transaction and organization',
    );
  }
}
