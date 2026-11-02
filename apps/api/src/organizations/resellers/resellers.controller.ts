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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';

import type { ResolvedPrincipal } from '../../auth/auth.guard';
import { NoTenantContext, OptionalTenantContext } from '../../auth/public.decorator';
import { RequiresPermission } from '../../auth/requires-permission.decorator';
import { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { AcceptedCredentials } from '../../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../../openapi/openapi-responses';
import { ResellerOrganizationSchema, ResellerSchema } from '../../openapi/openapi-schemas';
import {
  CreateResellerDto,
  ListResellersQueryDto,
  ResellerTransitionDto,
  UpdateResellerDto,
} from './reseller.dto';
import { ResellersService } from './resellers.service';

const BY_PATH =
  'the reseller is named in the path; the service resolves and authorizes it from grants';

@ApiTags('resellers')
@Controller('resellers')
export class ResellersController {
  constructor(private readonly resellers: ResellersService) {}

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
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.RESELLERS_READ, {
    target: 'deferred',
    because: "the list spans every reseller within the caller's grant-derived reach",
  })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List resellers' })
  @ApiPaged(ResellerSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListResellersQueryDto) {
    const { items, page } = await this.resellers.list(this.principal(), query);
    return { data: items, page };
  }

  @Get(':id')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.RESELLERS_READ, { target: 'deferred', because: BY_PATH })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a reseller' })
  @ApiData(ResellerSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.resellers.get(this.principal(), id) };
  }

  @Post()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, {
    target: 'deferred',
    because: 'creating a reseller requires platform control-plane authority',
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Create a reseller' })
  @ApiData(ResellerSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(@Body() dto: CreateResellerDto) {
    return { data: await this.resellers.create(this.principal(), dto) };
  }

  @Patch(':id')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.RESELLERS_UPDATE, { target: 'deferred', because: BY_PATH })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Update a reseller' })
  @ApiData(ResellerSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateResellerDto) {
    return { data: await this.resellers.update(this.principal(), id, dto) };
  }

  @Post(':id/suspend')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Suspend a reseller' })
  @ApiData(ResellerSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async suspend(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ResellerTransitionDto) {
    return {
      data: await this.resellers.transition(this.principal(), id, 'suspend', dto.reason ?? null),
    };
  }

  @Post(':id/reactivate')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Reactivate a reseller' })
  @ApiData(ResellerSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async reactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResellerTransitionDto,
  ) {
    return {
      data: await this.resellers.transition(this.principal(), id, 'reactivate', dto.reason ?? null),
    };
  }

  @Get(':id/organizations')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.RESELLERS_READ, { target: 'deferred', because: BY_PATH })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List customer organizations under a reseller' })
  @ApiPaged(ResellerOrganizationSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async listOrganizations(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListQueryDto,
  ) {
    const { items, page } = await this.resellers.listOrganizations(this.principal(), id, query);
    return { data: items, page };
  }
}
