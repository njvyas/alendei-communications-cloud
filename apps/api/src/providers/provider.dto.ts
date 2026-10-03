import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  PROVIDER_CAPABILITY_KEY_PATTERN,
  PROVIDER_CAPABILITY_LIMITS,
  PROVIDER_STATUSES,
} from '@acc/contracts';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ListQueryDto } from '../common/http/list-query.dto';
import { ANY_JSON } from '../openapi/openapi-schemas';

/** Mirrors `providers_name_length` (migration `0018`): 1–200 characters, no surrounding whitespace. */
const PROVIDER_NAME = /^\S(?:[\s\S]{0,198}\S)?$/;
/** Mirrors `providers_adapter_key_format`; whether the key is *registered* is the service's 422. */
const ADAPTER_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** `GET /channels` (`FRONTEND_API_CONTRACT.md` §32a). Pagination only. */
export class ListChannelsQueryDto extends ListQueryDto {}

/** `GET /providers` filters. Both narrow; neither widens anything. */
export class ListProvidersQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsIn(PROVIDER_STATUSES)
  @ApiPropertyOptional({ enum: PROVIDER_STATUSES })
  status?: (typeof PROVIDER_STATUSES)[number];
}

/**
 * `POST /providers`. A provider is created `disabled`; it has no status,
 * health, circuit or credential field to set (ADR-013 F-5, PD-2).
 */
export class CreateProviderDto {
  @IsUUID()
  channelId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(PROVIDER_NAME, { message: 'name must not start or end with whitespace' })
  @ApiProperty({ pattern: PROVIDER_NAME.source })
  name!: string;

  @IsString()
  @Matches(ADAPTER_KEY, {
    message: 'adapterKey must be lower-case letters, digits or underscores, starting with a letter',
  })
  @ApiProperty({ pattern: ADAPTER_KEY.source })
  adapterKey!: string;
}

/** `PATCH /providers/:id`: `name` only (ADR-013, ROADMAP §5b 2.1). */
export class UpdateProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(PROVIDER_NAME, { message: 'name must not start or end with whitespace' })
  @ApiPropertyOptional({ pattern: PROVIDER_NAME.source })
  name?: string;
}

/** One declared, non-secret capability. */
export class ProviderCapabilityDto {
  @IsString()
  @Matches(PROVIDER_CAPABILITY_KEY_PATTERN, {
    message: 'key must be 2-64 lower-case letters, digits or underscores, starting with a letter',
  })
  @ApiProperty({ pattern: PROVIDER_CAPABILITY_KEY_PATTERN.source })
  key!: string;

  /** Any JSON value up to `PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES` serialized. */
  @IsDefined()
  @ApiProperty(ANY_JSON)
  value!: unknown;
}

/** `PUT /providers/:id/capabilities`: the complete replacement set. */
export class ReplaceProviderCapabilitiesDto {
  @IsArray()
  @ArrayMaxSize(PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => ProviderCapabilityDto)
  @ApiProperty({ type: [ProviderCapabilityDto], maxItems: PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES })
  capabilities!: ProviderCapabilityDto[];
}
