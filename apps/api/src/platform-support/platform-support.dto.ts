import { Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CHANNEL_CODES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_STATUSES,
  type ChannelCode,
  type MessageDeliveryStatus,
  type MessageStatus,
} from '@acc/contracts';

export class PlatformSupportDispatchQueryDto {
  @IsOptional()
  @IsIn(CHANNEL_CODES)
  readonly channel?: ChannelCode;

  @IsOptional()
  @IsIn(MESSAGE_STATUSES)
  readonly status?: MessageStatus;

  /**
   * Phase 5.0 (migration 0049): only messages with exactly this delivery status; messages
   * with none (not tracked) never match. Without `status`, the default troubleshooting
   * status set is not applied. The database function validates the same closed list.
   */
  @IsOptional()
  @IsIn(MESSAGE_DELIVERY_STATUSES)
  readonly deliveryStatus?: MessageDeliveryStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  readonly limit?: number;
}

export class PlatformSupportAuditSearchQueryDto {
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;

  /** An audit action name (`domain.verb`); recorded verbatim in the diagnostic-read audit row. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  readonly action?: string;

  @IsOptional()
  @IsUUID()
  readonly actorUserId?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  readonly since?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  readonly until?: Date;

  @IsOptional()
  @IsString()
  readonly cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly limit?: number;
}
