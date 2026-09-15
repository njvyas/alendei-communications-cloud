import { IsIn, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import type { ScopeType } from '@acc/contracts';

/**
 * Scope levels a tenant grant may name.
 *
 * `platform` is absent by construction rather than by check: this surface is
 * tenant administration, and a platform grant is made by the bootstrap CLI under
 * a documented elevation (`RBAC.md` §5b). Leaving it unrepresentable in the DTO
 * means the refusal does not depend on a guard remembering to run.
 */
const GRANTABLE_SCOPE_TYPES: readonly ScopeType[] = [
  'reseller',
  'organization',
  'workspace',
  'team',
];

export class CreateAssignmentDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  roleId!: string;

  @IsIn(GRANTABLE_SCOPE_TYPES)
  scopeType!: ScopeType;

  /**
   * Required for every grantable scope type. `user_roles_scope_shape` enforces
   * the same rule at the database; requiring it here turns what would be a
   * constraint violation into a readable `400`.
   */
  @IsUUID()
  scopeId!: string;
}

export class ListAssignmentsQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(GRANTABLE_SCOPE_TYPES)
  scopeType?: ScopeType;

  @IsOptional()
  @ValidateIf((dto: ListAssignmentsQueryDto) => dto.scopeId !== undefined)
  @IsUUID()
  scopeId?: string;
}
