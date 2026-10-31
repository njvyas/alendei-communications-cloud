import { Controller, Get, Query } from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AcceptedCredentials } from '../../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors } from '../../openapi/openapi-responses';
import { MessageUsageReportSchema } from '../../openapi/openapi-schemas';
import { RequiresPermission } from '../../auth/requires-permission.decorator';
import { requestPrincipal } from '../../workspaces/workspaces.controller';
import { MessageUsageQueryDto } from './message-usage.dto';
import { MessageUsageService } from './message-usage.service';

const AT_ORG = 'the target is the request organization';

@ApiTags('usage')
@Controller('usage')
export class MessageUsageController {
  constructor(private readonly usage: MessageUsageService) {}

  @Get('messages')
  @RequiresPermission(PERMISSIONS.MESSAGES_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'Message usage report for the request organization',
    description:
      'Counts of messages created in [from, to): totals, per channel, per day (in the requested time zone) and the top failure reason codes. At most 366 days. "accepted" means a provider accepted the submission.',
  })
  @ApiData(MessageUsageReportSchema)
  @ApiErrors(400, 401, 403, 429)
  async report(@Query() query: MessageUsageQueryDto) {
    const data = await this.usage.report(requestPrincipal(), query);
    return { data };
  }
}
