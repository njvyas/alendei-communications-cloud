import {
  Allow,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ListQueryDto } from '../common/http/list-query.dto';

/** The `workspace_status` values; teams reuse them (ADR-012 F-6). */
export const SCOPE_STATUSES = ['active', 'archived'] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

/** Lower-case letters, digits and hyphens; starts with a letter or digit; 2–63 characters. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * `orgId` on the workspace list and create is **advisory** (`API.md` §3a,
 * `FRONTEND_API_CONTRACT.md` §31b): declared with `@Allow()` so
 * `forbidNonWhitelisted` does not reject it, and cross-checked against the
 * resolved context by `AdvisoryTenantGuard` — never interpreted here. The team
 * routes (§31c) declare no `orgId`, so there it is an unknown field: `400`.
 */

/** `GET /workspaces` (`FRONTEND_API_CONTRACT.md` §31b). */
export class ListWorkspacesDto extends ListQueryDto {
  @IsOptional()
  @IsIn(SCOPE_STATUSES)
  status?: ScopeStatus;

  @Allow()
  orgId?: unknown;
}

/** `POST /workspaces`. The organization is the selected one, never the body's. */
export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @Matches(SLUG, { message: 'slug must be 2-63 lower-case letters, digits or hyphens' })
  slug!: string;

  @Allow()
  orgId?: unknown;
}

/** `PATCH /workspaces/:id`. `slug`, `isDefault`, `status` and `orgId` are immutable here: `400`. */
export class UpdateWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}

/** `GET /teams` (`FRONTEND_API_CONTRACT.md` §31c). */
export class ListTeamsDto extends ListQueryDto {
  /** A target, not a context: authorized at that workspace (`404` if not visible to the tenant). */
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsIn(SCOPE_STATUSES)
  status?: ScopeStatus;
}

/** `POST /teams`. The organization is derived from the workspace's own row. */
export class CreateTeamDto {
  @IsUUID()
  workspaceId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}

/** `PATCH /teams/:id`. `workspaceId`, `orgId` and `status` are immutable here: `400`. */
export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}
