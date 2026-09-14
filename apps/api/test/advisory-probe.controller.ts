import { Controller, Get, Param, Post } from '@nestjs/common';

import { AdvisoryTenantIds } from '../src/tenancy/advisory-identifier';

/**
 * Routes that exist only to exercise `AdvisoryTenantGuard` over real HTTP.
 *
 * The guard is registered globally and is deliberately built ahead of its
 * consumers: Phase 1B.3's production surface accepts an advisory identifier at
 * organization level only, while the mechanism has to be correct at all three
 * levels before Phase 1B.5/1B.6 hand it workspace- and team-scoped endpoints.
 *
 * Nothing here is a stand-in for the guard. The guard, `AuthGuard` in front of
 * it, the exception filter behind it and the Express request parsing beneath it
 * are all the real ones — only the handler the guard protects belongs to the
 * test, and every handler is a no-op, so any non-200 response came from the
 * mechanism under test and from nowhere else.
 *
 * It also stands as the proof the mechanism is reusable by a future handler:
 * each route below declares its identifiers and writes no check of its own.
 */
@Controller('test-advisory')
export class AdvisoryProbeController {
  @Get('organization')
  @AdvisoryTenantIds({ level: 'organization', source: 'query', key: 'orgId' })
  organization() {
    return { reached: true };
  }

  @Get('organization-required')
  @AdvisoryTenantIds({ level: 'organization', source: 'query', key: 'orgId', required: true })
  organizationRequired() {
    return { reached: true };
  }

  @Get('workspace')
  @AdvisoryTenantIds({ level: 'workspace', source: 'query', key: 'workspaceId' })
  workspace() {
    return { reached: true };
  }

  @Get('team')
  @AdvisoryTenantIds({ level: 'team', source: 'query', key: 'teamId' })
  team() {
    return { reached: true };
  }

  /** Several identifiers on one route, as a real nested resource would have. */
  @Get('combined')
  @AdvisoryTenantIds(
    { level: 'organization', source: 'query', key: 'orgId' },
    { level: 'workspace', source: 'query', key: 'workspaceId' },
    { level: 'team', source: 'query', key: 'teamId' },
  )
  combined() {
    return { reached: true };
  }

  /** A path segment, the form most endpoints will actually use. */
  @Get('path/:orgId')
  @AdvisoryTenantIds({ level: 'organization', source: 'param', key: 'orgId' })
  path(@Param('orgId') _orgId: string) {
    return { reached: true };
  }

  /** A body field, for the write endpoints Phase 1B.6 adds. */
  @Post('body')
  @AdvisoryTenantIds({ level: 'organization', source: 'body', key: 'orgId' })
  body() {
    return { reached: true };
  }

  /** An undeclared identifier is not a tenant identifier to this mechanism. */
  @Get('undeclared')
  undeclared() {
    return { reached: true };
  }
}
