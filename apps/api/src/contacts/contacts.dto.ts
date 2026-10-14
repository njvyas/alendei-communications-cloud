import {
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
  CONTACT_IDENTITY_STATUSES,
  CONSENT_EVENT_TYPES,
  type ContactIdentityStatus,
  type ConsentEventType,
} from '@acc/contracts';
import { ListQueryDto } from '../common/http/list-query.dto';

export class ListContactsDto extends ListQueryDto {}

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
