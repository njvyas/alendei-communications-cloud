import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsUUID } from 'class-validator';
import {
  CHANNEL_CODES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_STATUSES,
  type ChannelCode,
  type MessageDeliveryStatus,
  type MessageStatus,
} from '@acc/contracts';

import { ListQueryDto } from '../../common/http/list-query.dto';

/**
 * `GET /messages` query. Every filter narrows within the request organization;
 * none is an isolation mechanism (the tenant transaction is).
 *
 * There is deliberately no recipient filter: query strings are written to the
 * request log, and a recipient address is personal data.
 */
export class ListMessagesQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(MESSAGE_STATUSES)
  status?: MessageStatus;

  /**
   * Phase 5.0: the message's delivery status (independent of `status`). Messages with no
   * delivery status (not tracked) are never matched by this filter.
   */
  @IsOptional()
  @IsIn(MESSAGE_DELIVERY_STATUSES)
  deliveryStatus?: MessageDeliveryStatus;

  @IsOptional()
  @IsIn(CHANNEL_CODES)
  channelCode?: ChannelCode;

  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsUUID()
  templateId?: string;

  /** Messages with at least one dispatch attempt through this provider. */
  @IsOptional()
  @IsUUID()
  providerId?: string;

  /** Inclusive lower bound on `createdAt`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdFrom?: Date;

  /** Exclusive upper bound on `createdAt`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdTo?: Date;
}
