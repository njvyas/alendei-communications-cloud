import { Body, Controller, Get, Put } from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors } from '../openapi/openapi-responses';
import { CircuitPolicySchema } from '../openapi/openapi-schemas';
import { PLATFORM_CATALOGUE, requestPrincipal } from './channels.controller';
import { UpdateCircuitPolicyDto } from './provider.dto';
import { ProviderCircuitPolicyService } from './provider-circuit-policy.service';

/**
 * The platform circuit policy (Gate D.3 remediation, `PROVIDER_ADAPTER.md`
 * §6a, §6i). `providers.manage` at platform scope for both read and replace;
 * one platform-wide policy, no per-provider or tenant variant.
 */
@ApiTags('providers')
@Controller('provider-circuit-policy')
export class ProviderCircuitPolicyController {
  constructor(private readonly policy: ProviderCircuitPolicyService) {}

  @Get()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Read the platform circuit-breaker policy' })
  @ApiData(CircuitPolicySchema)
  @ApiErrors(401, 403, 429)
  async get() {
    return { data: await this.policy.get(requestPrincipal()) };
  }

  @Put()
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PROVIDERS_MANAGE, {
    target: 'deferred',
    because: PLATFORM_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Replace the platform circuit-breaker policy',
    description:
      'All eight parameters within their safe bounds, and expectedVersion. A stale version is 409 with details.currentVersion; the policy already in force changes nothing. Governs every circuit decision made after it commits.',
  })
  @ApiData(CircuitPolicySchema)
  @ApiErrors(400, 401, 403, 409, 429)
  async update(@Body() dto: UpdateCircuitPolicyDto) {
    return { data: await this.policy.update(requestPrincipal(), dto) };
  }
}
