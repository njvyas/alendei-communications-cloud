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
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { PERMISSIONS, type JourneyLifecycleAction } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import {
  ApiData,
  ApiEmpty,
  ApiErrors,
  ApiIdempotencyKey,
  ApiPaged,
} from '../openapi/openapi-responses';
import {
  JourneyGraphValidationReportSchema,
  JourneySchema,
  JourneyVersionSchema,
  JourneyVersionSummarySchema,
} from '../openapi/openapi-schemas';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import {
  CreateJourneyDto,
  ListJourneysDto,
  PublishJourneyVersionDto,
  ReplaceJourneyGraphDto,
  UpdateJourneyDto,
} from './journeys.dto';
import { JourneyLifecycleService } from './journey-lifecycle.service';
import { JourneysService } from './journeys.service';

const AT_WORKSPACE = 'the target is the workspace resolved from path';

const LIFECYCLE_NOTE =
  'Conditional on the current status; a repeat in the target state is a no-op (`200`, nothing written). Nothing runs: the journey runner and trigger processing are not built (8C-3/8C-4), and sends stay disabled.';
const RUNNABLE_NOTE =
  'Also requires `messages.send` at the workspace, refuses a version with a `send_message` node (`400 JOURNEY_SEND_DISABLED`) and re-validates the graph (`422 JOURNEY_GRAPH_INVALID`).';

/**
 * Phase 8C PR 8C-1: journey definitions (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §7), and the
 * 8C-2 lifecycle routes (activate, pause, resume, archive). Workspace-scoped, as campaigns
 * are. No route here runs or sends anything.
 */
@ApiTags('journeys')
@Controller('workspaces/:workspaceId/journeys')
export class JourneysController {
  constructor(
    private readonly journeys: JourneysService,
    private readonly lifecycle: JourneyLifecycleService,
  ) {}

