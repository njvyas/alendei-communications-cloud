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
import {
  CreateTemplateDto,
  ListTemplatesDto,
  SimulateApprovalDto,
  UpdateTemplateDto,
} from './templates.dto';
import { TemplatesService } from './templates.service';

const AT_ORG = 'the target is the request organization';

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequiresPermission(PERMISSIONS.TEMPLATES_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List templates in an organization' })
  @ApiErrors(400, 401, 403, 404, 429)
  async list(@Query() query: ListTemplatesDto) {
    const { items, page } = await this.templates.list(requestPrincipal(), {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
      channelId: query.channelId,
      approvalStatus: query.approvalStatus,
    });
    return { data: items, page };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.TEMPLATES_MANAGE, { target: 'deferred', because: AT_ORG })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create a template' })
  @ApiErrors(400, 401, 403, 409, 422, 429)
  async create(
    @Body() dto: CreateTemplateDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.templates.create(requestPrincipal(), dto, idempotencyKey);
    response.status(outcome.status);
    return outcome.body;
  }

  @Get(':templateId')
  @RequiresPermission(PERMISSIONS.TEMPLATES_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a template by id' })
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('templateId', new ParseUUIDPipe()) templateId: string) {
    return { data: await this.templates.get(requestPrincipal(), templateId) };
  }

  @Patch(':templateId')
  @RequiresPermission(PERMISSIONS.TEMPLATES_MANAGE, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a template' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async update(
    @Param('templateId', new ParseUUIDPipe()) templateId: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return { data: await this.templates.update(requestPrincipal(), templateId, dto) };
  }

  @Post(':templateId/simulate-approval')
  @RequiresPermission(PERMISSIONS.TEMPLATES_MANAGE, { target: 'deferred', because: AT_ORG })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Simulate approval state change for a template' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async simulateApproval(
    @Param('templateId', new ParseUUIDPipe()) templateId: string,
    @Body() dto: SimulateApprovalDto,
  ) {
    return {
      data: await this.templates.simulateApproval(requestPrincipal(), templateId, dto),
    };
  }

  @Delete(':templateId')
  @RequiresPermission(PERMISSIONS.TEMPLATES_MANAGE, { target: 'deferred', because: AT_ORG })
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Delete (soft) a template' })
  @ApiErrors(400, 401, 403, 404, 429)
  async delete(@Param('templateId', new ParseUUIDPipe()) templateId: string) {
    await this.templates.delete(requestPrincipal(), templateId);
  }
}
