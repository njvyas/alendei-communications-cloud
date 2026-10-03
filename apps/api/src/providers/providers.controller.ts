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
  Put,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import {
  ProviderDetailSchema,
  ProviderSchema,
  ProviderTestSendResultSchema,
} from '../openapi/openapi-schemas';
import { PLATFORM_CATALOGUE, requestPrincipal } from './channels.controller';
import {
  CreateProviderDto,
  ListProvidersQueryDto,
  ProviderTestSendDto,
  ReplaceProviderCapabilitiesDto,
  UpdateProviderDto,
} from './provider.dto';
import { ProviderRegistryService } from './provider-registry.service';

/**
 * Provider registry (Phase 2.1, `FRONTEND_API_CONTRACT.md` §32b, ADR-013).
 *
 * Platform scope only: `providers.read` for reads, `providers.manage` for every
 * write. No `DELETE` — a provider is disabled, never deleted. No credential,
 * health, circuit, routing or test-send operation exists in 2.1.
 */
@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly registry: ProviderRegistryService) {}

  @Get()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_READ, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List providers' })
  @ApiPaged(ProviderSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListProvidersQueryDto) {
    const { items, page } = await this.registry.listProviders(requestPrincipal(), query);
    return { data: items, page };
  }

  @Get(':id')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_READ, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Get a provider' })
  @ApiData(ProviderDetailSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.registry.getProvider(requestPrincipal(), id) };
  }

  @Post()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Create a provider',
    description:
      'Created disabled. Naturally idempotent: one name per channel, so a retry is 409 and creates nothing (no Idempotency-Key).',
  })
  @ApiData(ProviderDetailSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(@Body() dto: CreateProviderDto) {
    return { data: await this.registry.create(requestPrincipal(), dto) };
  }

  @Patch(':id')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Update a provider' })
  @ApiData(ProviderDetailSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateProviderDto) {
    return { data: await this.registry.update(requestPrincipal(), id, dto) };
  }

  @Put(':id/capabilities')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: "Replace a provider's capabilities",
    description: 'Complete replacement; naturally idempotent.',
  })
  @ApiData(ProviderDetailSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async replaceCapabilities(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplaceProviderCapabilitiesDto,
  ) {
    return { data: await this.registry.replaceCapabilities(requestPrincipal(), id, dto) };
  }

  @Post(':id/enable')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Enable a provider' })
  @ApiData(ProviderDetailSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async enable(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.registry.transition(requestPrincipal(), id, 'enable') };
  }

  @Post(':id/disable')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Disable a provider' })
  @ApiData(ProviderDetailSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async disable(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.registry.transition(requestPrincipal(), id, 'disable') };
  }

  @Post(':id/drain')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Drain a provider' })
  @ApiData(ProviderDetailSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async drain(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.registry.transition(requestPrincipal(), id, 'drain') };
  }

  @Post(':id/test-send')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_TEST_SEND, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Send a synthetic test submission through the provider’s adapter',
    description:
      'Phase 2.2: the simulator only. The behaviour selects the simulated answer; the adapter comes from the provider’s catalogue row; the payload is synthetic and no message is persisted. A provider rejection is a 200 with outcome "rejected".',
  })
  @ApiData(ProviderTestSendResultSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async testSend(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ProviderTestSendDto) {
    return { data: await this.registry.testSend(requestPrincipal(), id, dto.behavior) };
  }
}
