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
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import type { Response } from 'express';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import {
  CreateRoleDto,
  ListPermissionsQueryDto,
  ListRolesQueryDto,
  UpdateRoleDto,
} from './role.dto';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { RoleAdministrationService } from './role-administration.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import {
  ApiData,
  ApiEmpty,
  ApiErrors,
  ApiIdempotencyKey,
  ApiPaged,
} from '../openapi/openapi-responses';
import { PermissionSchema, RoleSchema } from '../openapi/openapi-schemas';

/**
 * Role administration (`API.md` §3c, Phase 1B.5.4).
 *
 * Every handler is the same three lines on purpose: resolve the principal, open
 * one tenant transaction, delegate. Authorization, the guards and the audit row
 * all live in the service, inside that transaction — so a mutation and its
 * record share a fate, and no handler carries an authorization decision of its
 * own (ADR-005 D-1).
 *
 * Response shapes are Phase 1B.5.8's normalized envelope (`API.md` §8): a
 * collection is `{data, page}`, a single resource is `{data}`. Pagination,
 * filtering and sorting come from the shared `ListQuery` against each service's
 * own `ListQuerySpec`, so the conventions cannot drift per resource — which is
 * precisely how the pre-1B.5.8 API ended up with a different collection shape
 * per endpoint.
 */
@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly roles: RoleAdministrationService,
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
  @RequiresPermission(PERMISSIONS.ROLES_READ)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List roles' })
  @ApiPaged(RoleSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListRolesQueryDto) {
    const principal = this.principal();
    const { items, page } = await this.db.withRequestTenant((tx) =>
      this.roles.list(tx, principal, query),
    );
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.ROLES_READ)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a role' })
  @ApiData(RoleSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.roles.get(tx, principal, id));
    return { data };
  }

  /**
   * Creates a role, at most once per `Idempotency-Key` (`API.md` §4).
   *
   * The key is optional. Without one this behaves exactly as before — a
   * duplicate key is already refused by the unique index as `409`, so
   * idempotency adds the ability to tell a *successful retry* from a genuine
   * duplicate rather than making an unsafe endpoint safe.
   *
   * `IdempotencyService.execute` opens the tenant transaction and hands the same
   * `tx` to the work below, so authorization still runs inside the request's own
   * transaction, before the mutation, exactly as it did (ADR-005 D-5).
   */
  @Post()
  @RequiresPermission(PERMISSIONS.ROLES_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create a role' })
  @ApiData(RoleSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 409, 422, 429)
  async create(
    @Body() dto: CreateRoleDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = this.principal();
    const outcome = await this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/roles',
        orgId: principal.tenant.orgId,
        principal,
        pathParams: {},
        query: {},
        body: dto,
      },
      // The same check `create` performs, run before a replay is returned so a
      // stored response is never handed back on the strength of an old decision.
      authorize: (tx) => this.roles.assertMayCreate(tx, principal),
      // The work returns the **envelope**, not the inner resource, so what is
      // stored is byte-identical to what was sent. Storing the resource and
      // re-wrapping it on replay would let the two drift the moment the envelope
      // changes.
      work: async (tx) => ({
        data: await this.roles.create(tx, principal, {
          key: dto.key,
          name: dto.name,
          description: dto.description ?? null,
          allowedScopeTypes: dto.allowedScopeTypes,
          permissions: dto.permissions,
        }),
      }),
    });

    // A replay reproduces the original status; a fresh execution matches the
    // declared `@HttpCode`. Set explicitly so the two can never diverge.
    response.status(outcome.status);
    return outcome.body;
  }

  @Patch(':id')
  @RequiresPermission(PERMISSIONS.ROLES_UPDATE)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a role' })
  @ApiData(RoleSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateRoleDto) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.roles.update(tx, principal, id, dto));
    return { data };
  }

  @Delete(':id')
  @RequiresPermission(PERMISSIONS.ROLES_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Delete a role' })
  @ApiEmpty()
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    await this.db.withRequestTenant((tx) => this.roles.remove(tx, principal, id));
  }
}

/**
 * The permission catalogue (`API.md` §2: read-only, system-defined).
 *
 * Separate controller rather than a `/roles/permissions` sub-path: it is a
 * different resource with a different lifecycle — global, seeded, and not
 * tenant data — and nesting it under `/roles` would imply otherwise.
 */
@ApiTags('permissions')
@Controller('permissions')
export class PermissionsController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly roles: RoleAdministrationService,
  ) {}

  @Get()
  @RequiresPermission(PERMISSIONS.PERMISSIONS_READ)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List permissions' })
  @ApiPaged(PermissionSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListPermissionsQueryDto) {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }
    const { items, page } = await this.db.withRequestTenant((tx) =>
      this.roles.listPermissions(tx, principal, query),
    );
    return { data: items, page };
  }
}
