/**
 * Resellers and Multi-Tenant Hierarchy contract (Phase 4, U13).
 *
 * Reseller tenant boundaries:
 * Alendei Platform -> Reseller -> Organization (Customer) -> Workspace -> Team
 */
import type { BrandConfig } from './domains';

export const RESELLER_STATUSES = ['active', 'suspended', 'closed'] as const;
export type ResellerStatus = (typeof RESELLER_STATUSES)[number];

export interface ResellerView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly domain: string | null;
  readonly brandConfig: BrandConfig;
  readonly defaultMarkupPct: string;
  readonly status: ResellerStatus;
  readonly isPlatformDefault: boolean;
  readonly customerCount?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResellerOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly domainCount?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateResellerInput {
  readonly name: string;
  readonly slug: string;
  readonly domain?: string | null;
  readonly defaultMarkupPct?: number | string;
  readonly brandConfig?: BrandConfig;
}

export interface UpdateResellerInput {
  readonly name?: string;
  readonly domain?: string | null;
  readonly defaultMarkupPct?: number | string;
  readonly brandConfig?: BrandConfig;
}

export interface ResellerTransitionInput {
  readonly reason?: string | null;
}
