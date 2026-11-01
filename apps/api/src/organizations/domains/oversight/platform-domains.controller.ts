import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, PERMISSIONS, type AuthPrincipal } from '@acc/contracts';

import { OptionalTenantContext } from '../../../auth/public.decorator';
import { RequiresPermission } from '../../../auth/requires-permission.decorator';
import { RequestContext } from '../../../common/context/request-context';
import { AppException } from '../../../common/errors/app.exception';
import { AcceptedCredentials } from '../../../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../../../openapi/openapi-responses';
import {
  DomainDnsDiagnosticsSchema,
  DomainHistoryEntrySchema,
  PlatformDomainSchema,
  PlatformDomainSummarySchema,
} from '../../../openapi/platform-domain-schemas';
import { ListPlatformDomainsQueryDto } from './platform-domains.dto';
import { PlatformDomainsService } from './platform-domains.service';

/** Why every route here defers its target: the registry spans every tenant. */
export const PLATFORM_DOMAIN_OVERSIGHT =
  'the domain registry spans every organization; every route authorizes at platform scope in the service (U13.3)';

function principal(): AuthPrincipal {
  const p = RequestContext.get()?.principal;
  if (!p) {
    throw new AppException({
      status: HttpStatus.UNAUTHORIZED,
      code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
      message: 'Authentication is required',
    });
  }
  return p;
}

/**
 * Platform domain oversight (U13.3). Read-only: lifecycle changes stay on the
 * U12 routes under `/organizations/{id}/domains/{domainId}`.
 */
@ApiTags('platform-domains')
@Controller('platform/domains')
export class PlatformDomainsController {
  constructor(private readonly domains: PlatformDomainsService) {}

  @Get()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_READ, {
    target: 'deferred',
    because: PLATFORM_DOMAIN_OVERSIGHT,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List every organization domain (platform registry)' })
  @ApiPaged(PlatformDomainSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListPlatformDomainsQueryDto) {
    const { items, page } = await this.domains.list(principal(), query);
    return { data: items, page };
  }

  @Get('summary')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_READ, {
    target: 'deferred',
    because: PLATFORM_DOMAIN_OVERSIGHT,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Count registry domains by status, type and challenge state' })
  @ApiData(PlatformDomainSummarySchema)
  @ApiErrors(401, 403, 429)
  async summary() {
    return { data: await this.domains.summary(principal()) };
  }

  @Get(':domainId')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_READ, {
    target: 'deferred',
    because: PLATFORM_DOMAIN_OVERSIGHT,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Get one registry domain' })
  @ApiData(PlatformDomainSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return { data: await this.domains.get(principal(), domainId) };
  }

  @Get(':domainId/dns-diagnostics')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_READ, {
    target: 'deferred',
    because: PLATFORM_DOMAIN_OVERSIGHT,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Check DNS propagation of the ownership challenge (read-only; values never returned)',
  })
  @ApiData(DomainDnsDiagnosticsSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async diagnostics(@Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return { data: await this.domains.diagnostics(principal(), domainId) };
  }

  @Get(':domainId/history')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_AUDIT_READ, {
    target: 'deferred',
    because: PLATFORM_DOMAIN_OVERSIGHT,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Domain lifecycle history from the audit log' })
  @ApiData(DomainHistoryEntrySchema, { isArray: true })
  @ApiErrors(400, 401, 403, 404, 429)
  async history(@Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return { data: await this.domains.history(principal(), domainId) };
  }
}
