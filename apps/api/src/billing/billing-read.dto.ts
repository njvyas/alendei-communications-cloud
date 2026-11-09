import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { CHANNEL_CODES, type ChannelCode } from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';

/**
 * The ledger entry types a tenant can see (Phase 7 PR 7-6a; baseline §7.1). The
 * database admits only these to a tenant (`usage_ledger_tenant_select`, 0055);
 * this list only validates the filter.
 */
export const TENANT_LEDGER_ENTRY_TYPES = [
  'reservation',
  'reservation_release',
  'customer_charge',
] as const;
export type TenantLedgerEntryType = (typeof TENANT_LEDGER_ENTRY_TYPES)[number];

/** At most this many days per usage report. */
export const BILLING_USAGE_MAX_DAYS = 92;

/**
 * `GET /billing/ledger` query. Every filter narrows within the request
 * organization; none is an isolation mechanism (the tenant RLS policy is).
 */
export class ListBillingLedgerQueryDto extends ListQueryDto {
  /** Inclusive lower bound on `occurredAt`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Exclusive upper bound on `occurredAt`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsIn(TENANT_LEDGER_ENTRY_TYPES)
  entryType?: TenantLedgerEntryType;

  @IsOptional()
  @IsUUID()
  messageId?: string;
}

/** `GET /billing/usage` query: the request organization's charges in [from, to). */
export class BillingUsageQueryDto {
  /** Inclusive lower bound on the charge's `occurredAt`. */
  @Type(() => Date)
  @IsDate()
  from!: Date;

  /** Exclusive upper bound. At most `BILLING_USAGE_MAX_DAYS` after `from`. */
  @Type(() => Date)
  @IsDate()
  to!: Date;

  @IsOptional()
  @IsIn(CHANNEL_CODES)
  channelCode?: ChannelCode;

  /** IANA time zone for the daily breakdown, for example `Asia/Kolkata`. Defaults to `UTC`. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z]+(?:[/_+-][A-Za-z0-9_+-]+)*$/)
  timeZone?: string;
}
