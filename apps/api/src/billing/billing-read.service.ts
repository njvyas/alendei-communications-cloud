import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS, type AuthPrincipal, type PageInfo } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';

import { AuthorizationService } from '../auth/authorization.service';
import { AppException, ValidationFailedException } from '../common/errors/app.exception';
import { ListQuery, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import {
  BILLING_USAGE_MAX_DAYS,
  type BillingUsageQueryDto,
  type ListBillingLedgerQueryDto,
} from './billing-read.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Paise as a JSON number. Balances and limits are far below 2^53 paise. */
const paise = (value: bigint | string | number): number => Number(value);

export interface BillingAccountView {
  readonly billingMode: 'prepaid' | 'postpaid';
  readonly billingPolicy: string;
  readonly status: 'active' | 'frozen';
  readonly currency: string;
  /** Prepaid only: the wallet balance. */
  readonly balancePaise: number | null;
  /** Postpaid only. */
  readonly creditLimitPaise: number | null;
  /** Postpaid only: charges posted against the limit. */
  readonly usedPaise: number | null;
  /** Funds held for messages not yet settled. */
  readonly reservedPaise: number;
  /** What new sends can reserve: balance − reserved, or limit − used − reserved. */
  readonly availablePaise: number;
}

export interface BillingLedgerEntryView {
  readonly id: string;
  readonly entryType: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly messageId: string | null;
  readonly attemptId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
}

interface UsageTotals {
  readonly chargedPaise: number;
  readonly messages: number;
  readonly units: number;
}

export interface BillingUsageView {
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly channelCode: string | null;
  readonly currency: 'INR';
  readonly totals: UsageTotals;
  readonly byChannel: ReadonlyArray<UsageTotals & { readonly channelCode: string }>;
  readonly daily: ReadonlyArray<
    UsageTotals & { readonly day: string; readonly channelCode: string }
  >;
}

/**
 * D-76-4 (09-Nov-2026): billing reads are for signed-in users only. An API key —
 * even one whose scopes were planted outside the API with billing.read — is
 * refused here, in the owning service, as `revokeAllOwnSessions` does; the
 * `@AcceptedCredentials` metadata only documents it.
 */
function requireUserSession(principal: AuthPrincipal): void {
  if (principal.actorType !== 'user' || !principal.userId || !principal.sessionId) {
    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
      message: 'Billing reads require a signed-in user session',
    });
  }
}

function invalid(message: string, field: string, rule: string): ValidationFailedException {
  return new ValidationFailedException({ issues: [{ field, rule, message }] });
}

/**
 * Phase 7 PR 7-6a — tenant billing reads (`DECISIONS.md` §1zi.9 D-76-2, D-76-4;
 * handover Rev 2 §4).
 *
 * Every read runs in the request's tenant transaction under `billing.read` at the
 * request organization. Isolation is the database's: `acc_app` holds SELECT only
 * on the accounts and the ledger parent, under organization-scoped RLS policies,
 * and the ledger policy admits only reservation, reservation_release and
 * customer_charge — a provider cost cannot be returned whatever this code asks
 * for. The explicit `org_id` predicates only make the query plans selective.
 * Nothing here writes.
 */
