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
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import type { Response } from 'express';

import type { ResolvedPrincipal } from '../auth/auth.guard';
import { NoTenantContext, OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import {
  CreateOrganizationDto,
  ListOrganizationsQueryDto,
  OrganizationTransitionDto,
  UpdateOrganizationDto,
} from './organization.dto';
import { OrganizationAdministrationService } from './organization-administration.service';

const BY_PATH =
  'the organization is named in the path, not selected by X-Acc-Organization; the service resolves and authorizes it from grants';

/**
 * Organization administration and lifecycle (Phase 1C.1a,
 * `FRONTEND_API_CONTRACT.md` §31a, ADR-012).
 *
 * Every route declares `deferred`: none targets the request's selected
 * organization. `GET/POST /organizations` span the caller's reach (or create
 * beneath a reseller) and resolve an organization only to attribute the actor;
 * the `:id` routes address one organization by path.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationAdministrationService) {}

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
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_READ, {
    target: 'deferred',
    because: "the list spans every organization within the caller's grant-derived reach",
  })
  async list(@Query() query: ListOrganizationsQueryDto) {
    const { items, page } = await this.organizations.list(this.principal(), query);
    return { data: items, page };
  }

  @Get(':id')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_READ, { target: 'deferred', because: BY_PATH })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.organizations.get(this.principal(), id) };
  }

  @Post()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_CREATE, {
    target: 'deferred',
    because:
      'the target is the reseller the organization is created beneath, named in the body or implied by the caller’s grants',
  })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateOrganizationDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.organizations.create(this.principal(), dto, idempotencyKey);
    response.status(outcome.status);
    return outcome.body;
  }

  @Patch(':id')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_UPDATE, { target: 'deferred', because: BY_PATH })
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateOrganizationDto) {
    return { data: await this.organizations.update(this.principal(), id, dto) };
  }

  @Post(':id/suspend')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  async suspend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: OrganizationTransitionDto,
  ) {
    return {
      data: await this.organizations.transition(
        this.principal(),
        id,
        'suspend',
        dto.reason ?? null,
      ),
    };
  }

  @Post(':id/reactivate')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: OrganizationTransitionDto,
  ) {
    return {
      data: await this.organizations.transition(
        this.principal(),
        id,
        'reactivate',
        dto.reason ?? null,
      ),
    };
  }

  @Post(':id/close')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  async close(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: OrganizationTransitionDto,
  ) {
    return {
      data: await this.organizations.transition(this.principal(), id, 'close', dto.reason ?? null),
    };
  }
}
