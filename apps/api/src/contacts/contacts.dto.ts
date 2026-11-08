import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsBoolean,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  AUDIENCE_TAG_MATCH_MODES,
  CONTACT_IDENTITY_STATUSES,
  CONSENT_EVENT_TYPES,
  type AudienceTagMatchMode,
  type ContactIdentityStatus,
  type ConsentEventType,
} from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';

export class ListContactsDto extends ListQueryDto {}

export class ListContactActivitiesDto extends ListQueryDto {
  @IsOptional()
  @IsIn(['all', 'message', 'consent', 'identity', 'profile'])
  category?: 'all' | 'message' | 'consent' | 'identity' | 'profile';
}

export class CreateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string | null;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreateContactIdentityDto {
  @IsUUID()
  channelId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  rawAddress!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateContactIdentityDto {
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsIn(CONTACT_IDENTITY_STATUSES)
  status?: ContactIdentityStatus;
}

export class CreateConsentEventDto {
  @IsUUID()
  channelId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  consentType!: string;

  @IsIn(CONSENT_EVENT_TYPES)
  event!: ConsentEventType;

  @IsISO8601()
  occurredAt!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  source!: string;
}

export class GetEffectiveConsentDto {
  @IsUUID()
  channelId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  consentType!: string;
}

export class ResolveAudienceDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Array.isArray(value)) {
      return value.map((s) => String(s).trim()).filter(Boolean);
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(AUDIENCE_TAG_MATCH_MODES)
  tagMatchMode?: AudienceTagMatchMode;

  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  channel?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  consentType?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  requireOptIn?: boolean;
}
