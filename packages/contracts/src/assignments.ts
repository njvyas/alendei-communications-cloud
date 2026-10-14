/**
 * Organization Provider Assignments (Phase 3.2, ADR-014 §4, P3-D01–D05).
 *
 * Couples the platform provider catalogue to tenant organizations.
 * Administration is platform-scoped only (`providers.manage` / `providers.read`).
 */

export const ASSIGNMENT_STATUS = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
} as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUS)[keyof typeof ASSIGNMENT_STATUS];

export function isAssignmentStatus(value: unknown): value is AssignmentStatus {
  return value === ASSIGNMENT_STATUS.ACTIVE || value === ASSIGNMENT_STATUS.DISABLED;
}

export interface OrganizationProviderAssignment {
  readonly id: string;
  readonly orgId: string;
  readonly providerId: string;
  readonly channelId: string;
  readonly priority: number;
  readonly status: AssignmentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateOrganizationProviderAssignmentInput {
  readonly providerId: string;
  readonly priority: number;
  readonly status?: AssignmentStatus;
}

export interface UpdateOrganizationProviderAssignmentInput {
  readonly priority?: number;
  readonly status?: AssignmentStatus;
}
