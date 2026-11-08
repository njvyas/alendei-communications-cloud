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
}

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
