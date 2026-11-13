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

import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiIdempotencyKey, ApiPaged } from '../openapi/openapi-responses';
import {
  JourneyEnrolmentResultSchema,
  JourneyExecutionDetailSchema,
  JourneyExecutionSchema,
  JourneyStatsSchema,
} from '../openapi/openapi-schemas';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { JourneyExecutionsService } from './journey-executions.service';
import {
  EnrolJourneyContactsDto,
  JourneyStatsQueryDto,
  ListJourneyExecutionsDto,
} from './journeys.dto';

const AT_WORKSPACE = 'the target is the workspace resolved from path';

/**
 * Phase 8C PR 8C-2: API enrolment, execution reads, operator cancel and per-node statistics
 * (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §7). Enrolment only creates executions and their
 * unclaimed queue rows: no runner exists (8C-3), so nothing advances, waits or sends.
 */
@ApiTags('journeys')
@Controller('workspaces/:workspaceId/journeys/:journeyId')
export class JourneyExecutionsController {
  constructor(private readonly executions: JourneyExecutionsService) {}

  @Post('enrollments')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Enrol contacts through the API trigger',
    description:
      'The journey must be active and its active version entered by an `api` trigger (`409 JOURNEY_TRIGGER_NOT_API` otherwise). Up to 1,000 distinct contact ids of the workspace. Entry policy is once: a contact that ever entered the journey is `already_enrolled`; an unknown id is `contact_not_found`. Each new execution waits, unclaimed, for the journey runner, which is not built and stays disabled.',
  })
  @ApiData(JourneyEnrolmentResultSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async enrol(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Body() dto: EnrolJourneyContactsDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.executions.enrol(
      requestPrincipal(),
      workspaceId,
      journeyId,
      dto.contactIds,
      idempotencyKey,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  @Get('executions')
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: "List a journey's executions, newest first" })
  @ApiPaged(JourneyExecutionSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async list(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Query() query: ListJourneyExecutionsDto,
  ) {
    const { items, page } = await this.executions.list(requestPrincipal(), workspaceId, journeyId, {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
      status: query.status,
      contactId: query.contactId,
      versionId: query.versionId,
    });
    return { data: items, page };
  }

  @Get('executions/:executionId')
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get one execution with its step history' })
  @ApiData(JourneyExecutionDetailSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Param('executionId', new ParseUUIDPipe()) executionId: string,
  ) {
    return {
      data: await this.executions.get(requestPrincipal(), workspaceId, journeyId, executionId),
    };
  }

  @Post('executions/:executionId/cancel')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'Cancel a live execution (operator)',
    description:
      'Running or waiting → cancelled (operator_cancelled), fenced by state_version. A repeat is a no-op; an execution that ended otherwise is `409 JOURNEY_EXECUTION_ENDED`.',
  })
  @ApiData(JourneyExecutionDetailSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async cancel(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Param('executionId', new ParseUUIDPipe()) executionId: string,
  ) {
    return {
      data: await this.executions.cancel(requestPrincipal(), workspaceId, journeyId, executionId),
    };
  }

  @Get('stats')
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'Per-version execution totals and per-node statistics',
    description:
      'Published and retired versions only; `versionId` narrows to one. Per node: live executions positioned there, and history rows by outcome.',
  })
  @ApiData(JourneyStatsSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async stats(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Query() query: JourneyStatsQueryDto,
  ) {
    return {
      data: await this.executions.stats(
        requestPrincipal(),
        workspaceId,
        journeyId,
        query.versionId,
      ),
    };
  }
}
