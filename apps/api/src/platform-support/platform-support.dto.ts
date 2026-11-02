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
  MESSAGE_STATUSES,
  type ChannelCode,
  type MessageStatus,
} from '@acc/contracts';

export class PlatformSupportDispatchQueryDto {
  @IsOptional()
  @IsIn(CHANNEL_CODES)
  readonly channel?: ChannelCode;

  @IsOptional()
  @IsIn(MESSAGE_STATUSES)
  readonly status?: MessageStatus;

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