  @Get()
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List journeys in a workspace' })
  @ApiPaged(JourneySchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async list(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: ListJourneysDto,
  ) {
    const { items, page } = await this.journeys.list(requestPrincipal(), workspaceId, {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
      status: query.status,
      query: query.query,
    });
    return { data: items, page };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({ summary: 'Create a journey (version 1 as a draft)' })
  @ApiData(JourneySchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() dto: CreateJourneyDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.journeys.create(
      requestPrincipal(),
      workspaceId,
      dto,
      idempotencyKey,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  @Get(':journeyId')
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a journey' })
  @ApiData(JourneySchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
  ) {
    return { data: await this.journeys.get(requestPrincipal(), workspaceId, journeyId) };
  }

  @Patch(':journeyId')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Rename or describe a journey' })
  @ApiData(JourneySchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async update(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Body() dto: UpdateJourneyDto,
  ) {
    return {
      data: await this.journeys.update(requestPrincipal(), workspaceId, journeyId, dto),
    };
  }

  @Delete(':journeyId')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Delete a draft or archived journey (soft delete)' })
  @ApiEmpty()
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async delete(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
  ): Promise<void> {
    await this.journeys.delete(requestPrincipal(), workspaceId, journeyId);
  }

  @Get(':journeyId/versions')
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: "List a journey's versions, newest first" })
  @ApiData(JourneyVersionSummarySchema, { isArray: true })
  @ApiErrors(400, 401, 403, 404, 429)
  async listVersions(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
  ) {
    return {
      data: await this.journeys.listVersions(requestPrincipal(), workspaceId, journeyId),
    };
  }

  @Post(':journeyId/versions')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({ summary: 'Create a draft version from the latest published version' })
  @ApiData(JourneyVersionSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async createVersion(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.journeys.createVersion(
      requestPrincipal(),
      workspaceId,
      journeyId,
      idempotencyKey,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  @Get(':journeyId/versions/:versionId')
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a journey version with its graph' })
  @ApiData(JourneyVersionSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async getVersion(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
  ) {
    return {
      data: await this.journeys.getVersion(requestPrincipal(), workspaceId, journeyId, versionId),
    };
  }

  @Put(':journeyId/versions/:versionId/graph')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: "Replace a draft version's graph",
    description:
      "Replace semantics, so a retry converges; no Idempotency-Key. `expectedGraphSha256` must equal the draft's current hash (`409 JOURNEY_GRAPH_CONFLICT` otherwise). A published version is `409 JOURNEY_VERSION_IMMUTABLE`. A draft may be saved while invalid; only a non-object, oversized or non-v1 graph is refused (`422 JOURNEY_GRAPH_INVALID`).",
  })
  @ApiData(JourneyVersionSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async replaceGraph(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body() dto: ReplaceJourneyGraphDto,
  ) {
    return {
      data: await this.journeys.replaceGraph(
        requestPrincipal(),
        workspaceId,
        journeyId,
        versionId,
        dto.graph,
        dto.expectedGraphSha256,
      ),
    };
  }

  @Post(':journeyId/versions/:versionId/validate')
  @RequiresPermission(PERMISSIONS.JOURNEYS_READ, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Validate a journey version (writes nothing)' })
  @ApiData(JourneyGraphValidationReportSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async validate(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
  ) {
    return {
      data: await this.journeys.validateVersion(
        requestPrincipal(),
        workspaceId,
        journeyId,
        versionId,
      ),
    };
  }

  @Post(':journeyId/versions/:versionId/publish')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Publish (freeze) a draft version; activates nothing',
    description:
      'The graph must equal `expectedGraphSha256` and validate fully (`422 JOURNEY_GRAPH_INVALID` with the report otherwise). Publication makes the version immutable. It does not activate the journey.',
  })
  @ApiData(JourneyVersionSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async publish(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body() dto: PublishJourneyVersionDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.journeys.publish(
      requestPrincipal(),
      workspaceId,
      journeyId,
      versionId,
      dto.expectedGraphSha256,
      idempotencyKey,
    );
    response.status(outcome.status);
    return outcome.body;
  }

  // --- 8C-2 lifecycle ------------------------------------------------------------------------

  private lifecycleRoute(workspaceId: string, journeyId: string, action: JourneyLifecycleAction) {
    return this.lifecycle
      .transition(requestPrincipal(), workspaceId, journeyId, action)
      .then((data) => ({ data }));
  }

  @Post(':journeyId/activate')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'Activate a journey on its highest published version',
    description: `draft → active. Derives and stores the version's trigger. ${RUNNABLE_NOTE} ${LIFECYCLE_NOTE}`,
  })
  @ApiData(JourneySchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async activate(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
  ) {
    return this.lifecycleRoute(workspaceId, journeyId, 'activate');
  }

  @Post(':journeyId/pause')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'Pause an active journey',
    description: `active → paused. The trigger stops enrolling; executions keep their state. ${LIFECYCLE_NOTE}`,
  })
  @ApiData(JourneySchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async pause(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
  ) {
    return this.lifecycleRoute(workspaceId, journeyId, 'pause');
  }

  @Post(':journeyId/resume')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'Resume a paused journey',
    description: `paused → active. Re-arms the trigger. ${RUNNABLE_NOTE} ${LIFECYCLE_NOTE}`,
  })
  @ApiData(JourneySchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async resume(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
  ) {
    return this.lifecycleRoute(workspaceId, journeyId, 'resume');
  }

  @Post(':journeyId/archive')
  @RequiresPermission(PERMISSIONS.JOURNEYS_MANAGE, { target: 'deferred', because: AT_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'Archive a journey (terminal)',
    description: `draft, active or paused → archived. Retires the trigger and ends every live execution as cancelled (journey_archived). ${LIFECYCLE_NOTE}`,
  })
  @ApiData(JourneySchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async archive(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('journeyId', new ParseUUIDPipe()) journeyId: string,
  ) {
    return this.lifecycleRoute(workspaceId, journeyId, 'archive');
  }
}
