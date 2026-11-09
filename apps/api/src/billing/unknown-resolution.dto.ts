import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PAGE_LIMITS } from '@acc/contracts';

/** What an operator may do with an unknown outcome (Policy U). */
export const RESOLUTION_ACTIONS = ['charge', 'write_off'] as const;
/** The lifecycle of a resolution: pending → executed or rejected. */
export const RESOLUTION_STATUSES = ['pending', 'executed', 'rejected'] as const;

/** `POST /platform/billing/unknown-outcomes/:messageId/resolutions` (Phase 7 PR 7-6c). */
export class CreateUnknownResolutionDto {
  @IsIn(RESOLUTION_ACTIONS)
  @ApiProperty({ enum: RESOLUTION_ACTIONS })
  action!: (typeof RESOLUTION_ACTIONS)[number];

  /** Why: recorded on the resolution and in the audit log. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** `POST /platform/billing/resolutions/:id/approve`. */
export class ApproveUnknownResolutionDto {
  /** The customer amount the approver saw on the request; the approval is bound to it. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  expectedAmountPaise!: number;
}

/** `POST /platform/billing/resolutions/:id/reject`. */
export class RejectUnknownResolutionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** `GET /platform/billing/resolutions` — newest first. */
export class ListUnknownResolutionsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PAGE_LIMITS.MIN)
  @Max(PAGE_LIMITS.MAX)
  @ApiPropertyOptional({ type: 'integer', minimum: PAGE_LIMITS.MIN, maximum: PAGE_LIMITS.MAX })
  limit?: number;

  @IsOptional()
  @IsIn(RESOLUTION_STATUSES)
  status?: (typeof RESOLUTION_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  orgId?: string;

  @IsOptional()
  @IsUUID()
  messageId?: string;
}
