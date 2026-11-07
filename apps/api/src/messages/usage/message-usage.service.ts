import { Injectable } from '@nestjs/common';
import {
  MESSAGE_USAGE_MAX_DAYS,
  PERMISSIONS,
  type MessageUsageChannelRow,
  type MessageUsageCounts,
  type MessageUsageDayRow,
  type MessageUsageDeliveryCounts,
  type MessageUsageReportResponse,
  type AuthPrincipal,
} from '@acc/contracts';
import { sql, type SQL } from 'drizzle-orm';

import { AuthorizationService } from '../../auth/authorization.service';
import { ValidationFailedException } from '../../common/errors/app.exception';
import { TenantDatabase } from '../../database/tenant-database.service';
import { requireOrganization } from '../../workspaces/workspace-administration.service';
import type { MessageUsageQueryDto } from './message-usage.dto';

const DAY_MS = 86_400_000;
const TOP_FAILURE_REASONS = 10;

/** One grouped row from the database: a day, a channel, a status and its count. */
export interface UsageCountRow {
  readonly day: string;
  readonly channelCode: string;
  readonly status: string;
  /** Phase 5.0: the message delivery status; `null` = not tracked. */
  readonly deliveryStatus?: string | null;
  readonly count: number;
}

const zero = (): MessageUsageCounts => ({
  total: 0,
  accepted: 0,
  failed: 0,
  outcomeUnknown: 0,
  pending: 0,
});

function add(counts: MessageUsageCounts, status: string, n: number): MessageUsageCounts {
  return {
    total: counts.total + n,
    accepted: counts.accepted + (status === 'accepted' ? n : 0),
    failed: counts.failed + (status === 'failed' ? n : 0),
    outcomeUnknown: counts.outcomeUnknown + (status === 'outcome_unknown' ? n : 0),
    // Everything not settled: counted by exclusion so a new in-flight status is never dropped.
    pending:
      counts.pending +
      (status === 'accepted' || status === 'failed' || status === 'outcome_unknown' ? 0 : n),
  };
}

type DeliveryTally = Omit<MessageUsageDeliveryCounts, 'deliveryRate'>;

/**
 * Phase 5.0: one row's contribution on the delivery axis. Every row lands in exactly one
 * bucket, so the five counts always sum to `totals.total`; an unrecognised value is
 * counted as not tracked rather than dropped.
 */
function addDelivery(t: DeliveryTally, deliveryStatus: string | null | undefined, n: number) {
  return {
    delivered: t.delivered + (deliveryStatus === 'delivered' ? n : 0),
    undelivered: t.undelivered + (deliveryStatus === 'undelivered' ? n : 0),
    pending: t.pending + (deliveryStatus === 'pending' ? n : 0),
    notSupported: t.notSupported + (deliveryStatus === 'not_supported' ? n : 0),
    notTracked:
      t.notTracked +
      (deliveryStatus === 'delivered' ||
      deliveryStatus === 'undelivered' ||
      deliveryStatus === 'pending' ||
      deliveryStatus === 'not_supported'
        ? 0
        : n),
  };
}

