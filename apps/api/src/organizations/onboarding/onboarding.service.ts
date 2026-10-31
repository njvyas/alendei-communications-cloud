import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  type BrandConfig,
  type DomainStatus,
  type DomainType,
  type DomainVerificationMethod,
  type DomainVerificationStatus,
  type OnboardingResult,
} from '@acc/contracts';
import { schema, tenantContextStatements, type TenantSession, type Transaction } from '@acc/db';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../../audit/audit-actor';
import { AuditWriter } from '../../audit/audit-writer.service';
import type { ResolvedPrincipal } from '../../auth/auth.guard';
import { AuthorizationService } from '../../auth/authorization.service';
import { AppException } from '../../common/errors/app.exception';
import { TenantDatabase } from '../../database/tenant-database.service';
import { DomainsService } from '../domains/domains.service';
import { TenantRoleProvisioner } from '../../rbac/tenant-role-provisioner.service';
import type {
  DirectCustomerOnboardingDto,
  ResellerCustomerOnboardingDto,
  WhiteLabelCustomerOnboardingDto,
} from './onboarding.dto';

const DEFAULT_WORKSPACE = { name: 'Default', slug: 'default' } as const;

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly provisioner: TenantRoleProvisioner,
    private readonly domains: DomainsService,
    private readonly audit: AuditWriter,
  ) {}

  private async platformDefaultReseller(tx: Transaction): Promise<string> {
    const [row] = await tx
      .select({ id: schema.resellers.id })
      .from(schema.resellers)
      .where(eq(schema.resellers.isPlatformDefault, true));

    if (!row) {
      throw new Error('Onboarding failed: platform default reseller is missing');
    }
    return row.id;
  }

  /**
   * Direct customer onboarding.
   * Onboards customer beneath platform-default reseller (Alendei Direct)
   * with automatic default workspace, tenant roles, subdomain and org_admin user.
   */
  async onboardDirectCustomer(
    principal: ResolvedPrincipal,
    dto: DirectCustomerOnboardingDto,
  ): Promise<OnboardingResult> {
    const isPlatform = principal.tenant.isPlatformAdmin;
    const authSession: TenantSession = {
      orgId: principal.tenant.orgId,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId: null,
    };

    return this.db.withTenant(authSession, async (tx) => {
      // 1. Authorize: Requires PLATFORM_TENANTS_MANAGE or ORGANIZATIONS_CREATE
      if (isPlatform) {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Organization',
        });
      } else {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.ORGANIZATIONS_CREATE,
          target: { scopeType: 'organization', scopeId: principal.tenant.orgId },
          resourceType: 'Organization',
        });
      }

      const resellerId = await this.platformDefaultReseller(tx);
      return this.executeOnboarding(tx, principal, resellerId, dto, 'direct');
    });
  }

  /**
   * Reseller-managed customer onboarding.
   * Onboards customer beneath a designated external reseller.
   */
  async onboardResellerCustomer(
    principal: ResolvedPrincipal,
    dto: ResellerCustomerOnboardingDto,
  ): Promise<OnboardingResult> {
    const authSession: TenantSession = {
      orgId: principal.tenant.orgId,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId: dto.resellerId,
    };

    return this.db.withTenant(authSession, async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_CREATE,
        target: { scopeType: 'reseller', scopeId: dto.resellerId },
        resourceType: 'Reseller',
      });

      // Verify reseller exists and is active
      const [reseller] = await tx
        .select()
        .from(schema.resellers)
        .where(eq(schema.resellers.id, dto.resellerId));

      if (!reseller || reseller.status !== 'active') {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
          message: 'Target reseller does not exist or is not active',
        });
      }

      return this.executeOnboarding(tx, principal, dto.resellerId, dto, 'reseller');
    });
  }

  /**
   * White-label customer onboarding.
   * Onboards customer with custom brand domain and distinct brandConfig.
   */
  async onboardWhiteLabelCustomer(
    principal: ResolvedPrincipal,
    dto: WhiteLabelCustomerOnboardingDto,
  ): Promise<OnboardingResult> {
    let targetResellerId = dto.resellerId ?? null;
    const authSession: TenantSession = {
      orgId: principal.tenant.orgId,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId: targetResellerId,
    };

    return this.db.withTenant(authSession, async (tx) => {
      if (!targetResellerId) {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Organization',
        });
        targetResellerId = await this.platformDefaultReseller(tx);
      } else {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.ORGANIZATIONS_CREATE,
          target: { scopeType: 'reseller', scopeId: targetResellerId },
          resourceType: 'Reseller',
        });
      }

      return this.executeOnboarding(tx, principal, targetResellerId, dto, 'white_label');
    });
  }

  private async executeOnboarding(
    tx: Transaction,
    principal: ResolvedPrincipal,
    resellerId: string,
    dto:
      DirectCustomerOnboardingDto | ResellerCustomerOnboardingDto | WhiteLabelCustomerOnboardingDto,
    onboardingType: 'direct' | 'reseller' | 'white_label',
  ): Promise<OnboardingResult> {
    const orgId = uuidv7();
    const subdomainName = `${dto.subdomain || dto.slug}.alendei.io`.toLowerCase();

    // Check duplicate organization slug
    const [existingOrg] = await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, dto.slug));

    if (existingOrg) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.RESOURCE_CONFLICT,
        message: `An organization with slug '${dto.slug}' already exists`,
      });
    }

    // Check duplicate subdomain
    const [existingDomain] = await tx
      .select({ id: schema.organizationDomains.id })
      .from(schema.organizationDomains)
      .where(eq(schema.organizationDomains.domain, subdomainName));

    if (existingDomain) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.DOMAIN_ALREADY_EXISTS,
        message: `Domain '${subdomainName}' is already registered`,
      });
    }

    // Elevate to provisioning context
    for (const statement of tenantContextStatements({
      orgId,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId,
      provisioning: true,
    })) {
      await tx.execute(statement);
    }

    // 1. Create Organization
    const brandConfig: BrandConfig = dto.brandConfig || {};
    const [org] = await tx
      .insert(schema.organizations)
      .values({
        id: orgId,
        resellerId,
        name: dto.name,
        slug: dto.slug,
        legalName: dto.legalName ?? null,
        gstin: dto.gstin ?? null,
        status: 'active',
        brandConfig,
      })
      .returning();

    // 2. Seed canonical tenant roles (org_admin, org_member, org_billing)
    await this.provisioner.seedTenantRoles(tx, orgId);

    // 3. Create Default Workspace
    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({
        orgId,
        name: DEFAULT_WORKSPACE.name,
        slug: DEFAULT_WORKSPACE.slug,
        isDefault: true,
      })
      .returning({ id: schema.workspaces.id });

    // 4. Create Subdomain Mapping
    const [subdomainRow] = await tx
      .insert(schema.organizationDomains)
      .values({
        orgId,
        domain: subdomainName,
        domainType: 'subdomain',
        status: 'active',
        verificationMethod: 'platform_subdomain',
        verificationValue: 'platform-verified',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        isPrimary: onboardingType !== 'white_label',
      })
      .returning();

    let primaryDomainView = subdomainRow!;

    // 5. Handle Custom Domain for White-Label
    if ('customDomain' in dto && dto.customDomain) {
      const customDomain = this.domains.normalizeHostname(dto.customDomain);

      if (this.domains.isPlatformReserved(customDomain)) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.DOMAIN_RESERVED,
          message: `Custom domain ${customDomain} is platform-reserved`,
        });
      }

      const [customRow] = await tx
        .insert(schema.organizationDomains)
        .values({
          orgId,
          domain: customDomain,
          domainType: 'custom',
          status: 'pending_verification',
          verificationMethod: 'dns_txt',
          verificationValue: `acc-domain-verification=${uuidv7()}`,
          verificationStatus: 'pending',
          isPrimary: true,
        })
        .returning();

      primaryDomainView = customRow!;
    }

    // 6. Admin User Setup & Invitation
    let adminUserId: string;
    const [existingUser] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, dto.adminUser.email));

    if (existingUser) {
      adminUserId = existingUser.id;
    } else {
      const [newUser] = await tx
        .insert(schema.users)
        .values({
          email: dto.adminUser.email,
          phone: dto.adminUser.phone ?? null,
          status: 'invited',
        })
        .returning({ id: schema.users.id });
      adminUserId = newUser!.id;
    }

    // 7. Grant org_admin role to admin user
    const [orgAdminRole] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.key, 'org_admin')));

    if (orgAdminRole) {
      await tx
        .insert(schema.userRoles)
        .values({
          userId: adminUserId,
          roleId: orgAdminRole.id,
          scopeType: 'organization',
          scopeId: orgId,
          orgId,
        })
        .onConflictDoNothing();
    }

    // 8. Record structured audit event
    await this.audit.record(
      {
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.CUSTOMER_ONBOARDED,
        resourceType: 'Organization',
        resourceId: orgId,
        outcome: 'success',
        before: null,
        after: {
          orgId,
          name: org!.name,
          slug: org!.slug,
          resellerId,
          adminUserEmail: dto.adminUser.email,
          onboardingType,
          primaryDomain: primaryDomainView.domain,
        },
        metadata: { onboardingType, resellerId },
      },
      tx,
    );

    return {
      organizationId: orgId,
      organizationSlug: org!.slug,
      organizationName: org!.name,
      defaultWorkspaceId: workspace!.id,
      adminUserId,
      domain: {
        id: primaryDomainView.id,
        orgId,
        domain: primaryDomainView.domain,
        domainType: primaryDomainView.domainType as DomainType,
        status: primaryDomainView.status as DomainStatus,
        verificationMethod: primaryDomainView.verificationMethod as DomainVerificationMethod,
        verificationValue: primaryDomainView.verificationValue,
        verificationStatus: primaryDomainView.verificationStatus as DomainVerificationStatus,
        verifiedAt: primaryDomainView.verifiedAt
          ? primaryDomainView.verifiedAt.toISOString()
          : null,
        isPrimary: primaryDomainView.isPrimary,
        createdAt: primaryDomainView.createdAt.toISOString(),
        updatedAt: primaryDomainView.updatedAt.toISOString(),
      },
      branding: brandConfig,
      portalUrl: `https://${primaryDomainView.domain}`,
    };
  }
}
