import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CHANNEL_CODES, PAGE_LIMITS, type ChannelCode } from '@acc/contracts';

/** Evidence of a provider receipt on the unknown attempt (Policy U). */
export const UNKNOWN_EVIDENCE_STATES = ['evidenced', 'unevidenced'] as const;
/**
 * Resolution status, derived from the ledger. `pending_approval` and `written_off`
 * arrive with operator resolution (7-6c); until then no item can be in either.
 */
export const UNKNOWN_RESOLUTION_STATUSES = [
  'open',
  'pending_approval',
  'charged',
  'charged_without_cost',
  'written_off',
] as const;

/** At most a year of age filter, in hours. */
const MIN_AGE_HOURS_MAX = 24 * 366;

/** `GET /platform/billing/unknown-outcomes` query (Phase 7 PR 7-6b). */
export class ListUnknownOutcomesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PAGE_LIMITS.MIN)
  @Max(PAGE_LIMITS.MAX)
  @ApiPropertyOptional({ type: 'integer', minimum: PAGE_LIMITS.MIN, maximum: PAGE_LIMITS.MAX })
  limit?: number;

  @IsOptional()
  @IsUUID()
  orgId?: string;

  @IsOptional()
  @IsIn(CHANNEL_CODES)
  channelCode?: ChannelCode;

  @IsOptional()
  @IsIn(UNKNOWN_EVIDENCE_STATES)
  evidence?: (typeof UNKNOWN_EVIDENCE_STATES)[number];

  @IsOptional()
  @IsIn(UNKNOWN_RESOLUTION_STATUSES)
  status?: (typeof UNKNOWN_RESOLUTION_STATUSES)[number];

  /** Only items whose message finished at least this many hours ago. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MIN_AGE_HOURS_MAX)
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: MIN_AGE_HOURS_MAX })
  minAgeHours?: number;
}
