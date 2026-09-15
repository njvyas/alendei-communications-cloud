import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ALL_PERMISSION_KEYS, type ScopeType } from '@acc/contracts';

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
  allowedScopeTypes!: ScopeType[];

  /**
   * Validated against the catalogue here so an unknown key is a `400`. Whether
   * the *actor* may confer each one is a separate, authorization question the
   * service asks through `AuthorizationService` — this is only spelling.
   */
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsIn(ALL_PERMISSION_KEYS, { each: true })
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
  allowedScopeTypes?: ScopeType[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsIn(ALL_PERMISSION_KEYS, { each: true })
  permissions?: string[];
}