/** Pure aggregation of the grouped rows; exported for unit tests. */
export function summarizeUsage(counted: readonly UsageCountRow[]): {
  totals: MessageUsageCounts;
  acceptanceRate: number | null;
  byChannel: MessageUsageChannelRow[];
  byDay: MessageUsageDayRow[];
  delivery: MessageUsageDeliveryCounts;
} {
  let totals = zero();
  let delivery: DeliveryTally = {
    delivered: 0,
    undelivered: 0,
    pending: 0,
    notSupported: 0,
    notTracked: 0,
  };
  const channels = new Map<string, MessageUsageCounts>();
  const days = new Map<string, MessageUsageCounts>();
  for (const row of counted) {
    totals = add(totals, row.status, row.count);
    delivery = addDelivery(delivery, row.deliveryStatus, row.count);
    channels.set(
      row.channelCode,
      add(channels.get(row.channelCode) ?? zero(), row.status, row.count),
    );
    const key = `${row.day}|${row.channelCode}`;
    days.set(key, add(days.get(key) ?? zero(), row.status, row.count));
  }
  const settled = totals.accepted + totals.failed + totals.outcomeUnknown;
  const finalDelivery = delivery.delivered + delivery.undelivered;
  return {
    totals,
    acceptanceRate:
      settled === 0 ? null : Math.round((totals.accepted / settled) * 10_000) / 10_000,
    byChannel: [...channels.entries()]
      .map(([channelCode, counts]) => ({ channelCode, ...counts }))
      .sort((a, b) => b.total - a.total || a.channelCode.localeCompare(b.channelCode)),
    byDay: [...days.entries()]
      .map(([key, counts]) => {
        const [day, channelCode] = key.split('|') as [string, string];
        return { day, channelCode, ...counts };
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.channelCode.localeCompare(b.channelCode)),
    delivery: {
      ...delivery,
      deliveryRate:
        finalDelivery === 0
          ? null
          : Math.round((delivery.delivered / finalDelivery) * 10_000) / 10_000,
    },
  };
}

/** Same `issues` shape the global validation pipe produces. */
function invalid(message: string, field: string, rule: string): ValidationFailedException {
  return new ValidationFailedException({ issues: [{ field, rule, message }] });
}

@Injectable()
export class MessageUsageService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
  ) {}

  /**
   * The request organization's message usage between `from` (inclusive) and
   * `to` (exclusive). Runs in the tenant transaction under `messages.read`, so
   * it can count only rows the caller could list; the `org_id` predicate binds
   * it to the request organization.
   */
  async report(
    principal: AuthPrincipal,
    query: MessageUsageQueryDto,
  ): Promise<MessageUsageReportResponse> {
    const orgId = requireOrganization(principal);
    const timeZone = query.timeZone ?? 'UTC';
    const span = query.to.getTime() - query.from.getTime();
    if (span <= 0) throw invalid('`to` must be later than `from`', 'to', 'range');
    if (span > MESSAGE_USAGE_MAX_DAYS * DAY_MS) {
      throw invalid(`The period may cover at most ${MESSAGE_USAGE_MAX_DAYS} days`, 'to', 'range');
    }

    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.MESSAGES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const zone = await tx.execute<{ ok: number }>(
        sql`SELECT 1 AS ok FROM pg_timezone_names WHERE name = ${timeZone} LIMIT 1`,
      );
      if (zone.rows.length === 0) throw invalid('Unknown time zone', 'timeZone', 'timeZone');

      const predicates: SQL[] = [
        sql`m.org_id = ${orgId}`,
        sql`m.created_at >= ${query.from.toISOString()}::timestamptz`,
        sql`m.created_at < ${query.to.toISOString()}::timestamptz`,
      ];
      if (query.workspaceId) predicates.push(sql`m.workspace_id = ${query.workspaceId}`);
      if (query.channelCode) {
        const resolved = await tx.execute<{ id: string }>(
          sql`SELECT id FROM app_channel_resolve(${query.channelCode}::text)`,
        );
        const channel = resolved.rows[0];
        // An unknown or unavailable channel has no usage; it is not an error.
        predicates.push(channel ? sql`m.channel_id = ${channel.id}` : sql`false`);
      }
      const where = sql.join(predicates, sql` AND `);

      const grouped = await tx.execute<{
        day: string;
        channelCode: string;
        status: string;
        deliveryStatus: string | null;
        count: number;
      }>(sql`
        SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS "day",
               app_channel_code(m.channel_id) AS "channelCode",
               m.status::text AS "status",
               m.delivery_status::text AS "deliveryStatus",
               count(*)::int AS "count"
        FROM messages m
        WHERE ${where}
        GROUP BY 1, 2, 3, 4`);

      // Only a leading upper-case code is returned; free text could carry a recipient.
      const reasons = await tx.execute<{ reason: string; count: number }>(sql`
        SELECT coalesce(substring(m.failure_reason from '^([A-Z][A-Z0-9_]{2,63})(?:$|[:[:space:]])'), 'OTHER') AS "reason",
               count(*)::int AS "count"
        FROM messages m
        WHERE ${where} AND m.status = 'failed'
        GROUP BY 1
        ORDER BY 2 DESC, 1 ASC
        LIMIT ${TOP_FAILURE_REASONS}`);

      const summary = summarizeUsage(grouped.rows.map((r) => ({ ...r, count: Number(r.count) })));
      return {
        orgId,
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        timeZone,
        workspaceId: query.workspaceId ?? null,
        channelCode: query.channelCode ?? null,
        ...summary,
        topFailureReasons: reasons.rows.map((r) => ({ reason: r.reason, count: Number(r.count) })),
      };
    });
  }
}
