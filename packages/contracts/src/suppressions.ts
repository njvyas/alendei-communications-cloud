/**
 * Suppressions contracts (Phase 3.1, ADR-014 §6, D09, P3-D22).
 *
 * Organization-owned resource under `/suppressions`.
 * Created and lifted under suppressions.manage at organization scope.
 */

export const SUPPRESSION_STATUSES = ['active', 'cleared'] as const;
export type SuppressionStatus = (typeof SUPPRESSION_STATUSES)[number];

export interface SuppressionResponse {
  readonly id: string;
  readonly orgId: string;
  readonly channelId: string | null;
  readonly rawAddress: string;
  readonly normalizedAddress: string;
  readonly reason: string;
  readonly status: SuppressionStatus;
  readonly clearedAt: string | null;
  readonly clearedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
