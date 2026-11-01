import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RESELLER_STATUSES, type ResellerStatus } from '@acc/contracts';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { UpdateBrandingDto } from '../domains/domains.dto';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HOSTNAME = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const MARKUP_PCT = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3})?)$/;

export class CreateResellerDto {
  @ApiProperty({
    description: 'Display name of the reseller',
    example: 'Apex Global Communications',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    description: 'Unique URL-friendly slug for the reseller',
    example: 'apex-global',
    pattern: SLUG.source,
  })
  @Matches(SLUG, { message: 'slug must be 2-63 lower-case letters, digits or hyphens' })
  slug!: string;

  @ApiPropertyOptional({
    description: 'Primary custom white-label domain or subdomain for the reseller console',
    example: 'console.apextelecom.com',
    pattern: HOSTNAME.source,
  })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined)
  @Matches(HOSTNAME, { message: 'domain must be a valid fully-qualified domain name' })
  domain?: string | null;

  @ApiPropertyOptional({
    description:
      'Default markup percentage applied to provider rates for customer organizations beneath this reseller',
    example: '15.000',
    default: '0',
    pattern: MARKUP_PCT.source,
  })
  @IsOptional()
  @Matches(MARKUP_PCT, { message: 'defaultMarkupPct must be a valid non-negative percentage' })
  defaultMarkupPct?: string;

  @ApiPropertyOptional({
    description: 'Optional white-label branding configuration for the reseller portal',
    type: () => UpdateBrandingDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateBrandingDto)
  brandConfig?: UpdateBrandingDto;
}

export class UpdateResellerDto {
  @ApiPropertyOptional({
    description: 'Display name of the reseller',
    example: 'Apex Global Telecom Inc.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    description: 'Custom white-label domain for the reseller console (platform administrator only)',
    example: 'portal.apextelecom.com',
    pattern: HOSTNAME.source,
  })
  @IsOptional()
  @ValidateIf((_, val) => val !== null && val !== undefined)
  @Matches(HOSTNAME, { message: 'domain must be a valid fully-qualified domain name' })
  domain?: string | null;

  @ApiPropertyOptional({
    description: 'Default markup percentage applied to provider rates',
    example: '20.000',
    pattern: MARKUP_PCT.source,
  })
  @IsOptional()
  @Matches(MARKUP_PCT, { message: 'defaultMarkupPct must be a valid non-negative percentage' })
  defaultMarkupPct?: string;

  @ApiPropertyOptional({
    description: 'White-label branding configuration for the reseller portal',
    type: () => UpdateBrandingDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateBrandingDto)
  brandConfig?: UpdateBrandingDto;
}

export class ResellerTransitionDto {
  @ApiPropertyOptional({
    description: 'Operator stated reason for the lifecycle transition',
    example: 'Policy compliance suspension',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListResellersQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by reseller status',
    enum: RESELLER_STATUSES,
  })
  @IsOptional()
  @IsIn(RESELLER_STATUSES)
  status?: ResellerStatus;
}
