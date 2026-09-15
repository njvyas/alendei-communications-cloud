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
} from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { CreateRoleDto, UpdateRoleDto } from './role.dto';
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
  async list() {
    const principal = this.principal();
    const roles = await this.db.withRequestTenant((tx) => this.roles.list(tx, principal));
    return { roles };
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    return this.db.withRequestTenant((tx) => this.roles.get(tx, principal, id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateRoleDto) {
    const principal = this.principal();
    return this.db.withRequestTenant((tx) =>
      this.roles.create(tx, principal, {
        key: dto.key,
        name: dto.name,
        description: dto.description ?? null,
        allowedScopeTypes: dto.allowedScopeTypes,
        permissions: dto.permissions,
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateRoleDto) {
    const principal = this.principal();
    return this.db.withRequestTenant((tx) => this.roles.update(tx, principal, id, dto));
  }

  @Delete(':id')
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
  async list() {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }
    const permissions = await this.db.withRequestTenant((tx) =>
      this.roles.listPermissions(tx, principal),
    );
    return { permissions };
  }
}
