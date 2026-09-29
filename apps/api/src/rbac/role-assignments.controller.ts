import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import type { Response } from 'express';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { CreateAssignmentDto, ListAssignmentsQueryDto } from './role-assignment.dto';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { RoleAssignmentService } from './role-assignment.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import {
  ApiData,
  ApiEmpty,
  ApiErrors,
  ApiIdempotencyKey,
  ApiPaged,
} from '../openapi/openapi-responses';
import { RoleAssignmentSchema } from '../openapi/openapi-schemas';

/**
 * Role-assignment administration (`API.md` §3c, Phase 1B.5.5).
 *
 * Every handler resolves the principal, opens one tenant transaction and
 * delegates — the authorization decisions, the escalation guards and the audit
 * row all live in the service, inside that transaction, so a grant and its
 * record share a fate and no handler carries a decision of its own.
 *
 * Response shapes are Phase 1B.5.8's normalized envelope (`API.md` §8): the list
 * is `{data, page}`, a single assignment is `{data}`, and `DELETE` is `204` with
 * no body. The list carries the three filters `API.md` §3c names — `userId`,
 * `scopeType`, `scopeId` — plus the shared `limit`/`cursor`/`sort` parameters,
 * sorting on `createdAt` or `scopeType` with `-createdAt` as the default.
 */
@ApiTags('role-assignments')
@Controller('role-assignments')
export class RoleAssignmentsController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly assignments: RoleAssignmentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private principal(): ResolvedPrincipal {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }
    return principal;
  }

  @Get()
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_READ)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List role assignments' })
  @ApiPaged(RoleAssignmentSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListAssignmentsQueryDto) {
    const principal = this.principal();
    const { items, page } = await this.db.withRequestTenant((tx) =>
      this.assignments.list(tx, principal, query),
    );
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_READ)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a role assignment' })
  @ApiData(RoleAssignmentSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.assignments.get(tx, principal, id));
    return { data };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_GRANT, {
    target: 'deferred',
    because:
      'the target is the scope named in the body, which no route metadata can know — ' +
      'guessing it would be the forged-target defect ADR-005 D-5 exists to prevent',
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Grant a role' })
  @ApiData(RoleAssignmentSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(
    @Body() dto: CreateAssignmentDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = this.principal();
    const outcome = await this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/role-assignments',
        orgId: principal.tenant.orgId,
        principal,
        pathParams: {},
        query: {},
        body: dto,
      },
      // The same check `grant` performs, against the same target, run before a
      // replay is returned.
      authorize: (tx) =>
        this.assignments.assertMayGrant(tx, principal, {
          scopeType: dto.scopeType,
          scopeId: dto.scopeId,
        }),
      // The envelope, so the stored snapshot is byte-identical to what was sent.
      work: async (tx) => ({
        data: await this.assignments.grant(tx, principal, {
          userId: dto.userId,
          roleId: dto.roleId,
          scopeType: dto.scopeType,
          scopeId: dto.scopeId,
        }),
      }),
    });

    response.status(outcome.status);
    return outcome.body;
  }

  @Delete(':id')
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE, {
    target: 'deferred',
    because: 'the target is the scope on the stored row, knowable only once it is loaded',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Revoke a role assignment' })
  @ApiEmpty()
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async revoke(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    await this.db.withRequestTenant((tx) => this.assignments.revoke(tx, principal, id));
  }
}
