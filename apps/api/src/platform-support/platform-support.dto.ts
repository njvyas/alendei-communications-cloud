import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
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
  readonly limit: number = 20;
}

export class PlatformSupportAuditSearchQueryDto {
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;

  @IsOptional()
  @IsString()
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
  readonly limit: number = 50;
}
