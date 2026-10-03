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
  ValidateIf,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  PROVIDER_CAPABILITY_KEY_PATTERN,
  PROVIDER_CAPABILITY_LIMITS,
  PROVIDER_HEALTH_OVERRIDE_REASON_MAX,
  PROVIDER_HEALTH_STATES,
  PROVIDER_STATUSES,
  SIMULATOR_BEHAVIORS,
  SIMULATOR_HEALTH_BEHAVIORS,
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

/**
 * `POST /providers/:id/test-send` (Phase 2.2). The caller chooses only the
 * simulator behaviour: the target is the provider in the path, its adapter comes
 * from the catalogue row, and the payload is synthetic. No adapter key,
 * recipient, content or credential is accepted.
 */
export class ProviderTestSendDto {
  @IsIn(SIMULATOR_BEHAVIORS)
  @ApiProperty({ enum: SIMULATOR_BEHAVIORS })
  behavior!: (typeof SIMULATOR_BEHAVIORS)[number];
}

/**
 * `POST /providers/:id/health-check` (Phase 2.3). The caller chooses only the
 * simulator's health answer; the adapter comes from the catalogue row.
 */
export class ProviderHealthCheckDto {
  @IsIn(SIMULATOR_HEALTH_BEHAVIORS)
  @ApiProperty({ enum: SIMULATOR_HEALTH_BEHAVIORS })
  behavior!: (typeof SIMULATOR_HEALTH_BEHAVIORS)[number];
}

/**
 * `POST /providers/:id/health` (Phase 2.3, `PROVIDER_ADAPTER.md` §5d): pin
 * health to a state, or `null` to return to automatic derivation. The field is
 * required — an absent `override` is a `400`, never a silent clear. No circuit
 * field exists: the circuit is not manually controllable.
 */
export class ProviderHealthOverrideDto {
  @ValidateIf((_o, value) => value !== null)
  @IsIn(PROVIDER_HEALTH_STATES)
  // OpenAPI 3.0: a nullable enum must list null among its values.
  @ApiProperty({ enum: [...PROVIDER_HEALTH_STATES, null], nullable: true })
  override!: (typeof PROVIDER_HEALTH_STATES)[number] | null;

  @IsOptional()
  @IsString()
  @MaxLength(PROVIDER_HEALTH_OVERRIDE_REASON_MAX)
  @ApiPropertyOptional({ maxLength: PROVIDER_HEALTH_OVERRIDE_REASON_MAX })
  reason?: string;
}
