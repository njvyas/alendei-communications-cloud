import { JOURNEY_RUNNER_ERROR_CODES } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { audienceContactPredicates } from '../../contacts/audience-predicates';
import { JourneyNodeFailure } from './runner-errors';

type SegmentCriteria = {
  tags?: string[];
  tagMatchMode?: 'any' | 'all';
  channel?: string;
  channelId?: string;
  consentType?: string;
  requireOptIn?: boolean;
  customFieldFilters?: { field: string; operator: string; value?: unknown }[];
};

/** A channel code's id (`app_channel_resolve`); a deterministic failure when unknown. */
export async function resolveChannelId(tx: Transaction, code: string): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(
    sql`SELECT id FROM app_channel_resolve(${code}::text)`,
  );
  const id = rows[0]?.id;
  if (!id)
    throw new JourneyNodeFailure(JOURNEY_RUNNER_ERROR_CODES.CHANNEL_NOT_FOUND, 'channel not found');
  return id;
}

/**
 * Phase 8C (8C-3 condition, 8C-4 schedule): a segment's membership predicates over `contacts`,
 * exactly as `ContactsService.resolveAudience` builds them (`audience-predicates.ts`). Reads the
 * segment under the caller's policies. Deterministic failures: a missing segment, an unknown
 * channel, consent criteria without a channel (refused as resolveAudience refuses them), or
 * invalid criteria.
 */
export async function segmentPredicates(
  tx: Transaction,
  segment: { readonly id: string; readonly orgId: string; readonly workspaceId: string },
): Promise<SQL[]> {
  const [row] = await tx
    .select({ criteria: schema.segments.criteria })
    .from(schema.segments)
    .where(
      and(
        eq(schema.segments.id, segment.id),
        eq(schema.segments.orgId, segment.orgId),
        eq(schema.segments.workspaceId, segment.workspaceId),
        isNull(schema.segments.deletedAt),
      ),
    );
  if (!row)
    throw new JourneyNodeFailure(JOURNEY_RUNNER_ERROR_CODES.SEGMENT_NOT_FOUND, 'segment not found');
  const criteria = (row.criteria ?? {}) as SegmentCriteria;
  const channelId = criteria.channelId
    ? criteria.channelId
    : criteria.channel
      ? await resolveChannelId(tx, criteria.channel)
      : undefined;
  if ((criteria.requireOptIn === true || criteria.consentType !== undefined) && !channelId)
    throw new JourneyNodeFailure('VALIDATION_FAILED', 'segment consent criteria need a channel');
  try {
    return audienceContactPredicates(criteria, channelId ? { id: channelId } : undefined);
  } catch {
    throw new JourneyNodeFailure('VALIDATION_FAILED', 'segment criteria are invalid');
  }
}
