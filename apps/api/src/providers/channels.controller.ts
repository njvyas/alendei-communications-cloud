import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS, type AuthPrincipal } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import { ChannelSchema } from '../openapi/openapi-schemas';
import { ListChannelsQueryDto } from './provider.dto';
import { ProviderRegistryService } from './provider-registry.service';

export const PLATFORM_CATALOGUE =
  'the channel and provider catalogue is global; every route authorizes at platform scope (ADR-013 F-3)';

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
 * The seeded channel catalogue (Phase 2.1, `FRONTEND_API_CONTRACT.md` §32a).
 * Read-only: the catalogue changes by migration, never through the API
 * (ADR-013 F-2).
 *
 * `@OptionalTenantContext`: a selected organization only attributes a refusal
 * in the audit trail; it is never the target and never widens anything.
 */
@ApiTags('channels')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly registry: ProviderRegistryService) {}

  @Get()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_READ, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List channels' })
  @ApiPaged(ChannelSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListChannelsQueryDto) {
    const { items, page } = await this.registry.listChannels(requestPrincipal(), query);
    return { data: items, page };
  }

  @Get(':id')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_READ, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Get a channel' })
  @ApiData(ChannelSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.registry.getChannel(requestPrincipal(), id) };
  }
}