@Injectable()
export class BillingReadService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly lists: ListQuery,
  ) {}

  /** Newest first by the UUIDv7 id, which orders by creation. */
  private readonly ledgerSpec: ListQuerySpec = {
    sortable: {
      occurredAt: { column: schema.usageLedger.id, encode: (row) => String(row.id) },
    },
    defaultSort: '-occurredAt',
    tieBreaker: schema.usageLedger.id,
  };

  private async authorize(tx: Transaction, principal: AuthPrincipal, orgId: string) {
    await this.authorization.assert(tx, {
      principal,
      permission: PERMISSIONS.BILLING_READ,
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'Organization',
    });
  }

  /** `GET /billing/account`: the account of the organization's billing mode. */
  async account(principal: AuthPrincipal): Promise<BillingAccountView> {
    requireUserSession(principal);
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, orgId);
      const [org] = await tx
        .select({
          billingMode: schema.organizations.billingMode,
          billingPolicy: schema.organizations.billingPolicy,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);
      if (!org) throw accountNotConfigured();

      if (org.billingMode === 'prepaid') {
        const [w] = await tx
          .select()
          .from(schema.wallets)
          .where(eq(schema.wallets.orgId, orgId))
          .limit(1);
        if (!w) throw accountNotConfigured();
        return {
          billingMode: 'prepaid',
          billingPolicy: org.billingPolicy,
          status: w.status,
          currency: w.currency,
          balancePaise: paise(w.balancePaise),
          creditLimitPaise: null,
          usedPaise: null,
          reservedPaise: paise(w.reservedPaise),
          availablePaise: paise(w.balancePaise - w.reservedPaise),
        };
      }
      const [c] = await tx
        .select()
        .from(schema.creditAccounts)
        .where(eq(schema.creditAccounts.orgId, orgId))
        .limit(1);
      if (!c) throw accountNotConfigured();
      return {
        billingMode: 'postpaid',
        billingPolicy: org.billingPolicy,
        status: c.status,
        currency: c.currency,
        balancePaise: null,
        creditLimitPaise: paise(c.creditLimitPaise),
        usedPaise: paise(c.usedPaise),
        reservedPaise: paise(c.reservedPaise),
        availablePaise: paise(c.creditLimitPaise - c.usedPaise - c.reservedPaise),
      };
    });
  }

  /** `GET /billing/ledger`: one page of the organization's tenant-visible ledger entries. */
  async ledger(
    principal: AuthPrincipal,
    query: ListBillingLedgerQueryDto,
  ): Promise<{ items: readonly BillingLedgerEntryView[]; page: PageInfo }> {
    requireUserSession(principal);
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(query, this.ledgerSpec);
    const l = schema.usageLedger;
    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, orgId);
      const predicates: SQL[] = [eq(l.orgId, orgId)];
      if (query.from) predicates.push(gte(l.occurredAt, query.from));
      if (query.to) predicates.push(lt(l.occurredAt, query.to));
      if (query.entryType) predicates.push(eq(l.entryType, query.entryType));
      if (query.messageId) predicates.push(eq(l.messageId, query.messageId));
      if (resolved.after) predicates.push(resolved.after);
      return tx
        .select({
          id: l.id,
          entryType: l.entryType,
          amountPaise: l.amountPaise,
          currency: l.currency,
          messageId: l.messageId,
          attemptId: l.messageAttemptId,
          correlationId: l.correlationId,
          occurredAt: l.occurredAt,
        })
        .from(l)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });
    const { items, page } = this.lists.paginate(rows, resolved, this.ledgerSpec, (row) => row.id);
    return {
      items: items.map((row) => ({
        id: row.id,
        entryType: row.entryType,
        amountPaise: paise(row.amountPaise),
        currency: row.currency,
        messageId: row.messageId,
        attemptId: row.attemptId,
        correlationId: row.correlationId,
        occurredAt: row.occurredAt.toISOString(),
      })),
      page,
    };
  }

  /**
   * `GET /billing/usage`: the organization's customer charges in [from, to), by channel
   * and by day (in the requested time zone), derived from the ledger and never from a
   * separate counter (`BILLING.md` §6). A message counts once per day and channel it was
   * charged in; its units are its persisted billable units.
   */
  async usage(principal: AuthPrincipal, query: BillingUsageQueryDto): Promise<BillingUsageView> {
    requireUserSession(principal);
    const orgId = requireOrganization(principal);
    const timeZone = query.timeZone ?? 'UTC';
    const span = query.to.getTime() - query.from.getTime();
    if (span <= 0) throw invalid('`to` must be later than `from`', 'to', 'range');
    if (span > BILLING_USAGE_MAX_DAYS * DAY_MS) {
      throw invalid(`The period may cover at most ${BILLING_USAGE_MAX_DAYS} days`, 'to', 'range');
    }

    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, orgId);
      const zone = await tx.execute<{ ok: number }>(
        sql`SELECT 1 AS ok FROM pg_timezone_names WHERE name = ${timeZone} LIMIT 1`,
      );
      if (zone.rows.length === 0) throw invalid('Unknown time zone', 'timeZone', 'timeZone');

      const predicates: SQL[] = [
        sql`l.org_id = ${orgId}`,
        sql`l.entry_type = 'customer_charge'`,
        sql`l.occurred_at >= ${query.from.toISOString()}::timestamptz`,
        sql`l.occurred_at < ${query.to.toISOString()}::timestamptz`,
      ];
      if (query.channelCode) {
        const resolved = await tx.execute<{ id: string }>(
          sql`SELECT id FROM app_channel_resolve(${query.channelCode}::text)`,
        );
        const channel = resolved.rows[0];
        predicates.push(channel ? sql`m.channel_id = ${channel.id}` : sql`false`);
      }

      const { rows } = await tx.execute<{
        day: string;
        channelCode: string;
        chargedPaise: string;
        messages: number;
        units: string;
      }>(sql`
        SELECT per_message.day AS "day",
               per_message.channel_code AS "channelCode",
               sum(per_message.charged)::text AS "chargedPaise",
               count(*)::int AS "messages",
               sum(per_message.units)::text AS "units"
          FROM (
            SELECT to_char(date_trunc('day', l.occurred_at AT TIME ZONE ${timeZone}), 'YYYY-MM-DD') AS day,
                   app_channel_code(m.channel_id) AS channel_code,
                   l.message_id,
                   sum(l.amount_paise) AS charged,
                   max(COALESCE(m.billable_units, 0)) AS units
              FROM usage_ledger l
              JOIN messages m ON m.id = l.message_id AND m.org_id = l.org_id
             WHERE ${sql.join(predicates, sql` AND `)}
             GROUP BY 1, 2, 3
          ) per_message
         GROUP BY 1, 2
         ORDER BY 1, 2`);

      const daily = rows.map((r) => ({
        day: r.day,
        channelCode: r.channelCode,
        chargedPaise: paise(r.chargedPaise),
        messages: Number(r.messages),
        units: paise(r.units),
      }));
      const byChannelMap = new Map<string, UsageTotals>();
      for (const d of daily) {
        const t = byChannelMap.get(d.channelCode) ?? { chargedPaise: 0, messages: 0, units: 0 };
        byChannelMap.set(d.channelCode, {
          chargedPaise: t.chargedPaise + d.chargedPaise,
          messages: t.messages + d.messages,
          units: t.units + d.units,
        });
      }
      const byChannel = [...byChannelMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([channelCode, t]) => ({ channelCode, ...t }));
      const totals = byChannel.reduce(
        (t, c) => ({
          chargedPaise: t.chargedPaise + c.chargedPaise,
          messages: t.messages + c.messages,
          units: t.units + c.units,
        }),
        { chargedPaise: 0, messages: 0, units: 0 },
      );
      return {
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        timeZone,
        channelCode: query.channelCode ?? null,
        currency: 'INR',
        totals,
        byChannel,
        daily,
      };
    });
  }
}

function accountNotConfigured(): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED,
    message: 'No billing account is configured for this organization',
  });
}
