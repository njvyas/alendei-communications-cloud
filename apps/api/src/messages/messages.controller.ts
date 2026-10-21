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

import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiIdempotencyKey, ApiPaged } from '../openapi/openapi-responses';
import {
  MessageDetailSchema,
  MessageSummarySchema,
  QueuedMessageSchema,
} from '../openapi/openapi-schemas';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { requestPrincipal } from '../workspaces/workspaces.controller';
import { ListMessagesQueryDto } from './dto/list-messages.dto';
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
  @ApiData(QueuedMessageSchema, { status: 202 })
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

  @Get()
  @RequiresPermission(PERMISSIONS.MESSAGES_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'List messages in an organization',
    description:
      'Newest first. Metadata and an attempt count only; the payload and attempts are on GET /messages/{id}.',
  })
  @ApiPaged(MessageSummarySchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListMessagesQueryDto) {
    const { items, page } = await this.messages.listMessages(requestPrincipal(), query);
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.MESSAGES_READ, { target: 'deferred', because: AT_ORG })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get a message by id' })
  @ApiData(MessageDetailSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const data = await this.messages.getMessage(requestPrincipal(), id);
    return { data };
  }
}
