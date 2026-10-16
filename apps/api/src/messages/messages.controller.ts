import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiErrors, ApiIdempotencyKey } from '../openapi/openapi-responses';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagesService } from './messages.service';

const AT_ORG = 'the target is the request organization';

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @RequiresPermission(PERMISSIONS.MESSAGES_SEND, { target: 'deferred', because: AT_ORG })
  @HttpCode(HttpStatus.ACCEPTED)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Send a message' })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async send(
    @Body() dto: SendMessageDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.messages.sendMessage(requestPrincipal(), dto, idempotencyKey);
    response.status(outcome.status);
    return outcome.body;
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.MESSAGES_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a message by id' })
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const data = await this.messages.getMessage(requestPrincipal(), id);
    return { data };
  }
}
