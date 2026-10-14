import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { CreateSuppressionDto, LiftSuppressionDto, ListSuppressionsDto } from './suppressions.dto';
import { SuppressionsService } from './suppressions.service';

const AT_ORG = 'the target is the request organization';

@ApiTags('suppressions')
@Controller('suppressions')
export class SuppressionsController {
  constructor(private readonly suppressions: SuppressionsService) {}

  @Get()
  @RequiresPermission(PERMISSIONS.SUPPRESSIONS_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List suppressions in an organization' })
  @ApiErrors(400, 401, 403, 404, 429)
  async list(@Query() query: ListSuppressionsDto) {
    const { items, page } = await this.suppressions.list(requestPrincipal(), {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
      channelId: query.channelId,
      status: query.status,
    });
    return { data: items, page };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.SUPPRESSIONS_MANAGE, { target: 'deferred', because: AT_ORG })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create a suppression' })
  @ApiErrors(400, 401, 403, 409, 422, 429)
  async create(
    @Body() dto: CreateSuppressionDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.suppressions.create(requestPrincipal(), dto, idempotencyKey);
    response.status(outcome.status);
    return outcome.body;
  }

  @Get(':suppressionId')
  @RequiresPermission(PERMISSIONS.SUPPRESSIONS_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a suppression by id' })
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('suppressionId', new ParseUUIDPipe()) suppressionId: string) {
    return { data: await this.suppressions.get(requestPrincipal(), suppressionId) };
  }

  @Post(':suppressionId/lift')
  @RequiresPermission(PERMISSIONS.SUPPRESSIONS_MANAGE, { target: 'deferred', because: AT_ORG })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Lift an active suppression' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async lift(
    @Param('suppressionId', new ParseUUIDPipe()) suppressionId: string,
    @Body() dto: LiftSuppressionDto,
  ) {
    return { data: await this.suppressions.lift(requestPrincipal(), suppressionId, dto) };
  }
}
