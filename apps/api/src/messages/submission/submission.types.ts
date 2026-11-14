import type { SubmissionAuthorization } from './submission-authorization';

/**
 * What is being sent (Phase 7 PR 7-3). Exactly the fields of `SendMessageDto`,
 * no more: the core takes no organization, campaign, billing or routing input.
 */
export interface SubmissionRequest {
  readonly channelCode: string;
  readonly recipient: string;
  readonly templateId?: string;
  readonly workspaceId?: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Who is sending, and under what proof. Built by the caller from validated
 * authentication material only (`TENANCY.md` §§2, 5), never from request input.
 */
export interface SubmissionContext {
  /** The organization of the caller's tenant transaction. */
  readonly orgId: string;
  /** Persisted on the message; on the HTTP path, the request's correlation id. */
  readonly correlationId: string;
  /** Proof that the send permission was asserted in this transaction (`authorizeSubmission`). */
  readonly authorization: SubmissionAuthorization;
  /**
   * The automation that originates the message (Phase 8C-5a). Absent for a direct
   * submission: `POST /messages` never passes one, and no request field can produce one.
   */
  readonly origin?: SubmissionOrigin;
}

/**
 * Message attribution (Phase 8C-5a, handover Rev 2 §4). A discriminated union with one
 * owner, the backend send-core owner; the core maps each variant to its columns through an
 * exhaustive switch, so a variant added without handling is a compile error.
 *
 * - `journey`: sets `messages.journey_id` and `journey_execution_id`; the composite foreign
 *   key `messages_journey_execution_fk` (0066) proves the execution is the message's own
 *   journey, workspace, contact and organization.
 *
 * Reserved, not implemented: the campaign variant belongs to 8B-3, added in its own PR.
 * Built only from server-side execution state, never from request input.
 */
export type SubmissionOrigin = {
  readonly kind: 'journey';
  readonly journeyId: string;
  readonly executionId: string;
};

/** The message the core created, in plain values; the caller shapes any response. */
export interface SubmissionResult {
  readonly messageId: string;
  readonly status: 'queued';
  readonly createdAt: Date;
  readonly correlationId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelCode: string;
}
