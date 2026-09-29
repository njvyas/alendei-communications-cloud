import {
  Body,
  Controller,
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
import type { Response } from 'express';

import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { CreateTeamDto, ListTeamsDto, UpdateTeamDto } from './workspace.dto';
import { TeamAdministrationService } from './team-administration.service';
import { requestPrincipal } from './workspaces.controller';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiIdempotencyKey, ApiPaged } from '../openapi/openapi-responses';
import { TeamSchema } from '../openapi/openapi-schemas';

const AT_TEAM =
  'the target is the team named in the path, resolved from the database inside the selected organization';
const AT_TEAM_WORKSPACE =
  "the target is the workspace of the team named in the path, read from the team's own row";

/**
 * Team administration and lifecycle (Phase 1C.1b, `FRONTEND_API_CONTRACT.md`
 * §31c, ADR-012 F-6, OD-5). Every route acts in the selected organization;
 * §31c declares no `orgId`, so it is an unknown field (`400`); `workspaceId` is
 * a target, authorized, never a context.
 * There is no `DELETE`.
 */
@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamAdministrationService) {}

  @Get()
  @RequiresPermission(PERMISSIONS.TEAMS_READ, {
    target: 'deferred',
    because: 'the target is the workspace named by workspaceId when given, else the organization',
  })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List teams' })
  @ApiPaged(TeamSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async list(@Query() query: ListTeamsDto) {
    const { items, page } = await this.teams.list(requestPrincipal(), {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
      status: query.status,
      workspaceId: query.workspaceId,
    });
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.TEAMS_READ, { target: 'deferred', because: AT_TEAM })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a team' })
  @ApiData(TeamSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.teams.get(requestPrincipal(), id) };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.TEAMS_CREATE, {
    target: 'deferred',
    because: 'the target is the workspace named in the body, resolved from the database',
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create a team' })
  @ApiData(TeamSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(
    @Body() dto: CreateTeamDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.teams.create(requestPrincipal(), dto, idempotencyKey);
    response.status(outcome.status);
    return outcome.body;
  }

  @Patch(':id')
  @RequiresPermission(PERMISSIONS.TEAMS_UPDATE, { target: 'deferred', because: AT_TEAM })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a team' })
  @ApiData(TeamSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateTeamDto) {
    return { data: await this.teams.update(requestPrincipal(), id, dto) };
  }

  @Post(':id/archive')
  @RequiresPermission(PERMISSIONS.TEAMS_UPDATE, { target: 'deferred', because: AT_TEAM_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Archive a team' })
  @ApiData(TeamSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async archive(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.teams.archive(requestPrincipal(), id) };
  }

  @Post(':id/restore')
  @RequiresPermission(PERMISSIONS.TEAMS_UPDATE, { target: 'deferred', because: AT_TEAM_WORKSPACE })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Restore a team' })
  @ApiData(TeamSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async restore(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.teams.restore(requestPrincipal(), id) };
  }
}
