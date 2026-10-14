import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  SUPPRESSION_STATUSES,
  type SuppressionStatus,
} from '@acc/contracts';
import { ListQueryDto } from '../common/http/list-query.dto';

export class ListSuppressionsDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsIn(SUPPRESSION_STATUSES)
  status?: SuppressionStatus;
}

export class CreateSuppressionDto {
  @IsOptional()
  @IsUUID()
  channelId?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  rawAddress!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class LiftSuppressionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
