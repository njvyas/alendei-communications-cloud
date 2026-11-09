import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiIdempotencyKey, ApiPaged } from '../openapi/openapi-responses';
import { UnknownResolutionSchema } from '../openapi/openapi-schemas';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import {
  ApproveUnknownResolutionDto,
  CreateUnknownResolutionDto,
  ListUnknownResolutionsQueryDto,
  RejectUnknownResolutionDto,
} from './unknown-resolution.dto';
import { UnknownResolutionService } from './unknown-resolution.service';

const PLATFORM_BILLING =
  'operator resolution of unknown outcomes spans every organization; it authorizes at platform scope (Phase 7 PR 7-6c, D-76-5)';

const KEYED =
  'Requires `Idempotency-Key` (`400 IDEMPOTENCY_KEY_REQUIRED` without one): the same key and request replay the original response and execute nothing; the same key with a different request is `422`.';

const DUAL_CONTROL =
  'Dual control (D-76-3): while `BILLING_DUAL_CONTROL_THRESHOLD_PAISE` is unset, every charge and write-off waits for a second approver; once set, a request at or below it executes at once and one above it waits; a charge without provider evidence always waits.';

/** Sets the status of an idempotent outcome (the original's, on a replay) and returns its body. */
function send<T>(response: Response, outcome: { status: number; body: T }): T {
  response.status(outcome.status);
  return outcome.body;
}

/**
 * Phase 7 PR 7-6c — operator resolution of unknown outcomes (`DECISIONS.md` §1zi.12).
 * Platform `billing.manage`, signed-in users only; every mutation is keyed, audited and
 * executed by the database. Nothing here runs without an operator's request.
 */
@ApiTags('billing')
@Controller('platform/billing')
export class UnknownResolutionController {
  constructor(private readonly resolutions: UnknownResolutionService) {}

  @Post('unknown-outcomes/:messageId/resolutions')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Request the resolution of an unknown outcome (charge or write-off)',
    description: `${KEYED} ${DUAL_CONTROL} A charge posts the customer charge(s) the automatic path would have posted — E_m on the message, or under charge_per_attempt E_a on the unknown attempt and every earlier attempt that reached the provider — and the provider cost only when a provider receipt is recorded on the unknown attempt. A write-off posts nothing. The response is the resolution: executed, or pending a second approver. 402 when funds are insufficient, 403 BILLING_ACCOUNT_FROZEN for a frozen account; then nothing is recorded.`,
  })
  @ApiData(UnknownResolutionSchema, { status: 201 })
  @ApiErrors(400, 401, 402, 403, 404, 409, 422, 429, 503)
  async request(
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Body() dto: CreateUnknownResolutionDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.resolutions.request(requestPrincipal(), messageId, dto, key));
  }

  @Post('resolutions/:id/approve')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Approve a pending resolution (a different user than the requester)',
    description: `${KEYED} The approval is bound to the request and to \`expectedAmountPaise\`: if that differs from the request, or the outcome's amount or evidence changed since, 409 BILLING_RESOLUTION_STALE and nothing executes. The requester cannot approve (403 BILLING_RESOLUTION_SELF_APPROVAL). On insufficient funds (402) or a frozen account (403) the request stays pending with the refusal recorded.`,
  })
  @ApiData(UnknownResolutionSchema)
  @ApiErrors(400, 401, 402, 403, 404, 409, 422, 429, 503)
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveUnknownResolutionDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.resolutions.approve(requestPrincipal(), id, dto, key));
  }

  @Post('resolutions/:id/reject')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Reject a pending resolution (a different user than the requester)',
    description: `${KEYED} Closes the request; nothing is posted and the outcome returns to open.`,
  })
  @ApiData(UnknownResolutionSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectUnknownResolutionDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.resolutions.reject(requestPrincipal(), id, dto, key));
  }

  @Get('resolutions')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List resolutions of unknown outcomes, newest first' })
  @ApiPaged(UnknownResolutionSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListUnknownResolutionsQueryDto) {
    const { items, page } = await this.resolutions.list(requestPrincipal(), query);
    return { data: items, page };
  }

  @Get('resolutions/:id')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'One resolution of an unknown outcome' })
  @ApiData(UnknownResolutionSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.resolutions.get(requestPrincipal(), id) };
  }
}
