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
  CreateSegmentDto,
  ListSegmentsDto,
  PreviewSegmentDto,
  UpdateSegmentDto,
} from './segments.dto';
import { SegmentsService } from './segments.service';

const AT_WORKSPACE = 'the target is the workspace resolved from path';

@ApiTags('segments')
@Controller('workspaces/:workspaceId/segments')
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  @Post()
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create a saved segment in a workspace' })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: CreateSegmentDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.segments.create(
      requestPrincipal(),
      workspaceId,
      dto,
      idempotencyKey,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  @Get()
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List saved segments in a workspace' })
  @ApiErrors(400, 401, 403, 404, 429)
  async list(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: ListSegmentsDto,
  ) {
    return this.segments.list(requestPrincipal(), workspaceId, {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
    });
  }

  @Get(':segmentId')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a saved segment by ID' })
  @ApiErrors(400, 401, 403, 404, 429)
  async get(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('segmentId', new ParseUUIDPipe()) segmentId: string,
  ) {
    const data = await this.segments.get(requestPrincipal(), workspaceId, segmentId);
    return { data };
  }

  @Patch(':segmentId')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a saved segment' })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async update(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('segmentId', new ParseUUIDPipe()) segmentId: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    const data = await this.segments.update(requestPrincipal(), workspaceId, segmentId, dto);
    return { data };
  }

  @Delete(':segmentId')
  @RequiresPermission(PERMISSIONS.CONTACTS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Delete a saved segment' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async delete(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('segmentId', new ParseUUIDPipe()) segmentId: string,
  ): Promise<void> {
    await this.segments.delete(requestPrincipal(), workspaceId, segmentId);
  }

  @Post(':segmentId/preview')
  @RequiresPermission(PERMISSIONS.CONTACTS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Preview audience members of a saved segment' })
  @ApiErrors(400, 401, 403, 404, 422, 429)
  async preview(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('segmentId', new ParseUUIDPipe()) segmentId: string,
    @Body() dto: PreviewSegmentDto,
  ) {
    return this.segments.preview(requestPrincipal(), workspaceId, segmentId, dto);
  }
}
