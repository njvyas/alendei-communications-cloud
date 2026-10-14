/**
 * Templates contracts (Phase 3.1, ADR-014 §6, §11, D21).
 *
 * Organization-owned resource under `/templates`.
 * approval_status is an internal, simulated state moved by templates.manage.
 */

export const TEMPLATE_APPROVAL_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
] as const;
export type TemplateApprovalStatus = (typeof TEMPLATE_APPROVAL_STATUSES)[number];

export interface TemplateResponse {
  readonly id: string;
  readonly orgId: string;
  readonly channelId: string;
  readonly name: string;
  readonly body: string;
  readonly variables: readonly string[];
  readonly approvalStatus: TemplateApprovalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}
