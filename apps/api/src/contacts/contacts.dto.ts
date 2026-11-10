import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsBoolean,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  AUDIENCE_TAG_MATCH_MODES,
  CONTACT_IDENTITY_STATUSES,
  CONSENT_EVENT_TYPES,
  CUSTOM_FIELD_OPERATORS,
  DUPLICATE_STRATEGIES,
  IMPORT_MODES,
  type AudienceTagMatchMode,
  type ContactIdentityStatus,
  type ConsentEventType,
  type CustomFieldOperator,
  type DuplicateStrategy,
  type ImportMode,
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

export class CustomFieldFilterDto {
  @IsString()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, {
    message:
      'field must start with a letter and contain only alphanumeric characters, underscores or hyphens (max 64 chars)',
  })
  field!: string;

  @IsIn(CUSTOM_FIELD_OPERATORS)
  operator!: CustomFieldOperator;

  @IsOptional()
  value?: string | number | boolean;
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

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldFilterDto)
  customFieldFilters?: CustomFieldFilterDto[];
}

export class ImportContactConsentDto {
  @IsIn(['whatsapp', 'sms', 'email', 'rcs'])
  channelCode!: 'whatsapp' | 'sms' | 'email' | 'rcs';

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  consentType!: string;

  @IsIn(CONSENT_EVENT_TYPES)
  event!: ConsentEventType;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;
}

export class ImportContactRowDto {
  @IsOptional()
  rowNumber?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  email?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImportContactConsentDto)
  consent?: ImportContactConsentDto;
}

export class ImportContactsDto {
  @IsOptional()
  @IsIn(IMPORT_MODES)
  mode?: ImportMode;

  @IsOptional()
  @IsIn(DUPLICATE_STRATEGIES)
  duplicateStrategy?: DuplicateStrategy;

  @IsOptional()
  @IsUUID()
  defaultPhoneChannelId?: string;

  @IsOptional()
  @IsUUID()
  defaultEmailChannelId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportContactRowDto)
  contacts?: ImportContactRowDto[];

  @IsOptional()
  @IsString()
  csv?: string;
}

export class ExportContactsDto {
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json';

  @IsOptional()
  @IsUUID()
  segmentId?: string;

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
  @IsIn(['whatsapp', 'sms', 'email', 'rcs'])
  channel?: 'whatsapp' | 'sms' | 'email' | 'rcs';

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

  @IsOptional()
  @IsString()
  @MaxLength(64)
  consentType?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldFilterDto)
  customFieldFilters?: CustomFieldFilterDto[];
}
