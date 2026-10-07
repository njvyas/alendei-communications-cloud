import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { API_SURFACE_PERMISSION_KEYS, type ScopeType } from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The scope levels an API key may bind to.
 *
 * **Two, and this is the existing rule rather than a new one.** `api_keys` has
 * carried `org_id NOT NULL` and a nullable `workspace_id` since migration
 * `0000`, and `AuthGuard` derives the key's grant scope as "its workspace when
 * it has one, otherwise its organization". There is no column in which a
 * reseller, team or platform binding could be stored, and `RBAC.md` §5c is
 * explicit that a key is never `platform`-scoped — so the control plane must not
 * accept a binding the credential path cannot express.
 *
 * Leaving the other three out of the DTO means the refusal is structural: a
 * `platform`-bound key is unrepresentable in a request rather than rejected by a
 * guard that has to remember to run.
 */
export const API_KEY_SCOPE_TYPES = ['organization', 'workspace'] as const;
export type ApiKeyScopeType = (typeof API_KEY_SCOPE_TYPES)[number];

/** Derived lifecycle states (`API.md` §3e). None of these is a stored column. */
export const API_KEY_STATUSES = ['active', 'expired', 'revoked'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

export class CreateApiKeyDto {
  /** Operator-facing label. The only free text on the resource. */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(API_KEY_SCOPE_TYPES)
  scopeType!: ApiKeyScopeType;

  /**
   * The organization or workspace the key binds to, depending on `scopeType`.
   *
   * Required for both. It is resolved and authorized through
   * `AuthorizationService` against the database's own ancestry, never trusted
   * as a tenant identifier (ADR-005 D-5) — so naming another tenant's workspace
   * is a `404`, not a binding.
   */
  @IsUUID()
  scopeId!: string;

  /**
   * The permission keys this key may exercise, as a **request** rather than a
   * grant.
   *
   * What the key actually gets is this set intersected with what its creator
   * holds at the binding scope, recomputed on every request (`RBAC.md` §5c).
   * Creation additionally refuses a key that asks for more than the creator
   * holds *there*, so the caller gets a named refusal instead of a key that
   * silently does less than it says.
   *
   * Validated against the catalogue: an unknown key could never be intersected
   * into anything, so accepting one would only produce a dead scope string.
   * The API surface excludes the inert tenant-content keys (ADR-015 follow-up
   * decision 6); Phase 3.1 changes `API_SURFACE_PERMISSION_KEYS`.
   */
  @IsArray()
  @ArrayMaxSize(64)
  @ArrayUnique()
  @IsIn(API_SURFACE_PERMISSION_KEYS as readonly string[], { each: true })
  @ApiProperty({ enum: API_SURFACE_PERMISSION_KEYS, isArray: true })
  scopes!: string[];

  /**
   * Optional expiry. `null` or omitted means the key does not expire.
   *
   * Must be in the future — a key created already expired is never usable, so
   * accepting one would only produce a confusing dead credential. Enforced in
   * the service against the database clock rather than here, so it cannot be
   * defeated by client skew.
   */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date | null;
}

/** `GET /api-keys` query (`API.md` §8b). */
export class ListApiKeysQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(API_KEY_STATUSES)
  status?: ApiKeyStatus;

  @IsOptional()
  @IsIn(API_KEY_SCOPE_TYPES)
  scopeType?: ApiKeyScopeType;

  @IsOptional()
  @IsUUID()
  scopeId?: string;

  /** Exact name match. Not a search — no prefix, substring or wildcard form. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^[^%_]*$/, { message: 'name must not contain wildcard characters' })
  name?: string;
}

export type { ScopeType };
