import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { PlatformSupportService } from './platform-support.service';
import {
  PlatformSupportAuditSearchQueryDto,
  PlatformSupportDispatchQueryDto,
} from './platform-support.dto';
import {
  PlatformSupportAuditItemSchema,
  PlatformSupportDispatchDiagnosticsSchema,
  PlatformSupportOrgOverviewSchema,
  PlatformSupportRoutingDiagnosticsSchema,
} from './platform-support-schemas';

const PLATFORM_SUPPORT_DIAGNOSTICS =
  'platform support diagnostics and cross-tenant troubleshooting are evaluated at platform scope';

@ApiTags('platform-support')
@Controller('platform/support')
export class PlatformSupportController {
  constructor(private readonly support: PlatformSupportService) {}

  @Get('organizations/:id/overview')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_SUPPORT_READ, {
    target: 'deferred',
    because: PLATFORM_SUPPORT_DIAGNOSTICS,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Inspect organization configuration and hierarchy diagnostics' })
  @ApiData(PlatformSupportOrgOverviewSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async getOverview(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.support.getOrganizationOverview(requestPrincipal(), id);
    return { data };
  }

  @Get('organizations/:id/routing')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_SUPPORT_READ, {
    target: 'deferred',
    because: PLATFORM_SUPPORT_DIAGNOSTICS,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Inspect tenant routing, channel catalogue, and provider assignments' })
  @ApiData(PlatformSupportRoutingDiagnosticsSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async getRouting(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.support.getOrganizationRouting(requestPrincipal(), id);
    return { data };
  }

  @Get('organizations/:id/dispatch')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_SUPPORT_READ, {
    target: 'deferred',
    because: PLATFORM_SUPPORT_DIAGNOSTICS,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Troubleshoot message dispatch queue and inspect recent failures' })
  @ApiData(PlatformSupportDispatchDiagnosticsSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async getDispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PlatformSupportDispatchQueryDto,
  ) {
    const data = await this.support.getOrganizationDispatch(requestPrincipal(), id, query);
    return { data };
  }

  @Get('audit')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_SUPPORT_READ, {
    target: 'deferred',
    because: PLATFORM_SUPPORT_DIAGNOSTICS,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Search audit trail across tenants for platform support' })
  @ApiPaged(PlatformSupportAuditItemSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async searchAudit(@Query() query: PlatformSupportAuditSearchQueryDto) {
    const { data, page } = await this.support.searchAuditLogs(requestPrincipal(), query);
    return { data, page };
  }
}
