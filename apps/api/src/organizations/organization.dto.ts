import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { ListQueryDto } from '../common/http/list-query.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const ORGANIZATION_STATUSES = ['active', 'suspended', 'closed'] as const;
export type OrganizationStatusValue = (typeof ORGANIZATION_STATUSES)[number];
export const BILLING_MODES = ['prepaid', 'postpaid'] as const;
export const BILLING_POLICIES = ['charge_per_logical_message', 'charge_per_attempt'] as const;

/** Mirrors `organizations_gstin_format` (migration `0000`), so a bad value is a `400`, not a constraint error. */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
/** Lower-case letters, digits and hyphens; starts with a letter or digit; 2–63 characters. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** `POST /organizations` (`FRONTEND_API_CONTRACT.md` §31a). */
export class CreateOrganizationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @Matches(SLUG, { message: 'slug must be 2-63 lower-case letters, digits or hyphens' })
  @ApiProperty({ pattern: SLUG.source })
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @Matches(GSTIN, { message: 'gstin must be a valid 15-character GSTIN' })
  @ApiPropertyOptional({ pattern: GSTIN.source })
  gstin?: string;

  /**
   * The reseller the organization is created beneath — a **target**, never an
   * authority claim. Authority to create beneath it is decided from the
   * caller's grants (ADR-012 F-3).
   */
  @IsOptional()
  @IsUUID()
  resellerId?: string;

  /** Platform principals only (ADR-012 F-8). */
  @IsOptional()
  @IsIn(BILLING_MODES)
  billingMode?: (typeof BILLING_MODES)[number];

  /** Platform principals only (ADR-012 F-8). */
  @IsOptional()
  @IsIn(BILLING_POLICIES)
  billingPolicy?: (typeof BILLING_POLICIES)[number];
}

/**
 * `PATCH /organizations/:id`. `slug`, `resellerId` and `status` are absent on
 * purpose: the validation pipe refuses any unlisted field with `400`, so they
 * cannot be changed here (ADR-012 F-8; status changes through the lifecycle
 * routes only).
 */
export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(200)
  legalName?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(GSTIN, { message: 'gstin must be a valid 15-character GSTIN' })
  @ApiPropertyOptional({ pattern: GSTIN.source, nullable: true, type: String })
  gstin?: string | null;

  @IsOptional()
  @IsIn(BILLING_MODES)
  billingMode?: (typeof BILLING_MODES)[number];

  @IsOptional()
  @IsIn(BILLING_POLICIES)
  billingPolicy?: (typeof BILLING_POLICIES)[number];
}

/** Body of `POST /organizations/:id/suspend` · `/reactivate` · `/close`. */
export class OrganizationTransitionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** `GET /organizations` filters. Both narrow within the caller's reach; neither widens it. */
export class ListOrganizationsQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(ORGANIZATION_STATUSES)
  status?: OrganizationStatusValue;

  @IsOptional()
  @IsUUID()
  resellerId?: string;
}
