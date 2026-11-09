import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalTenantContext } from '../auth/public.decorator';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import { UnknownOutcomeSchema } from '../openapi/openapi-schemas';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { ListUnknownOutcomesQueryDto } from './unknown-register.dto';
import { UnknownOutcomeRegisterService } from './unknown-register.service';

const PLATFORM_BILLING =
  'the unknown-outcome register spans every organization; it authorizes at platform scope (Phase 7 PR 7-6b, D-76-5)';

/** Phase 7 PR 7-6b — the unknown-outcome register (`DECISIONS.md` §1zi.9). Read-only. */
@ApiTags('billing')
@Controller('platform/billing')
export class UnknownOutcomeRegisterController {
  constructor(private readonly register: UnknownOutcomeRegisterService) {}

  @Get('unknown-outcomes')
  @OptionalTenantContext()
  @RequiresPermission(PERMISSIONS.BILLING_MANAGE, { target: 'deferred', because: PLATFORM_BILLING })
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'The unknown-outcome register',
    description:
      'One row per message billed under enforcement whose outcome is unknown, oldest first: the unknown attempt, age, evidence (a provider receipt on the attempt) and resolution status. Exposure figures are ESTIMATES for reconciliation, never ledger entries; an unknown outcome is never charged automatically. billing.manage at platform scope, signed-in users only. pending_approval and written_off appear once operator resolution exists (7-6c).',
  })
  @ApiPaged(UnknownOutcomeSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListUnknownOutcomesQueryDto) {
    const { items, page } = await this.register.list(requestPrincipal(), query);
    return { data: items, page };
  }
}
