import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { CHANNEL_CODES, type ChannelCode } from '@acc/contracts';

/**
 * `GET /usage/messages` query. The organization is the request organization;
 * every filter narrows within it and none is an isolation mechanism.
 */
export class MessageUsageQueryDto {
  /** Inclusive lower bound on `createdAt`. */
  @Type(() => Date)
  @IsDate()
  from!: Date;

  /** Exclusive upper bound on `createdAt`. At most `MESSAGE_USAGE_MAX_DAYS` after `from`. */
  @Type(() => Date)
  @IsDate()
  to!: Date;

  @IsOptional()
  @IsUUID()
  workspaceId?: string;

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
