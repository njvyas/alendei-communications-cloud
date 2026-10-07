import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { API_SURFACE_PERMISSION_KEYS, type ScopeType } from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The scope levels a *tenant* role may admit. Platform and reseller are not a tenant's to claim. */
const TENANT_SCOPE_TYPES: readonly ScopeType[] = ['organization', 'workspace', 'team'];

/**
 * `roles_key_format` in the schema is the authority; this mirrors it so a bad
 * key is a `400` with a readable message rather than a constraint violation.
 */
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export class CreateRoleDto {
  @IsString()
  @Matches(ROLE_KEY_PATTERN, {
    message: 'key must be lower snake_case, 3-64 characters, starting with a letter',
  })
  @ApiProperty({ pattern: ROLE_KEY_PATTERN.source })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(TENANT_SCOPE_TYPES, { each: true })
  @ApiProperty({ enum: TENANT_SCOPE_TYPES, isArray: true })
  allowedScopeTypes!: ScopeType[];

  /**
   * Validated against the catalogue here so an unknown key is a `400`. Whether
   * the *actor* may confer each one is a separate, authorization question the
   * service asks through `AuthorizationService` — this is only spelling.
   *
   * The API surface excludes the inert tenant-content keys (ADR-015 follow-up
   * decision 6: no API behaviour); Phase 3.1 changes
   * `API_SURFACE_PERMISSION_KEYS`.
   */
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsIn(API_SURFACE_PERMISSION_KEYS, { each: true })
  @ApiProperty({ enum: API_SURFACE_PERMISSION_KEYS, isArray: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(TENANT_SCOPE_TYPES, { each: true })
  @ApiPropertyOptional({ enum: TENANT_SCOPE_TYPES, isArray: true })
  allowedScopeTypes?: ScopeType[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsIn(API_SURFACE_PERMISSION_KEYS, { each: true })
  @ApiPropertyOptional({ enum: API_SURFACE_PERMISSION_KEYS, isArray: true })
  permissions?: string[];
}

/**
 * `GET /roles` query (`API.md` §8b).
 *
 * Filters are allow-listed by being *fields on this class*: `whitelist` plus
 * `forbidNonWhitelisted` mean an unrecognised parameter is refused rather than
 * ignored, so there is no generic filter language to constrain and no column
 * name a caller can reach.
 */
export class ListRolesQueryDto extends ListQueryDto {
  /** `true` for the seeded roles, `false` for tenant-composed ones. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isSystemRole?: boolean;

  /** Exact match on the role key; there is deliberately no prefix or substring search. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  key?: string;
}

/** `GET /permissions` query. */
export class ListPermissionsQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  domain?: string;
}
