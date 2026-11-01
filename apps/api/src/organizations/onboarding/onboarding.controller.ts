import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';

import type { ResolvedPrincipal } from '../../auth/auth.guard';
import { NoTenantContext } from '../../auth/public.decorator';
import { RequiresPermission } from '../../auth/requires-permission.decorator';
import { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { AcceptedCredentials } from '../../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors } from '../../openapi/openapi-responses';
import { OnboardingResultSchema } from '../../openapi/openapi-schemas';
import {
  DirectCustomerOnboardingDto,
  ResellerCustomerOnboardingDto,
  WhiteLabelCustomerOnboardingDto,
} from './onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

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

  @Post('direct')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.PLATFORM_TENANTS_MANAGE, {
    target: 'deferred',
    because: 'direct customer onboarding creates an organization beneath platform-default reseller',
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary:
      'Onboard a direct customer with automated organization, workspace, roles and subdomain provisioning',
  })
  @ApiData(OnboardingResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 409, 429)
  async onboardDirect(@Body() dto: DirectCustomerOnboardingDto) {
    return { data: await this.onboarding.onboardDirectCustomer(this.principal(), dto) };
  }

  @Post('reseller-customer')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_CREATE, {
    target: 'deferred',
    because: 'onboarding creates an organization beneath platform or reseller',
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Onboard a customer organization beneath a reseller account',
  })
  @ApiData(OnboardingResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 409, 429)
  async onboardResellerCustomer(@Body() dto: ResellerCustomerOnboardingDto) {
    return { data: await this.onboarding.onboardResellerCustomer(this.principal(), dto) };
  }

  @Post('white-label')
  @NoTenantContext()
  @RequiresPermission(PERMISSIONS.ORGANIZATIONS_CREATE, {
    target: 'deferred',
    because: 'onboarding creates an organization beneath platform or reseller',
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Onboard a white-label customer with custom domain challenge and custom branding',
  })
  @ApiData(OnboardingResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 409, 429)
  async onboardWhiteLabel(@Body() dto: WhiteLabelCustomerOnboardingDto) {
    return { data: await this.onboarding.onboardWhiteLabelCustomer(this.principal(), dto) };
  }
}
