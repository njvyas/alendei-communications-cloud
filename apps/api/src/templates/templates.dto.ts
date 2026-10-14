import {
  ArrayUnique,
  IsIn,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TEMPLATE_APPROVAL_STATUSES, type TemplateApprovalStatus } from '@acc/contracts';
import { ListQueryDto } from '../common/http/list-query.dto';

export class ListTemplatesDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsIn(TEMPLATE_APPROVAL_STATUSES)
  approvalStatus?: TemplateApprovalStatus;
}

export class CreateTemplateDto {
  @IsUUID()
  channelId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  variables?: string[];
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  variables?: string[];
}

export const TARGET_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type TargetApprovalStatus = (typeof TARGET_APPROVAL_STATUSES)[number];

export class SimulateApprovalDto {
  @IsIn(TARGET_APPROVAL_STATUSES)
  targetStatus!: TargetApprovalStatus;
}
