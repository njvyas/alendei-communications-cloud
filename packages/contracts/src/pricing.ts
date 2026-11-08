/**
 * Phase 7 PR 7-2 — pricing and rating (DECISIONS.md §1zi; Phase 7.2 handover,
 * owner-approved 08-Nov-2026: OD-P-1, OD-P-2, OD-P-3).
 *
 * Rates are integers in 1/10,000 of a paisa (`…E4`). Amounts are rounded half
 * up to whole paise once per price component per rated transaction, by the
 * database (`app_rate_message`); nothing here rounds.
 */

/** 1 paisa = 10,000 rate units (OD-P-1). */
export const PRICING_RATE_SCALE = 10_000;
/** The largest unit price or unit cost, in 1/10,000 paisa (₹1,000,000 per unit). */
export const PRICING_RATE_MAX_E4 = 1_000_000_000_000;
/** The most rules one rate-card version may carry. */
export const PRICING_RULES_MAX = 200;

export const PRICING_VERSION_STATUSES = ['draft', 'active'] as const;
export type PricingVersionStatus = (typeof PRICING_VERSION_STATUSES)[number];

/** SMS is priced per segment; WhatsApp and RCS at one unit per message. */
export const PRICING_UNITS = ['sms_segment', 'message'] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

export interface PricingPlanResponse {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
}

export interface PricingPlanVersionSummaryResponse {
  readonly id: string;
  readonly planId: string;
  readonly versionNumber: number;
  readonly status: PricingVersionStatus;
  readonly effectiveFrom: string | null;
  readonly activatedAt: string | null;
  readonly createdAt: string;
}

export interface PricingPlanDetailResponse extends PricingPlanResponse {
  readonly versions: readonly PricingPlanVersionSummaryResponse[];
}

export interface PricingRuleResponse {
  readonly id: string;
  readonly channelId: string;
  readonly channelCode: string;
  readonly providerId: string | null;
  readonly unit: PricingUnit;
  readonly unitPriceE4: number;
}

export interface PricingPlanVersionResponse extends PricingPlanVersionSummaryResponse {
  readonly rules: readonly PricingRuleResponse[];
}

export interface ProviderCostRateResponse {
  readonly id: string;
  readonly providerId: string;
  readonly channelId: string;
  readonly channelCode: string;
  readonly unit: PricingUnit;
  readonly unitCostE4: number;
  readonly effectiveFrom: string;
  readonly createdAt: string;
}

export interface PricingAssignmentResponse {
  readonly id: string;
  /** `null` is the platform default rate card. */
  readonly orgId: string | null;
  readonly planId: string;
  readonly effectiveFrom: string;
  readonly createdAt: string;
}
