import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { ListQueryDto } from '../common/http/list-query.dto';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import {
  PricingAssignmentSchema,
  PricingPlanDetailSchema,
  PricingPlanSchema,
  PricingPlanVersionSchema,
  ProviderCostRateSchema,
} from '../openapi/openapi-schemas';
import { requestPrincipal } from '../providers/channels.controller';
import {
  ActivatePricingVersionDto,
  CreatePricingAssignmentDto,
  CreatePricingPlanDto,
  CreateProviderCostRateDto,
  ListPricingAssignmentsQueryDto,
  ListProviderCostRatesQueryDto,
  ReplacePricingRulesDto,
} from './pricing.dto';
import { PricingService } from './pricing.service';

export const PRICING_CATALOGUE =
  'the pricing catalogue is global; every route authorizes at platform scope (Phase 7 PR 7-2, OD-P-3)';

/**
 * Phase 7 PR 7-2 — platform pricing administration. Platform scope only, signed-in
 * users only; every mutation is audited. No tenant-facing pricing route exists,
 * and nothing here rates a transaction or touches the ledger.
 */
@ApiTags('pricing')
@Controller('platform/pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('plans')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_READ, { target: 'deferred', because: PRICING_CATALOGUE })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List rate cards (pricing plans)' })
  @ApiPaged(PricingPlanSchema)
  @ApiErrors(400, 401, 403, 429)
  async listPlans(@Query() query: ListQueryDto) {
    const { items, page } = await this.pricing.listPlans(requestPrincipal(), query);
    return { data: items, page };
  }

  @Post('plans')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_MANAGE, {
    target: 'deferred',
    because: PRICING_CATALOGUE,
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Create a rate card (pricing plan)',
    description: 'Naturally idempotent: names are unique, so a retry is 409 and creates nothing.',
  })
  @ApiData(PricingPlanDetailSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 409, 429)
  async createPlan(@Body() dto: CreatePricingPlanDto) {
    return { data: await this.pricing.createPlan(requestPrincipal(), dto) };
  }

  @Get('plans/:id')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_READ, { target: 'deferred', because: PRICING_CATALOGUE })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Get a rate card with its versions' })
  @ApiData(PricingPlanDetailSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async getPlan(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.pricing.getPlan(requestPrincipal(), id) };
  }

  @Post('plans/:id/versions')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_MANAGE, {
    target: 'deferred',
    because: PRICING_CATALOGUE,
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Create the next draft version of a rate card',
    description:
      'A draft prices nothing until activated. One draft per plan: a retry, or a create while a draft exists, is 409.',
  })
  @ApiData(PricingPlanVersionSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async createVersion(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.pricing.createVersion(requestPrincipal(), id) };
  }

  @Get('versions/:id')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_READ, { target: 'deferred', because: PRICING_CATALOGUE })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Get a rate-card version with its rules' })
  @ApiData(PricingPlanVersionSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async getVersion(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.pricing.getVersion(requestPrincipal(), id) };
  }

  @Put('versions/:id/rules')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_MANAGE, {
    target: 'deferred',
    because: PRICING_CATALOGUE,
  })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: "Replace a draft version's rules",
    description:
      'Rates are integers in 1/10,000 paisa. A provider rule beats the channel default. Refused (409) once active.',
  })
  @ApiData(PricingPlanVersionSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async replaceRules(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplacePricingRulesDto,
  ) {
    return { data: await this.pricing.replaceRules(requestPrincipal(), id, dto) };
  }

  @Post('versions/:id/activate')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_MANAGE, {
    target: 'deferred',
    because: PRICING_CATALOGUE,
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Activate a draft version',
    description:
      'Frozen from then on. effectiveFrom defaults to now and may not be in the past; a second activation is 409.',
  })
  @ApiData(PricingPlanVersionSchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async activateVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ActivatePricingVersionDto,
  ) {
    return { data: await this.pricing.activateVersion(requestPrincipal(), id, dto) };
  }

  @Get('provider-cost-rates')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_READ, { target: 'deferred', because: PRICING_CATALOGUE })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List provider cost rates' })
  @ApiPaged(ProviderCostRateSchema)
  @ApiErrors(400, 401, 403, 429)
  async listProviderCostRates(@Query() query: ListProviderCostRatesQueryDto) {
    const { items, page } = await this.pricing.listProviderCostRates(requestPrincipal(), query);
    return { data: items, page };
  }

  @Post('provider-cost-rates')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_MANAGE, {
    target: 'deferred',
    because: PRICING_CATALOGUE,
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Record a provider cost rate',
    description:
      'Append-only; effectiveFrom defaults to now and may not be in the past. One rate per provider and effective time (a retry is 409).',
  })
  @ApiData(ProviderCostRateSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async createProviderCostRate(@Body() dto: CreateProviderCostRateDto) {
    return { data: await this.pricing.createProviderCostRate(requestPrincipal(), dto) };
  }

  @Get('assignments')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_READ, { target: 'deferred', because: PRICING_CATALOGUE })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List rate-card assignments' })
  @ApiPaged(PricingAssignmentSchema)
  @ApiErrors(400, 401, 403, 429)
  async listAssignments(@Query() query: ListPricingAssignmentsQueryDto) {
    const { items, page } = await this.pricing.listAssignments(requestPrincipal(), query);
    return { data: items, page };
  }

  @Post('assignments')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.PRICING_MANAGE, {
    target: 'deferred',
    because: PRICING_CATALOGUE,
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Assign a rate card to an organization or as the platform default',
    description:
      'Append-only; effectiveFrom defaults to now and may not be in the past. One assignment per organization (or the default) and effective time.',
  })
  @ApiData(PricingAssignmentSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async createAssignment(@Body() dto: CreatePricingAssignmentDto) {
    return { data: await this.pricing.createAssignment(requestPrincipal(), dto) };
  }
}
