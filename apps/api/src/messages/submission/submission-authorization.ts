import { PERMISSIONS, type AuthPrincipal } from '@acc/contracts';
import type { Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

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
 * Phase 8B PR 8B-3a (PHASE-8B-3-HANDOVER-Rev2 §5.2): the automation counterpart of
 * `authorizeSubmission`, for an executor transaction that holds a valid automation capability
 * (`app_automation_capability_mint` earlier in `tx`). It asks the database whether the
 * capability is valid NOW — unexpired, unrevoked, the campaign running, the organization not
 * paused, the claim live — and only then mints the same proof, bound to `tx` and `orgId`.
 *
 * Like the proof itself this is a programming-error guard: the enforcement is in the database,
 * where every capability-gated policy and the reservation re-check the capability at each
 * statement. It never consults a user, an API key or `messages.send`, because the principal is
 * the organisation's authorised automation (OD-8C-1), not a person.
 */
export async function authorizeAutomationSubmission(
  tx: Transaction,
  orgId: string,
): Promise<SubmissionAuthorization> {
  const { rows } = await tx.execute<{ valid: boolean; org: string | null }>(
    sql`SELECT app_automation_capability_valid() AS valid, app_current_org_id()::text AS org`,
  );
  if (rows[0]?.valid !== true || rows[0]?.org !== orgId) {
    throw new Error(
      'message submission: no valid automation capability in this transaction and organization',
    );
  }
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
