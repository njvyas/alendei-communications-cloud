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
import { ListQueryDto } from '../common/http/list-query.dto';
import {
  ProviderDetailSchema,
  ProviderHealthCheckResultSchema,
  ProviderHealthSampleSchema,
  ProviderSchema,
  ProviderTestSendResultSchema,
} from '../openapi/openapi-schemas';
import { PLATFORM_CATALOGUE, requestPrincipal } from './channels.controller';
import {
  CreateProviderDto,
  ListProvidersQueryDto,
  ProviderHealthCheckDto,
  ProviderHealthOverrideDto,
  ProviderTestSendDto,
  ReplaceProviderCapabilitiesDto,
  UpdateProviderDto,
} from './provider.dto';
import { ProviderHealthService } from './provider-health.service';
import { ProviderRegistryService } from './provider-registry.service';

/**
 * Provider registry (Phase 2.1), test-send (2.2) and health/circuit (2.3) —
 * `FRONTEND_API_CONTRACT.md` §32b, ADR-013.
 *
 * Platform scope only: `providers.read` for reads, `providers.manage` for every
 * write and the health check, `providers.test_send` for test-send. No `DELETE` —
 * a provider is disabled, never deleted. No credential or routing operation,
 * and no route that sets the circuit directly.
 */
@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly registry: ProviderRegistryService,
    private readonly health: ProviderHealthService,
  ) {}

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

  @Post(':id/health-check')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Run the provider adapter’s health check',
    description:
      'Phase 2.3: the simulator only; the behaviour selects the simulated answer. Permitted in every lifecycle status and circuit state. Records a probe sample that moves health, never the circuit. An unhealthy answer is a 200 with outcome "unhealthy" or "timeout".',
  })
  @ApiData(ProviderHealthCheckResultSchema)
  @ApiErrors(400, 401, 403, 404, 422, 429)
  async healthCheck(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ProviderHealthCheckDto,
  ) {
    return { data: await this.health.healthCheck(requestPrincipal(), id, dto.behavior) };
  }

  @Post(':id/health')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Set or clear the manual health override',
    description:
      'Phase 2.3: override pins health to a state until cleared with null, which re-derives it from the samples. Setting the override already in force changes nothing. Never touches the circuit.',
  })
  @ApiData(ProviderDetailSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async overrideHealth(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ProviderHealthOverrideDto,
  ) {
    return {
      data: await this.health.setOverride(requestPrincipal(), id, dto.override, dto.reason ?? null),
    };
  }

  @Get(':id/health')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_READ, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'List a provider’s health samples, newest first',
    description: 'Phase 2.3: test-send submissions, health-check probes and manual overrides.',
  })
  @ApiPaged(ProviderHealthSampleSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async listHealth(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: ListQueryDto) {
    const { items, page } = await this.health.listSamples(requestPrincipal(), id, query);
    return { data: items, page };
  }
}
