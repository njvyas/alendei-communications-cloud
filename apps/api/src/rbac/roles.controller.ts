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
} from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';

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
import { RoleAdministrationService } from './role-administration.service';

/**
 * Role administration (`API.md` §3c, Phase 1B.5.4).
 *
 * Every handler is the same three lines on purpose: resolve the principal, open
 * one tenant transaction, delegate. Authorization, the guards and the audit row
 * all live in the service, inside that transaction — so a mutation and its
 * record share a fate, and no handler carries an authorization decision of its
 * own (ADR-005 D-1).
 *
 * Response shapes follow the conventions that exist today rather than
 * anticipating Phase 1B.5.8's normalization: a list is a named-key wrapper, a
 * single resource is the bare object. Pagination, filtering and sorting are
 * deliberately absent — they are cross-cutting conventions 1B.5.8 owns, and
 * inventing a local one here is exactly the churn that phase exists to prevent.
 */
@Controller('roles')
export class RolesController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly roles: RoleAdministrationService,
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
  async list(@Query() query: ListRolesQueryDto) {
    const principal = this.principal();
    const { items, page } = await this.db.withRequestTenant((tx) =>
      this.roles.list(tx, principal, query),
    );
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.ROLES_READ)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.roles.get(tx, principal, id));
    return { data };
  }

  @Post()
  @RequiresPermission(PERMISSIONS.ROLES_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateRoleDto) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) =>
      this.roles.create(tx, principal, {
        key: dto.key,
        name: dto.name,
        description: dto.description ?? null,
        allowedScopeTypes: dto.allowedScopeTypes,
        permissions: dto.permissions,
      }),
    );
    return { data };
  }

  @Patch(':id')
  @RequiresPermission(PERMISSIONS.ROLES_UPDATE)
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateRoleDto) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.roles.update(tx, principal, id, dto));
    return { data };
  }

  @Delete(':id')
  @RequiresPermission(PERMISSIONS.ROLES_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
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
@Controller('permissions')
export class PermissionsController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly roles: RoleAdministrationService,
  ) {}

  @Get()
  @RequiresPermission(PERMISSIONS.PERMISSIONS_READ)
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
