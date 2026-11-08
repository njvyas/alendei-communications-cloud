import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ALL_CAMPAIGN_CHANNELS,
  ALL_CAMPAIGN_RECIPIENT_SOURCE_TYPES,
  ALL_CAMPAIGN_SCHEDULE_MODES,
  ALL_CAMPAIGN_STATUSES,
  type CampaignChannel,
  type CampaignRecipientSourceType,
  type CampaignScheduleMode,
  type CampaignStatus,
} from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';

export class ListCampaignsDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsIn(ALL_CAMPAIGN_STATUSES)
  status?: CampaignStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;
}

export class CampaignRecipientSourceDto {
  @IsString()
  @IsIn(ALL_CAMPAIGN_RECIPIENT_SOURCE_TYPES)
  type!: CampaignRecipientSourceType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tag?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(['any', 'all'])
  tagMatchMode?: 'any' | 'all';

  @IsOptional()
  @IsInt()
  @Min(0)
  contactCount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  segmentName?: string;

  @IsOptional()
  @IsBoolean()
  requireOptIn?: boolean;
}

export class CampaignThrottlingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitPerSecond?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttemptsPerRecipient?: number;
}

export class CreateCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsIn(ALL_CAMPAIGN_CHANNELS)
  channel?: CampaignChannel;

  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsUUID()
  templateId!: string;

  @IsOptional()
  @IsObject()
  templateVariables?: Record<string, string>;

  @IsObject()
  @ValidateNested()
  @Type(() => CampaignRecipientSourceDto)
  recipientSource!: CampaignRecipientSourceDto;

  @IsOptional()
  @IsIn(ALL_CAMPAIGN_SCHEDULE_MODES)
  scheduleMode?: CampaignScheduleMode;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignThrottlingDto)
  throttling?: CampaignThrottlingDto;
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsObject()
  templateVariables?: Record<string, string>;

  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignRecipientSourceDto)
  recipientSource?: CampaignRecipientSourceDto;

  @IsOptional()
  @IsIn(ALL_CAMPAIGN_SCHEDULE_MODES)
  scheduleMode?: CampaignScheduleMode;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignThrottlingDto)
  throttling?: CampaignThrottlingDto;
}
