import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import {
  BillingAccountSchema,
  BillingLedgerEntrySchema,
  BillingUsageSchema,
} from '../openapi/openapi-schemas';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { BillingUsageQueryDto, ListBillingLedgerQueryDto } from './billing-read.dto';
import { BillingReadService } from './billing-read.service';

const AT_ORG = 'the target is the request organization';

/**
 * Phase 7 PR 7-6a — tenant billing reads (`DECISIONS.md` §1zi.9). `billing.read` at
 * the request organization, user sessions only: the key is held through system
 * roles only (D-76-4), so no API key or custom role can carry it. Read-only.
 */
@ApiTags('billing')
@Controller('billing')
export class BillingReadController {
  constructor(private readonly billing: BillingReadService) {}

  @Get('account')
  @RequiresPermission(PERMISSIONS.BILLING_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: "The organization's billing account",
    description:
      'The wallet (prepaid) or credit account (postpaid) of the organization billing mode: balance or credit limit and used, reserved and available funds, in integer paise (INR). 404 BILLING_ACCOUNT_NOT_CONFIGURED when the organization has none.',
  })
  @ApiData(BillingAccountSchema)
  @ApiErrors(401, 403, 404, 429)
  async account() {
    return { data: await this.billing.account(requestPrincipal()) };
  }

  @Get('ledger')
  @RequiresPermission(PERMISSIONS.BILLING_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: "The organization's billing ledger",
    description:
      'Newest first: reservations, reservation releases and customer charges. Ledger entries are append-only; corrections are new entries.',
  })
  @ApiPaged(BillingLedgerEntrySchema)
  @ApiErrors(400, 401, 403, 429)
  async ledger(@Query() query: ListBillingLedgerQueryDto) {
    const { items, page } = await this.billing.ledger(requestPrincipal(), query);
    return { data: items, page };
  }

  @Get('usage')
  @RequiresPermission(PERMISSIONS.BILLING_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: "The organization's charges for a period",
    description:
      'Customer charges in [from, to), at most 92 days: totals, per channel and per day in the requested time zone, derived from the ledger.',
  })
  @ApiData(BillingUsageSchema)
  @ApiErrors(400, 401, 403, 429)
  async usage(@Query() query: BillingUsageQueryDto) {
    return { data: await this.billing.usage(requestPrincipal(), query) };
  }
}
