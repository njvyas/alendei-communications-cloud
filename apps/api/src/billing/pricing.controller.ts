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
  Res,
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { ListQueryDto } from '../common/http/list-query.dto';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiIdempotencyKey, ApiPaged } from '../openapi/openapi-responses';
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

const KEYED =
  'Requires `Idempotency-Key` (`400 IDEMPOTENCY_KEY_REQUIRED` without one): the same key and request replay the original response and create nothing; the same key with a different request is `422`.';

/** Sets the status of an idempotent outcome (the original's, on a replay) and returns its body. */
function send<T>(response: Response, outcome: { status: number; body: T }): T {
  response.status(outcome.status);
  return outcome.body;
}

/**
 * Phase 7 PR 7-2 — platform pricing administration. Platform scope only, signed-in
 * users only; every mutation is audited; every creating `POST` requires an
 * `Idempotency-Key` (the repository mechanism, platform namespace). No tenant-facing pricing route exists,
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
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Create a rate card (pricing plan)',
    description: `${KEYED} Names are unique (case-insensitive): a new request with an existing name is 409.`,
  })
  @ApiData(PricingPlanDetailSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 409, 422, 429)
  async createPlan(
    @Body() dto: CreatePricingPlanDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.pricing.createPlan(requestPrincipal(), dto, key));
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
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Create the next draft version of a rate card',
    description: `${KEYED} A retry replays the original draft even after it was activated. A draft prices nothing until activated; one draft per plan, so a new create while a draft exists is 409.`,
  })
  @ApiData(PricingPlanVersionSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async createVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.pricing.createVersion(requestPrincipal(), id, key));
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
      'Replaces the whole rule set, so a retry leaves the same rules. Rates are integers in 1/10,000 paisa. A provider rule beats the channel default. Refused (409) once active.',
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
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Activate a draft version',
    description: `${KEYED} Frozen from then on. effectiveFrom defaults to now and may not be in the past; activating an active version under a new key is 409.`,
  })
  @ApiData(PricingPlanVersionSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async activateVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ActivatePricingVersionDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.pricing.activateVersion(requestPrincipal(), id, dto, key));
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
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Record a provider cost rate',
    description: `${KEYED} Append-only; effectiveFrom defaults to now and may not be in the past. One rate per provider and effective time (409).`,
  })
  @ApiData(ProviderCostRateSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async createProviderCostRate(
    @Body() dto: CreateProviderCostRateDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.pricing.createProviderCostRate(requestPrincipal(), dto, key));
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
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Assign a rate card to an organization or as the platform default',
    description: `${KEYED} Append-only; effectiveFrom defaults to now and may not be in the past. One assignment per organization (or the default) and effective time (409).`,
  })
  @ApiData(PricingAssignmentSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async createAssignment(
    @Body() dto: CreatePricingAssignmentDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.pricing.createAssignment(requestPrincipal(), dto, key));
  }
}
