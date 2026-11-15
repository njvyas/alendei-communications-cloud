import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors } from '../openapi/openapi-responses';
import { AutomationControlSchema } from '../openapi/openapi-schemas';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { AutomationControlDto } from './automation-controls.dto';
import { AutomationControlsService } from './automation-controls.service';

const AT_ORG =
  'the target is the request organization (organisation scope, never a workspace grant)';
const NOTE =
  'Requires `campaigns.manage` held at **organization** scope; a workspace-scoped grant is refused (`403`). User sessions only. Enforced again in the database, and serialised against in-flight sends: once this commits, no further automated send is authorised.';

/**
 * Phase 8B PR 8B-3a: organisation-wide automation sending controls (OD-8B3-5). The organisation
 * is the principal's own; there is no organisation parameter.
 */
@ApiTags('automation')
@Controller('automation-controls')
export class AutomationControlsController {
  constructor(private readonly controls: AutomationControlsService) {}

  @Get()
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: "The organization's automation sending controls", description: NOTE })
  @ApiData(AutomationControlSchema)
  @ApiErrors(401, 403, 429)
  async status() {
    return { data: await this.controls.status(requestPrincipal()) };
  }

  @Post('pause')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Pause all automated sending for the organization', description: NOTE })
  @ApiData(AutomationControlSchema)
  @ApiErrors(400, 401, 403, 429)
  async pause(@Body() dto: AutomationControlDto) {
    return { data: await this.controls.apply(requestPrincipal(), 'pause', dto.reason) };
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Resume automated sending for the organization', description: NOTE })
  @ApiData(AutomationControlSchema)
  @ApiErrors(400, 401, 403, 429)
  async resume(@Body() dto: AutomationControlDto) {
    return { data: await this.controls.apply(requestPrincipal(), 'resume', dto.reason) };
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Revoke every outstanding automation capability of the organization',
    description: `${NOTE} Capabilities issued before the revocation instant are void.`,
  })
  @ApiData(AutomationControlSchema)
  @ApiErrors(400, 401, 403, 429)
  async revoke(@Body() dto: AutomationControlDto) {
    return { data: await this.controls.apply(requestPrincipal(), 'revoke', dto.reason) };
  }
}
