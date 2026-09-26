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
import { ERROR_CODES, PERMISSIONS, type AuthPrincipal } from '@acc/contracts';
import type { Response } from 'express';

import { RequiresPermission } from '../auth/requires-permission.decorator';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { AdvisoryTenantIds } from '../tenancy/advisory-identifier';
import { CreateWorkspaceDto, ListWorkspacesDto, UpdateWorkspaceDto } from './workspace.dto';
import { WorkspaceAdministrationService } from './workspace-administration.service';

const AT_WORKSPACE =
  'the target is the workspace named in the path, resolved from the database inside the selected organization';

export function requestPrincipal(): AuthPrincipal {
  const principal = RequestContext.get()?.principal;
  if (!principal) {
    throw new AppException({
      status: HttpStatus.UNAUTHORIZED,
      code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
      message: 'Authentication is required',
    });
  }
  return principal;
}

/**
 * Workspace administration and lifecycle (Phase 1C.1b,
 * `FRONTEND_API_CONTRACT.md` §31b, ADR-012 F-6). Every route acts in the
 * selected organization; `orgId` in a query or body is advisory and
 * cross-checked by `AdvisoryTenantGuard`. There is no `DELETE`.
 */
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspaceAdministrationService) {}

  @Get()
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  @AdvisoryTenantIds({ level: 'organization', source: 'query', key: 'orgId' })
  async list(@Query() query: ListWorkspacesDto) {
    const { items, page } = await this.workspaces.list(requestPrincipal(), {
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
      status: query.status,
    });
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ, { target: 'deferred', because: AT_WORKSPACE })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.workspaces.get(requestPrincipal(), id) };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.WORKSPACES_CREATE)
  @AdvisoryTenantIds({ level: 'organization', source: 'body', key: 'orgId' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateWorkspaceDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.workspaces.create(requestPrincipal(), dto, idempotencyKey);
    response.status(outcome.status);
    return outcome.body;
  }

  @Patch(':id')
  @RequiresPermission(PERMISSIONS.WORKSPACES_UPDATE, { target: 'deferred', because: AT_WORKSPACE })
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateWorkspaceDto) {
    return { data: await this.workspaces.update(requestPrincipal(), id, dto) };
  }

  @Post(':id/archive')
  @RequiresPermission(PERMISSIONS.WORKSPACES_UPDATE)
  @HttpCode(HttpStatus.OK)
  async archive(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.workspaces.archive(requestPrincipal(), id) };
  }

  @Post(':id/restore')
  @RequiresPermission(PERMISSIONS.WORKSPACES_UPDATE)
  @HttpCode(HttpStatus.OK)
  async restore(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.workspaces.restore(requestPrincipal(), id) };
  }
}
