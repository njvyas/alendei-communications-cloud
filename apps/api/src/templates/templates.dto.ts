import {
  ArrayUnique,
  IsIn,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SMS_CONSTRAINTS,
  TEMPLATE_APPROVAL_STATUSES,
  type TemplateApprovalStatus,
} from '@acc/contracts';
import { ListQueryDto } from '../common/http/list-query.dto';

export class ListTemplatesDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsIn(TEMPLATE_APPROVAL_STATUSES)
  approvalStatus?: TemplateApprovalStatus;
}

export class SmsDltMetadataDto {
  @IsString()
  @Matches(SMS_CONSTRAINTS.DLT_ENTITY_ID_PATTERN, {
    message: 'DLT entityId must be a numeric string between 10 and 25 digits',
  })
  entityId!: string;

  @IsString()
  @Matches(SMS_CONSTRAINTS.DLT_TEMPLATE_ID_PATTERN, {
    message: 'DLT templateId must be a numeric string between 10 and 25 digits',
  })
  templateId!: string;

  @IsOptional()
  @IsString()
  @Matches(SMS_CONSTRAINTS.DLT_HEADER_PATTERN, {
    message: 'DLT headerId must be an alphanumeric string between 3 and 11 characters',
  })
  headerId?: string;
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

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SmsDltMetadataDto)
  dlt?: SmsDltMetadataDto;
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

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SmsDltMetadataDto)
  dlt?: SmsDltMetadataDto;
}

export const TARGET_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type TargetApprovalStatus = (typeof TARGET_APPROVAL_STATUSES)[number];

export class SimulateApprovalDto {
  @IsIn(TARGET_APPROVAL_STATUSES)
  targetStatus!: TargetApprovalStatus;
}
