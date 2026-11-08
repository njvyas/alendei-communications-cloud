import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PRICING_RATE_MAX_E4, PRICING_RULES_MAX } from '@acc/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ListQueryDto } from '../common/http/list-query.dto';

/** `POST /platform/pricing/plans`. Naturally idempotent: names are unique (case-insensitive). */
export class CreatePricingPlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

/** One rule of a draft rate-card version. Rates are integers in 1/10,000 paisa (OD-P-1). */
export class PricingRuleInputDto {
  @IsUUID()
  channelId!: string;

  /** A provider-specific price; omitted or `null` is the channel default. */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  providerId?: string | null;

  @IsInt()
  @Min(0)
  @Max(PRICING_RATE_MAX_E4)
  @ApiProperty({ minimum: 0, maximum: PRICING_RATE_MAX_E4 })
  unitPriceE4!: number;
}

/** `PUT /platform/pricing/versions/:id/rules`. Replaces every rule of a draft. */
export class ReplacePricingRulesDto {
  @IsArray()
  @ArrayMaxSize(PRICING_RULES_MAX)
  @ValidateNested({ each: true })
  @Type(() => PricingRuleInputDto)
  @ApiProperty({ type: [PricingRuleInputDto], maxItems: PRICING_RULES_MAX })
  rules!: PricingRuleInputDto[];
}

/** `POST /platform/pricing/versions/:id/activate`. Omitted `effectiveFrom` = now; never in the past. */
export class ActivatePricingVersionDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  @ApiPropertyOptional({ format: 'date-time' })
  effectiveFrom?: string;
}

/** `POST /platform/pricing/provider-cost-rates`. Append-only; never backdated. */
export class CreateProviderCostRateDto {
  @IsUUID()
  providerId!: string;

  @IsInt()
  @Min(0)
  @Max(PRICING_RATE_MAX_E4)
  @ApiProperty({ minimum: 0, maximum: PRICING_RATE_MAX_E4 })
  unitCostE4!: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  @ApiPropertyOptional({ format: 'date-time' })
  effectiveFrom?: string;
}

/** `POST /platform/pricing/assignments`. Omitted or `null` `orgId` = the platform default. */
export class CreatePricingAssignmentDto {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  orgId?: string | null;

  @IsUUID()
  planId!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @ApiPropertyOptional({ format: 'date-time' })
  effectiveFrom?: string;
}

export class ListProviderCostRatesQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  providerId?: string;
}

export class ListPricingAssignmentsQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  orgId?: string;
}
