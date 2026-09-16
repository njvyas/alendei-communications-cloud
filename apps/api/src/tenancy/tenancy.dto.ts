import { Allow, IsIn, IsOptional } from 'class-validator';

import { ListQueryDto } from '../common/http/list-query.dto';

/** The `workspaces.status` values a caller may filter on. */
const WORKSPACE_STATUSES = ['active', 'archived'] as const;

/**
 * `GET /tenants/workspaces` query (`API.md` §8b).
 *
 * `status` is the one filter the console needs and the only one offered. There
 * is deliberately no free-text search: it would want an index this table does
 * not have, and adding a filter nobody has asked for is how an allow-list stops
 * being one.
 */
export class ListWorkspacesQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(WORKSPACE_STATUSES)
  status?: (typeof WORKSPACE_STATUSES)[number];

  /**
   * The **advisory** organization identifier (`TENANCY.md` §2b, ADR-004).
   *
   * Declared with `@Allow()` rather than a validator, and that is deliberate.
   * It is not a filter and this DTO must not interpret it: `AdvisoryTenantGuard`
   * cross-checks it against the resolved context and refuses the request on a
   * mismatch, before the handler runs. Declaring it merely stops
   * `forbidNonWhitelisted` from rejecting a parameter the platform documents as
   * acceptable — validating it here would move a tenancy decision into a DTO and
   * duplicate the one mechanism ADR-004 exists to centralise.
   */
  @Allow()
  orgId?: unknown;
}
