import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  AUDIENCE_TAG_MATCH_MODES,
  type AudienceTagMatchMode,
  type SegmentCriteria,
} from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';
import { CustomFieldFilterDto } from './contacts.dto';

export class SegmentCriteriaDto implements SegmentCriteria {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(AUDIENCE_TAG_MATCH_MODES)
  tagMatchMode?: AudienceTagMatchMode;

  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  channel?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  consentType?: string;

  @IsOptional()
  @IsBoolean()
  requireOptIn?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldFilterDto)
  customFieldFilters?: CustomFieldFilterDto[];
}

export class CreateSegmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentCriteriaDto)
  criteria?: SegmentCriteriaDto;
}

export class UpdateSegmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentCriteriaDto)
  criteria?: SegmentCriteriaDto;
}

export class ListSegmentsDto extends ListQueryDto {}

export class PreviewSegmentDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsString()
  channel?: string;
}
