import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiErrors, ApiIdempotencyKey } from '../openapi/openapi-responses';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { CreateCampaignDto, ListCampaignsDto, UpdateCampaignDto } from './campaigns.dto';
import { CampaignsService } from './campaigns.service';

const AT_WORKSPACE = 'the target is the workspace resolved from path';

@ApiTags('campaigns')
@Controller('workspaces/:workspaceId/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List campaigns in a workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async list(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: ListCampaignsDto,
  ) {
    const { items, page } = await this.campaigns.list(requestPrincipal(), workspaceId, {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
      channel: query.channel,
      status: query.status,
      query: query.query,
    });
    return { data: items, page };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create a campaign in a workspace' })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: CreateCampaignDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.campaigns.create(
      requestPrincipal(),
      workspaceId,
      dto,
      idempotencyKey,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  @Get(':campaignId')
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a campaign by id' })
  @ApiErrors(400, 401, 403, 404, 429)
  async get(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ) {
    return { data: await this.campaigns.get(requestPrincipal(), workspaceId, campaignId) };
  }

  @Patch(':campaignId')
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a campaign' })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async update(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return {
      data: await this.campaigns.update(requestPrincipal(), workspaceId, campaignId, dto),
    };
  }

  @Delete(':campaignId')
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Delete a campaign' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async delete(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ) {
    return this.campaigns.delete(requestPrincipal(), workspaceId, campaignId);
  }

  @Post(':campaignId/dispatch')
  @RequiresPermission(PERMISSIONS.CAMPAIGNS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Dispatch a campaign' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async dispatch(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('campaignId', new ParseUUIDPipe()) campaignId: string,
  ) {
    return this.campaigns.dispatch(requestPrincipal(), workspaceId, campaignId);
  }
}
