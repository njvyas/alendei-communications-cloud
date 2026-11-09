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

/** The two billing accounts an organization may have (one each). */
export const BILLING_ACCOUNTS = ['wallet', 'credit_account'] as const;
export type BillingAccountName = (typeof BILLING_ACCOUNTS)[number];
/** Phase 7 PR 7-6d-1 operation kinds; recharge arrives in 7-6d-2. */
export const ACCOUNT_OPERATION_KINDS = [
  'provision',
  'credit_limit_change',
  'freeze',
  'unfreeze',
] as const;
export type AccountOperationKind = (typeof ACCOUNT_OPERATION_KINDS)[number];
export const ACCOUNT_OPERATION_STATUSES = ['pending', 'executed', 'rejected'] as const;

/**
 * A request that carries only its reason: provisioning, freeze and unfreeze. The
 * dual-control threshold is server configuration and is never accepted from a request
 * (an unknown property is refused, `400`).
 */
export class AccountOperationReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** `POST /platform/billing/organizations/:orgId/credit-limit`. */
export class CreditLimitChangeDto {
  /** The new credit limit, integer paise. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  newLimitPaise!: number;

  /** The limit the requester saw; the change is bound to it (stale otherwise). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  previousLimitPaise!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** `POST /platform/billing/account-operations/:id/approve`. */
export class ApproveAccountOperationDto {
  /**
   * The amount the approver saw: the new credit limit for a credit-limit change; absent
   * for an operation without an amount (an unfreeze). The approval is bound to it.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  expectedAmountPaise?: number;
}

/** `GET /platform/billing/account-operations` — newest first. */
export class ListAccountOperationsQueryDto {
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
  @IsUUID()
  orgId?: string;

  @IsOptional()
  @IsIn(BILLING_ACCOUNTS)
  account?: BillingAccountName;

  @IsOptional()
  @IsIn(ACCOUNT_OPERATION_KINDS)
  kind?: AccountOperationKind;

  @IsOptional()
  @IsIn(ACCOUNT_OPERATION_STATUSES)
  status?: (typeof ACCOUNT_OPERATION_STATUSES)[number];
}
