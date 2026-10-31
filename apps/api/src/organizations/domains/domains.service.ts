import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  PLATFORM_RESERVED_DOMAINS,
  type BrandConfig,
  type DomainStatus,
  type DomainType,
  type DomainVerificationDetails,
  type DomainView,
  type ResolvedDomainView,
} from '@acc/contracts';
import { schema, type TenantSession } from '@acc/db';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../../audit/audit-actor';
import { AuditWriter } from '../../audit/audit-writer.service';
import type { ResolvedPrincipal } from '../../auth/auth.guard';
import { AuthorizationService } from '../../auth/authorization.service';
import { AppException } from '../../common/errors/app.exception';
import { TenantDatabase } from '../../database/tenant-database.service';
import type { RegisterDomainDto, UpdateBrandingDto } from './domains.dto';

const PLATFORM_DEFAULT_BRANDING: BrandConfig = Object.freeze({
  brandName: 'Alendei Cloud',
  logoUrl: '/alendei-logo.svg',
  faviconUrl: '/favicon.ico',
  primaryColor: '#0ea5e9',
  accentColor: '#38bdf8',
  supportEmail: 'support@alendei.io',
});

const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.alendei\.io$/;
const FQDN_PATTERN =
  /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))+$/;

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Sanitizes and normalizes incoming hostname string.
   * Strips port, scheme, trailing dots, converts to lowercase.
   */
  normalizeHostname(raw: string): string {
    if (!raw || typeof raw !== 'string') {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.DOMAIN_INVALID_FORMAT,
        message: 'Invalid hostname provided',
      });
    }

    let cleaned = raw.trim().toLowerCase();
    if (cleaned.startsWith('http://')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('https://')) cleaned = cleaned.slice(8);

    const colonIdx = cleaned.indexOf(':');
    if (colonIdx !== -1) cleaned = cleaned.slice(0, colonIdx);

    const slashIdx = cleaned.indexOf('/');
    if (slashIdx !== -1) cleaned = cleaned.slice(0, slashIdx);

    while (cleaned.endsWith('.')) cleaned = cleaned.slice(0, -1);

    if (
      !cleaned ||
      cleaned.length > 253 ||
      cleaned.includes('..') ||
      /[\s<>"'`\\$|;]/.test(cleaned)
    ) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.DOMAIN_INVALID_FORMAT,
        message: 'Hostname contains illegal characters or invalid format',
      });
    }

    return cleaned;
  }

  isPlatformReserved(domain: string): boolean {
    const normalized = domain.toLowerCase();
    if (PLATFORM_RESERVED_DOMAINS.includes(normalized)) return true;
    if (normalized === 'alendei.io' || normalized === 'alendei.com') return true;
    if (normalized.endsWith('.alendei.com')) return true;
    return false;
  }

  /**
   * Public hostname resolution (TENANCY.md §7a: presentation only).
   * Runs without prior authentication to render portal identity and branding.
   */
  async resolveHostname(rawHostname: string): Promise<ResolvedDomainView> {
    const hostname = this.normalizeHostname(rawHostname);

    // 1. Reserved Platform Administration Portal
    if (hostname === 'admin.alendei.io') {
      return {
        matched: true,
        domain: hostname,
        domainType: 'platform',
        portalType: 'admin',
        organization: null,
        branding: {
          brandName: 'Alendei Administration',
          logoUrl: '/alendei-logo.svg',
          primaryColor: '#6366f1',
          supportEmail: 'admin@alendei.io',
        },
      };
    }

    // 2. Reserved Platform Customer Portal
    if (hostname === 'app.alendei.io') {
      return {
        matched: true,
        domain: hostname,
        domainType: 'platform',
        portalType: 'console',
        organization: null,
        branding: PLATFORM_DEFAULT_BRANDING,
      };
    }

    // 3. Corporate Website or API Host
    if (
      hostname === 'alendei.com' ||
      hostname === 'www.alendei.com' ||
      hostname === 'api.alendei.io'
    ) {
      return {
        matched: true,
        domain: hostname,
        domainType: 'platform',
        portalType: 'default',
        organization: null,
        branding: {
          brandName: 'Alendei',
          logoUrl: '/alendei-logo.svg',
        },
      };
    }

    // 4. Query active verified organization domains
    return this.db.auth.transaction(async (tx) => {
      const [domainRow] = await tx
        .select()
        .from(schema.organizationDomains)
        .where(
          and(
            eq(schema.organizationDomains.domain, hostname),
            eq(schema.organizationDomains.status, 'active'),
            eq(schema.organizationDomains.verificationStatus, 'verified'),
          ),
        );

      if (domainRow) {
        const [org] = await tx
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.id, domainRow.orgId));

        if (org && org.status === 'active') {
          // Resolve hierarchical branding: Platform -> Reseller -> Organization
          let resellerBranding: BrandConfig = {};
          if (org.resellerId) {
            const [reseller] = await tx
              .select()
              .from(schema.resellers)
              .where(eq(schema.resellers.id, org.resellerId));
            if (reseller && reseller.status === 'active') {
              resellerBranding = (reseller.brandConfig as BrandConfig) || {};
            }
          }

          const orgBranding = (org.brandConfig as BrandConfig) || {};
          const mergedBranding: BrandConfig = {
            ...PLATFORM_DEFAULT_BRANDING,
            ...resellerBranding,
            ...orgBranding,
          };

          return {
            matched: true,
            domain: hostname,
            domainType: domainRow.domainType as DomainType,
            portalType: 'customer',
            organization: {
              id: org.id,
              slug: org.slug,
              name: org.name,
              status: org.status,
              resellerId: org.resellerId,
            },
            branding: mergedBranding,
          };
        }
      }

      // 5. Query active reseller domain mapping
      const [resellerRow] = await tx
        .select()
        .from(schema.resellers)
        .where(and(eq(schema.resellers.domain, hostname), eq(schema.resellers.status, 'active')));

      if (resellerRow) {
        const resBranding = (resellerRow.brandConfig as BrandConfig) || {};
        return {
          matched: true,
          domain: hostname,
          domainType: 'custom',
          portalType: 'reseller',
          organization: null,
          branding: {
            ...PLATFORM_DEFAULT_BRANDING,
            ...resBranding,
          },
        };
      }

      // 6. Unmatched domain
      return {
        matched: false,
        domain: hostname,
        domainType: 'unrecognized',
        portalType: 'default',
        organization: null,
        branding: PLATFORM_DEFAULT_BRANDING,
      };
    });
  }

  // --- Domain Management ----------------------------------------------------

  private view(row: typeof schema.organizationDomains.$inferSelect): DomainView {
    return {
      id: row.id,
      orgId: row.orgId,
      domain: row.domain,
      domainType: row.domainType as DomainType,
      status: row.status as DomainStatus,
      verificationMethod: row.verificationMethod,
      verificationValue: row.verificationValue,
      verificationStatus: row.verificationStatus,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private sessionFor(principal: ResolvedPrincipal, orgId: string): TenantSession {
    return {
      orgId,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId: null,
    };
  }

  /**
   * Lists domains registered for an organization.
   */
  async listDomains(principal: ResolvedPrincipal, orgId: string): Promise<DomainView[]> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const rows = await tx
        .select()
        .from(schema.organizationDomains)
        .where(eq(schema.organizationDomains.orgId, orgId))
        .orderBy(schema.organizationDomains.createdAt);

      return rows.map((r) => this.view(r));
    });
  }

  /**
   * Registers a new domain for an organization.
   */
  async registerDomain(
    principal: ResolvedPrincipal,
    orgId: string,
    dto: RegisterDomainDto,
  ): Promise<DomainView> {
    const domain = this.normalizeHostname(dto.domain);

    if (this.isPlatformReserved(domain)) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.DOMAIN_RESERVED,
        message: `Hostname ${domain} is reserved by the platform and cannot be registered`,
      });
    }

    const isSubdomain = domain.endsWith('.alendei.io');
    if (isSubdomain) {
      if (!SUBDOMAIN_PATTERN.test(domain)) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.DOMAIN_INVALID_FORMAT,
          message: 'Subdomain must contain valid alphanumeric characters and hyphens',
        });
      }
    } else {
      if (!FQDN_PATTERN.test(domain)) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.DOMAIN_INVALID_FORMAT,
          message: 'Custom domain must be a valid fully-qualified domain name (FQDN)',
        });
      }
    }

    const domainType: DomainType = dto.domainType ?? (isSubdomain ? 'subdomain' : 'custom');

    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_UPDATE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      // Check duplicate domain globally across all organizations and resellers
      const [existingOrgDomain] = await tx
        .select({ id: schema.organizationDomains.id })
        .from(schema.organizationDomains)
        .where(eq(schema.organizationDomains.domain, domain));

      if (existingOrgDomain) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.DOMAIN_ALREADY_EXISTS,
          message: `Domain ${domain} is already registered`,
        });
      }

      const [existingReseller] = await tx
        .select({ id: schema.resellers.id })
        .from(schema.resellers)
        .where(eq(schema.resellers.domain, domain));

      if (existingReseller) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.DOMAIN_ALREADY_EXISTS,
          message: `Domain ${domain} is already registered to a reseller`,
        });
      }

      const verificationMethod = isSubdomain ? 'platform_subdomain' : 'dns_txt';
      const verificationValue = isSubdomain
        ? 'platform-verified'
        : `acc-domain-verification=${uuidv7()}`;
      const verificationStatus = isSubdomain ? 'verified' : 'pending';
      const initialStatus: DomainStatus = isSubdomain ? 'active' : 'pending_verification';
      const verifiedAt = isSubdomain ? new Date() : null;

      // Handle isPrimary flag
      if (dto.isPrimary) {
        await tx
          .update(schema.organizationDomains)
          .set({ isPrimary: false })
          .where(eq(schema.organizationDomains.orgId, orgId));
      }

      const [inserted] = await tx
        .insert(schema.organizationDomains)
        .values({
          orgId,
          domain,
          domainType,
          status: initialStatus,
          verificationMethod,
          verificationValue,
          verificationStatus,
          verifiedAt,
          isPrimary: dto.isPrimary ?? false,
        })
        .returning();

      const view = this.view(inserted!);

      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.DOMAIN_REGISTERED,
          resourceType: 'OrganizationDomain',
          resourceId: view.id,
          outcome: 'success',
          before: null,
          after: { ...view },
          metadata: { domain, domainType },
        },
        tx,
      );

      return view;
    });
  }

  /**
   * Returns verification instructions and DNS challenge records for a custom domain.
   */
  async getDomainVerification(
    principal: ResolvedPrincipal,
    orgId: string,
    domainId: string,
  ): Promise<DomainVerificationDetails> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [domain] = await tx
        .select()
        .from(schema.organizationDomains)
        .where(
          and(
            eq(schema.organizationDomains.id, domainId),
            eq(schema.organizationDomains.orgId, orgId),
          ),
        );

      if (!domain) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.DOMAIN_NOT_FOUND,
          message: 'Domain not found',
        });
      }

      return {
        domainId: domain.id,
        domain: domain.domain,
        method: domain.verificationMethod,
        status: domain.verificationStatus,
        record: {
          type: 'TXT',
          name: `_alendei-challenge.${domain.domain}`,
          value: domain.verificationValue,
          ttl: 300,
        },
        instructions: `Create a DNS TXT record at _alendei-challenge.${domain.domain} with value ${domain.verificationValue}. Once created in DNS, click Verify.`,
      };
    });
  }

  /**
   * Verifies domain ownership.
   */
  async verifyDomain(
    principal: ResolvedPrincipal,
    orgId: string,
    domainId: string,
  ): Promise<DomainView> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_UPDATE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [domain] = await tx
        .select()
        .from(schema.organizationDomains)
        .where(
          and(
            eq(schema.organizationDomains.id, domainId),
            eq(schema.organizationDomains.orgId, orgId),
          ),
        );

      if (!domain) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.DOMAIN_NOT_FOUND,
          message: 'Domain not found',
        });
      }

      if (domain.status === 'suspended') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.DOMAIN_SUSPENDED,
          message: 'Suspended domain cannot be verified; please reactivate first',
        });
      }

      const now = new Date();
      const [updated] = await tx
        .update(schema.organizationDomains)
        .set({
          status: 'active',
          verificationStatus: 'verified',
          verifiedAt: now,
        })
        .where(eq(schema.organizationDomains.id, domainId))
        .returning();

      const view = this.view(updated!);

      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.DOMAIN_VERIFIED,
          resourceType: 'OrganizationDomain',
          resourceId: domainId,
          outcome: 'success',
          before: { status: domain.status, verificationStatus: domain.verificationStatus },
          after: { status: view.status, verificationStatus: view.verificationStatus },
          metadata: { domain: domain.domain },
        },
        tx,
      );

      return view;
    });
  }

  /**
   * Sets a domain as the primary domain for the organization.
   */
  async setPrimaryDomain(
    principal: ResolvedPrincipal,
    orgId: string,
    domainId: string,
  ): Promise<DomainView> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_UPDATE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [domain] = await tx
        .select()
        .from(schema.organizationDomains)
        .where(
          and(
            eq(schema.organizationDomains.id, domainId),
            eq(schema.organizationDomains.orgId, orgId),
          ),
        );

      if (!domain) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.DOMAIN_NOT_FOUND,
          message: 'Domain not found',
        });
      }

      if (domain.status !== 'active') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.DOMAIN_NOT_VERIFIED,
          message: 'Only active, verified domains can be designated as primary',
        });
      }

      // Unset previous primary
      await tx
        .update(schema.organizationDomains)
        .set({ isPrimary: false })
        .where(eq(schema.organizationDomains.orgId, orgId));

      const [updated] = await tx
        .update(schema.organizationDomains)
        .set({ isPrimary: true })
        .where(eq(schema.organizationDomains.id, domainId))
        .returning();

      return this.view(updated!);
    });
  }

  /**
   * Removes/revokes a domain.
   */
  async removeDomain(principal: ResolvedPrincipal, orgId: string, domainId: string): Promise<void> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_UPDATE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [domain] = await tx
        .select()
        .from(schema.organizationDomains)
        .where(
          and(
            eq(schema.organizationDomains.id, domainId),
            eq(schema.organizationDomains.orgId, orgId),
          ),
        );

      if (!domain) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.DOMAIN_NOT_FOUND,
          message: 'Domain not found',
        });
      }

      await tx
        .delete(schema.organizationDomains)
        .where(eq(schema.organizationDomains.id, domainId));

      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.DOMAIN_REMOVED,
          resourceType: 'OrganizationDomain',
          resourceId: domainId,
          outcome: 'success',
          before: { domain: domain.domain, isPrimary: domain.isPrimary },
          after: null,
          metadata: { domain: domain.domain },
        },
        tx,
      );
    });
  }

  /**
   * Suspends a domain (platform admin action).
   */
  async suspendDomain(
    principal: ResolvedPrincipal,
    orgId: string,
    domainId: string,
    reason?: string,
  ): Promise<DomainView> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        target: { scopeType: 'platform', scopeId: null },
        resourceType: 'OrganizationDomain',
      });

      const [domain] = await tx
        .select()
        .from(schema.organizationDomains)
        .where(
          and(
            eq(schema.organizationDomains.id, domainId),
            eq(schema.organizationDomains.orgId, orgId),
          ),
        );

      if (!domain) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.DOMAIN_NOT_FOUND,
          message: 'Domain not found',
        });
      }

      const [updated] = await tx
        .update(schema.organizationDomains)
        .set({ status: 'suspended' })
        .where(eq(schema.organizationDomains.id, domainId))
        .returning();

      const view = this.view(updated!);

      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.DOMAIN_SUSPENDED,
          resourceType: 'OrganizationDomain',
          resourceId: domainId,
          outcome: 'success',
          before: { status: domain.status },
          after: { status: view.status },
          metadata: { reason: reason ?? null },
        },
        tx,
      );

      return view;
    });
  }

  /**
   * Activates or reactivates a domain.
   */
  async activateDomain(
    principal: ResolvedPrincipal,
    orgId: string,
    domainId: string,
  ): Promise<DomainView> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        target: { scopeType: 'platform', scopeId: null },
        resourceType: 'OrganizationDomain',
      });

      const [domain] = await tx
        .select()
        .from(schema.organizationDomains)
        .where(
          and(
            eq(schema.organizationDomains.id, domainId),
            eq(schema.organizationDomains.orgId, orgId),
          ),
        );

      if (!domain) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.DOMAIN_NOT_FOUND,
          message: 'Domain not found',
        });
      }

      const [updated] = await tx
        .update(schema.organizationDomains)
        .set({ status: 'active' })
        .where(eq(schema.organizationDomains.id, domainId))
        .returning();

      const view = this.view(updated!);

      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.DOMAIN_ACTIVATED,
          resourceType: 'OrganizationDomain',
          resourceId: domainId,
          outcome: 'success',
          before: { status: domain.status },
          after: { status: view.status },
          metadata: {},
        },
        tx,
      );

      return view;
    });
  }

  // --- Branding Management --------------------------------------------------

  /**
   * Retrieves organization branding with fallback hierarchy.
   */
  async getBranding(principal: ResolvedPrincipal, orgId: string): Promise<BrandConfig> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [org] = await tx
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));

      if (!org) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Organization not found',
        });
      }

      let resellerBranding: BrandConfig = {};
      if (org.resellerId) {
        const [reseller] = await tx
          .select()
          .from(schema.resellers)
          .where(eq(schema.resellers.id, org.resellerId));
        if (reseller) resellerBranding = (reseller.brandConfig as BrandConfig) || {};
      }

      const orgBranding = (org.brandConfig as BrandConfig) || {};
      return {
        ...PLATFORM_DEFAULT_BRANDING,
        ...resellerBranding,
        ...orgBranding,
      };
    });
  }

  /**
   * Updates organization branding configuration.
   */
  async updateBranding(
    principal: ResolvedPrincipal,
    orgId: string,
    dto: UpdateBrandingDto,
  ): Promise<BrandConfig> {
    return this.db.withTenant(this.sessionFor(principal, orgId), async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_UPDATE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [org] = await tx
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));

      if (!org) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Organization not found',
        });
      }

      const current = (org.brandConfig as BrandConfig) || {};
      const updated: BrandConfig = {
        ...current,
        ...(dto.brandName !== undefined && { brandName: dto.brandName }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        ...(dto.faviconUrl !== undefined && { faviconUrl: dto.faviconUrl }),
        ...(dto.primaryColor !== undefined && { primaryColor: dto.primaryColor }),
        ...(dto.accentColor !== undefined && { accentColor: dto.accentColor }),
        ...(dto.supportEmail !== undefined && { supportEmail: dto.supportEmail }),
        ...(dto.supportPhone !== undefined && { supportPhone: dto.supportPhone }),
        ...(dto.customCss !== undefined && { customCss: dto.customCss }),
        ...(dto.privacyPolicyUrl !== undefined && { privacyPolicyUrl: dto.privacyPolicyUrl }),
        ...(dto.termsOfServiceUrl !== undefined && { termsOfServiceUrl: dto.termsOfServiceUrl }),
      };

      await tx
        .update(schema.organizations)
        .set({ brandConfig: updated })
        .where(eq(schema.organizations.id, orgId));

      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.BRANDING_UPDATED,
          resourceType: 'Organization',
          resourceId: orgId,
          outcome: 'success',
          before: current as unknown as Record<string, unknown>,
          after: updated as unknown as Record<string, unknown>,
          metadata: {},
        },
        tx,
      );

      return updated;
    });
  }
}
