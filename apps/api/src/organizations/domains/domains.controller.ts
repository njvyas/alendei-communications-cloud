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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';

import type { ResolvedPrincipal } from '../../auth/auth.guard';
import { NoTenantContext, Public } from '../../auth/public.decorator';
import { RequiresPermission } from '../../auth/requires-permission.decorator';
import { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { AcceptedCredentials } from '../../openapi/accepted-credentials.decorator';
import { ApiErrors } from '../../openapi/openapi-responses';
import {
  DomainTransitionDto,
  RegisterDomainDto,
  ResolveDomainQueryDto,
  UpdateBrandingDto,
} from './domains.dto';
import { DomainsService } from './domains.service';

const BY_PATH =
  'the organization is named in the path; the service resolves and authorizes it from grants';

@ApiTags('domains')
@Controller()
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

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

  // --- Public Domain Resolution (TENANCY.md §7a: presentation only) ---------

  @Get('domains/resolve')
  @Public()
  @NoTenantContext()
  @ApiOperation({
    summary: 'Resolve hostname branding and portal configuration (public, unauthenticated)',
  })
  @ApiErrors(400, 429)
  async resolve(@Query() query: ResolveDomainQueryDto) {
    return { data: await this.domains.resolveHostname(query.hostname) };
  }

  // --- Organization Domain Management ---------------------------------------

  @Get('organizations/:id/domains')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_READ, { target: 'deferred', because: BY_PATH })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List domains registered for an organization' })
  @ApiErrors(400, 401, 403, 404, 429)
  async listDomains(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.domains.listDomains(this.principal(), id) };
  }

  @Post('organizations/:id/domains')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_UPDATE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Register a domain for an organization' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async registerDomain(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RegisterDomainDto,
  ) {
    return { data: await this.domains.registerDomain(this.principal(), id, dto) };
  }

  @Get('organizations/:id/domains/:domainId')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_READ, { target: 'deferred', because: BY_PATH })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get domain verification instructions and DNS challenge' })
  @ApiErrors(400, 401, 403, 404, 429)
  async getDomainVerification(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
  ) {
    return {
      data: await this.domains.getDomainVerification(this.principal(), id, domainId),
    };
  }

  @Post('organizations/:id/domains/:domainId/verify')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_UPDATE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Trigger domain verification' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async verifyDomain(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
  ) {
    return { data: await this.domains.verifyDomain(this.principal(), id, domainId) };
  }

  @Post('organizations/:id/domains/:domainId/primary')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_UPDATE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Set domain as primary for the organization' })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async setPrimaryDomain(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
  ) {
    return { data: await this.domains.setPrimaryDomain(this.principal(), id, domainId) };
  }

  @Delete('organizations/:id/domains/:domainId')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_UPDATE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Remove a domain' })
  @ApiErrors(400, 401, 403, 404, 429)
  async removeDomain(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
  ) {
    await this.domains.removeDomain(this.principal(), id, domainId);
  }

  @Post('organizations/:id/domains/:domainId/suspend')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Suspend a domain (platform admin)' })
  @ApiErrors(400, 401, 403, 404, 429)
  async suspendDomain(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
    @Body() dto: DomainTransitionDto,
  ) {
    return {
      data: await this.domains.suspendDomain(this.principal(), id, domainId, dto.reason),
    };
  }

  @Post('organizations/:id/domains/:domainId/activate')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Activate a domain (platform admin)' })
  @ApiErrors(400, 401, 403, 404, 429)
  async activateDomain(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
  ) {
    return {
      data: await this.domains.activateDomain(this.principal(), id, domainId),
    };
  }

  // --- Branding Management --------------------------------------------------

  @Get('organizations/:id/branding')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_READ, { target: 'deferred', because: BY_PATH })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get organization branding configuration' })
  @ApiErrors(400, 401, 403, 404, 429)
  async getBranding(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.domains.getBranding(this.principal(), id) };
  }

  @Patch('organizations/:id/branding')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_UPDATE, { target: 'deferred', because: BY_PATH })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Update organization branding configuration' })
  @ApiErrors(400, 401, 403, 404, 429)
  async updateBranding(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBrandingDto,
  ) {
    return { data: await this.domains.updateBranding(this.principal(), id, dto) };
  }
}
