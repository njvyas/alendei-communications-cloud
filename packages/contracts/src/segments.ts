/**
 * Saved Segments contracts (Phase 8A.1, `ROADMAP.md` §11a, `DATABASE.md` §12a).
 *
 * Workspace-owned resources under `/workspaces/:workspaceId/segments`.
 */

import type { PageInfo } from './api';
import type { AudienceTagMatchMode } from './contacts';

export const CUSTOM_FIELD_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'exists',
  'does_not_exist',
] as const;
export type CustomFieldOperator = (typeof CUSTOM_FIELD_OPERATORS)[number];

export interface CustomFieldFilter {
  readonly field: string;
  readonly operator: CustomFieldOperator;
  readonly value?: string | number | boolean;
}

export interface SegmentCriteria {
  readonly tags?: readonly string[];
  readonly tagMatchMode?: AudienceTagMatchMode;
  readonly channel?: string;
  readonly channelId?: string;
  readonly consentType?: string;
  readonly requireOptIn?: boolean;
  readonly customFieldFilters?: readonly CustomFieldFilter[];
}

export interface SegmentResponse {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly criteria: SegmentCriteria;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListSegmentsResponse {
  readonly data: readonly SegmentResponse[];
  readonly page: PageInfo;
}
