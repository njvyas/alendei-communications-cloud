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
import {
  AccountOperationResultSchema,
  AccountOperationSchema,
  BillingAccountsSchema,
} from '../openapi/openapi-schemas';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import {
  AccountOperationReasonDto,
  ApproveAccountOperationDto,
  CreditLimitChangeDto,
  ListAccountOperationsQueryDto,
} from './account-operations.dto';
import { AccountOperationsService, type AccountOperationInput } from './account-operations.service';

const PLATFORM_BILLING =
  'billing-account administration spans every organization; it authorizes at platform scope (Phase 7 PR 7-6d-1, D-76-5)';

const KEYED =
  'Requires `Idempotency-Key` (`400 IDEMPOTENCY_KEY_REQUIRED` without one): the same key and request replay the original response and execute nothing; the same key with a different request is `422`.';

const ORG = '/platform/billing/organizations/:orgId';

/** Sets the status of an idempotent outcome (the original's, on a replay) and returns its body. */
function send<T>(response: Response, outcome: { status: number; body: T }): T {
  response.status(outcome.status);
  return outcome.body;
}

/**
 * Phase 7 PR 7-6d-1 — billing-account administration (`DECISIONS.md` §1zi.13).
 * Platform `billing.manage`, signed-in users only; every mutation is keyed, audited and
 * executed by the database. Nothing here moves money: accounts are created empty, a
 * credit limit is configuration and a freeze is a status. Recharge is PR 7-6d-2.
 */
@ApiTags('billing')
@Controller('platform/billing')
export class AccountOperationsController {
  constructor(private readonly operations: AccountOperationsService) {}

  private run(
    route: string,
    orgId: string,
    input: AccountOperationInput,
    key: string | null,
    response: Response,
  ) {
    return this.operations
      .request(requestPrincipal(), orgId, route, input, key)
      .then((outcome) => send(response, outcome));
  }

  @Get('organizations/:orgId/accounts')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: "An organization's billing accounts",
    description:
      'The wallet and the credit account (balance, limit, used, reserved, available, status), each null when not provisioned. billing.manage at platform scope.',
  })
  @ApiData(BillingAccountsSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async accounts(@Param('orgId', new ParseUUIDPipe()) orgId: string) {
    return { data: await this.operations.accounts(requestPrincipal(), orgId) };
  }

  @Post('organizations/:orgId/wallet')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Provision an empty wallet (prepaid)',
    description: `${KEYED} Creates the organization's wallet with zero balance; executes at once (no money moves). 409 when it already exists or the organization is closed.`,
  })
  @ApiData(AccountOperationResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  provisionWallet(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: AccountOperationReasonDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.run(
      `${ORG}/wallet`,
      orgId,
      { account: 'wallet', kind: 'provision', reason: dto.reason },
      key,
      response,
    );
  }

  @Post('organizations/:orgId/credit-account')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Provision a credit account with a zero limit (postpaid)',
    description: `${KEYED} Creates the organization's credit account with a zero limit; executes at once. 409 when it already exists or the organization is closed.`,
  })
  @ApiData(AccountOperationResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  provisionCreditAccount(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: AccountOperationReasonDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.run(
      `${ORG}/credit-account`,
      orgId,
      { account: 'credit_account', kind: 'provision', reason: dto.reason },
      key,
      response,
    );
  }

  @Post('organizations/:orgId/credit-limit')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Change the credit limit',
    description: `${KEYED} Bound to \`previousLimitPaise\` (409 BILLING_ACCOUNT_OPERATION_STALE when the live limit differs). A decrease executes at once. An increase waits for a second approver while BILLING_DUAL_CONTROL_THRESHOLD_PAISE is unset or the increase exceeds it (D-76d-1). Permitted while the account is frozen; never changes its status.`,
  })
  @ApiData(AccountOperationResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  changeCreditLimit(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: CreditLimitChangeDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.run(
      `${ORG}/credit-limit`,
      orgId,
      {
        account: 'credit_account',
        kind: 'credit_limit_change',
        reason: dto.reason,
        newLimitPaise: dto.newLimitPaise,
        previousLimitPaise: dto.previousLimitPaise,
      },
      key,
      response,
    );
  }

  @Post('organizations/:orgId/wallet/freeze')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Freeze the wallet',
    description: `${KEYED} Executes at once (D-76d-4): new reservations and spending are refused; balances and existing reservations are unchanged.`,
  })
  @ApiData(AccountOperationResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  freezeWallet(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: AccountOperationReasonDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.run(
      `${ORG}/wallet/freeze`,
      orgId,
      { account: 'wallet', kind: 'freeze', reason: dto.reason },
      key,
      response,
    );
  }

  @Post('organizations/:orgId/wallet/unfreeze')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Request to unfreeze the wallet',
    description: `${KEYED} Always waits for a second approver (D-76d-1).`,
  })
  @ApiData(AccountOperationResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  unfreezeWallet(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: AccountOperationReasonDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.run(
      `${ORG}/wallet/unfreeze`,
      orgId,
      { account: 'wallet', kind: 'unfreeze', reason: dto.reason },
      key,
      response,
    );
  }

  @Post('organizations/:orgId/credit-account/freeze')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Freeze the credit account',
    description: `${KEYED} Executes at once (D-76d-4): new reservations and spending are refused; limit, used and existing reservations are unchanged.`,
  })
  @ApiData(AccountOperationResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  freezeCreditAccount(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: AccountOperationReasonDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.run(
      `${ORG}/credit-account/freeze`,
      orgId,
      { account: 'credit_account', kind: 'freeze', reason: dto.reason },
      key,
      response,
    );
  }

  @Post('organizations/:orgId/credit-account/unfreeze')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Request to unfreeze the credit account',
    description: `${KEYED} Always waits for a second approver (D-76d-1).`,
  })
  @ApiData(AccountOperationResultSchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  unfreezeCreditAccount(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() dto: AccountOperationReasonDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.run(
      `${ORG}/credit-account/unfreeze`,
      orgId,
      { account: 'credit_account', kind: 'unfreeze', reason: dto.reason },
      key,
      response,
    );
  }

  @Post('account-operations/:id/approve')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Approve a pending account operation (a different user than the requester)',
    description: `${KEYED} Bound to \`expectedAmountPaise\` (the new limit of a credit-limit change; absent for an unfreeze) and to the account's state: otherwise 409 BILLING_ACCOUNT_OPERATION_STALE and nothing executes. The requester cannot approve (403 BILLING_RESOLUTION_SELF_APPROVAL).`,
  })
  @ApiData(AccountOperationResultSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveAccountOperationDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.operations.approve(requestPrincipal(), id, dto.expectedAmountPaise, key),
    );
  }

  @Post('account-operations/:id/reject')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey({ required: true })
  @ApiOperation({
    summary: 'Reject a pending account operation (a different user than the requester)',
    description: `${KEYED} Closes the request; nothing changes.`,
  })
  @ApiData(AccountOperationResultSchema)
  @ApiErrors(400, 401, 403, 404, 409, 422, 429, 503)
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AccountOperationReasonDto,
    @IdempotencyKey() key: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(response, await this.operations.reject(requestPrincipal(), id, dto.reason, key));
  }

  @Get('account-operations')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'List billing-account operations, newest first' })
  @ApiPaged(AccountOperationSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListAccountOperationsQueryDto) {
    const { items, page } = await this.operations.list(requestPrincipal(), query);
    return { data: items, page };
  }

  @Get('account-operations/:id')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'One billing-account operation' })
  @ApiData(AccountOperationSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.operations.get(requestPrincipal(), id) };
  }
}
