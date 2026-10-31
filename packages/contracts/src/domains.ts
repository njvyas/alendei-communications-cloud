/**
 * Domains, Branding & Multi-Tenant Onboarding contract (Phase 4, U12).
 *
 * Implements the approved Alendei domain strategy:
 * - Corporate website: alendei.com (completely separate)
 * - ACC platform login: app.alendei.io
 * - ACC platform administration: admin.alendei.io
 * - Direct customers: customer1.alendei.io
 * - Reseller customers: customer2.alendei.io
 * - White-label customers: their own custom domains, e.g. console.customerbrand.com
 * - ACC API: api.alendei.io
 *
 * Normative Security Invariant (TENANCY.md §7a):
 * Hostname is branding and presentation input only; it NEVER selects tenancy or authorization.
 */

export const DOMAIN_TYPES = ['subdomain', 'custom'] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

export const DOMAIN_STATUSES = ['pending_verification', 'active', 'suspended', 'revoked'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const DOMAIN_VERIFICATION_METHODS = ['dns_txt', 'dns_cname', 'platform_subdomain'] as const;
export type DomainVerificationMethod = (typeof DOMAIN_VERIFICATION_METHODS)[number];

export const DOMAIN_VERIFICATION_STATUSES = ['pending', 'verified', 'failed'] as const;
export type DomainVerificationStatus = (typeof DOMAIN_VERIFICATION_STATUSES)[number];

/**
 * Organization and Reseller Branding configuration.
 */
export interface BrandConfig {
  readonly brandName?: string;
  readonly logoUrl?: string;
  readonly faviconUrl?: string;
  readonly primaryColor?: string;
  readonly accentColor?: string;
  readonly supportEmail?: string;
  readonly supportPhone?: string;
  readonly customCss?: string;
  readonly privacyPolicyUrl?: string;
  readonly termsOfServiceUrl?: string;
}

/**
 * Domain representation returned across management endpoints.
 */
export interface DomainView {
  readonly id: string;
  readonly orgId: string;
  readonly domain: string;
  readonly domainType: DomainType;
  readonly status: DomainStatus;
  readonly verificationMethod: DomainVerificationMethod;
  readonly verificationValue: string;
  readonly verificationStatus: DomainVerificationStatus;
  readonly verifiedAt: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * DNS verification challenge details for custom domains.
 */
export interface DomainDnsRecord {
  readonly type: 'TXT' | 'CNAME';
  readonly name: string;
  readonly value: string;
  readonly ttl: number;
}

export interface DomainVerificationDetails {
  readonly domainId: string;
  readonly domain: string;
  readonly method: DomainVerificationMethod;
  readonly status: DomainVerificationStatus;
  readonly record: DomainDnsRecord;
  readonly instructions: string;
}

/**
 * Public resolution result returned by GET /domains/resolve?hostname=...
 * Always safe to expose publicly prior to authentication.
 */
export interface ResolvedDomainView {
  readonly matched: boolean;
  readonly domain: string;
  readonly domainType: 'platform' | 'subdomain' | 'custom' | 'unrecognized';
  readonly portalType: 'admin' | 'console' | 'customer' | 'reseller' | 'default';
  readonly organization: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly status: string;
    readonly resellerId: string | null;
  } | null;
  readonly branding: BrandConfig;
}

/**
 * Reserved platform hostnames that cannot be registered as customer domains.
 */
export const PLATFORM_RESERVED_DOMAINS: readonly string[] = Object.freeze([
  'alendei.com',
  'www.alendei.com',
  'app.alendei.io',
  'admin.alendei.io',
  'api.alendei.io',
  'alendei.io',
  'localhost',
  '127.0.0.1',
  'status.alendei.io',
  'auth.alendei.io',
  'mail.alendei.io',
  'ns1.alendei.io',
  'ns2.alendei.io',
]);

/**
 * Direct customer onboarding request.
 */
export interface DirectCustomerOnboardingDto {
  readonly name: string;
  readonly slug: string;
  readonly legalName?: string;
  readonly gstin?: string;
  readonly adminUser: {
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly phone?: string;
  };
  readonly subdomain?: string;
  readonly brandConfig?: BrandConfig;
}

/**
 * Reseller-managed customer onboarding request.
 */
export interface ResellerCustomerOnboardingDto extends DirectCustomerOnboardingDto {
  readonly resellerId: string;
}

/**
 * White-label customer onboarding request.
 */
export interface WhiteLabelCustomerOnboardingDto extends DirectCustomerOnboardingDto {
  readonly resellerId?: string;
  readonly customDomain: string;
}

/**
 * Result returned upon successful customer onboarding.
 */
export interface OnboardingResult {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly defaultWorkspaceId: string;
  readonly adminUserId: string;
  readonly domain: DomainView;
  readonly branding: BrandConfig;
  readonly portalUrl: string;
}
