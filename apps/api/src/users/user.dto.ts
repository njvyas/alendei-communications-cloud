import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import type { ScopeType } from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';

/** The three states `user_status` admits (`DATABASE.md` §2, `RBAC.md` §5a.1). */
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Scope levels an initial grant may name — the same four `CreateAssignmentDto`
 * admits, and for the same reason: `platform` is made by the bootstrap CLI under
 * a documented elevation (`RBAC.md` §5b), so leaving it unrepresentable means
 * the refusal does not depend on a guard remembering to run.
 */
const GRANTABLE_SCOPE_TYPES: readonly ScopeType[] = [
  'reseller',
  'organization',
  'workspace',
  'team',
];

/**
 * The initial role a created user receives.
 *
 * **Required, not optional** — and that is a property of the data model rather
 * than a product preference. `users` carries no tenant column: a user's
 * organization *is* the set of grants it holds (`TENANCY.md` §1). A user created
 * with no grant is therefore invisible to the administrator who created it, to
 * `GET /users`, and to the `users_select` policy — and the only trace of it
 * would be a `409` the next time someone tried the same address. Creating one
 * would not be a lean default, it would be a leak.
 */
export class InitialRoleDto {
  @IsUUID()
  roleId!: string;

  @IsIn(GRANTABLE_SCOPE_TYPES)
  scopeType!: ScopeType;

  /**
   * Required for every grantable scope type, exactly as on
   * `CreateAssignmentDto`: `user_roles_scope_shape` enforces the same rule at
   * the database, and requiring it here turns a constraint violation into a
   * readable `400`.
   */
  @IsUUID()
  scopeId!: string;
}

export class CreateUserDto {
  /**
   * The login identity. Stored as supplied and compared case-insensitively —
   * `users_email_key` is a unique index on `lower(email)`, so `A@x.com` and
   * `a@x.com` are one identity.
   */
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  /**
   * E.164. Optional, and the only profile attribute the schema has beyond the
   * identity itself.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be in E.164 format, e.g. +919876543210' })
  phone?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => InitialRoleDto)
  initialRole!: InitialRoleDto;
}

/**
 * `PATCH /users/:id` (`API.md` §3d).
 *
 * The allow-list is the security boundary and it is deliberately one field
 * long. `status`, `email`, roles, scopes and every credential column are absent
 * rather than rejected by a check: the global pipe runs with
 * `forbidNonWhitelisted`, so naming one is a `400` and there is no path by which
 * it could reach persistence. Lifecycle is `POST /users/:id/disable` and
 * `/reactivate`, authorization is `/role-assignments`, and neither is reachable
 * from here.
 */
export class UpdateUserDto {
  /** `null` clears the number; omitting the property leaves it unchanged. */
  @IsOptional()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be in E.164 format, e.g. +919876543210' })
  phone?: string | null;
}

/** `GET /users` query (`API.md` §8b). */
export class ListUsersQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;

  /**
   * Exact identity lookup, case-insensitive. Not a search: there is no prefix,
   * substring or wildcard form, and it narrows within the organization's own
   * membership rather than reaching across it. Free-text search stays deferred
   * (`FRONTEND_API_CONTRACT.md` §16).
   */
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;
}
