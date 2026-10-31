import { AUDIT_ACTIONS, ERROR_CODES } from '@acc/contracts';
import { OnboardingService } from './onboarding.service';
import type { ResolvedPrincipal } from '../../auth/auth.guard';
import type { TenantDatabase } from '../../database/tenant-database.service';
import type { AuthorizationService } from '../../auth/authorization.service';
import type { TenantRoleProvisioner } from '../../rbac/tenant-role-provisioner.service';
import type { DomainsService } from '../domains/domains.service';
import type { AuditWriter } from '../../audit/audit-writer.service';

interface MockDb {
  withTenant: jest.Mock;
  execute: jest.Mock;
  select: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  insert: jest.Mock;
  values: jest.Mock;
  returning: jest.Mock;
  onConflictDoNothing: jest.Mock;
}

interface MockAuth {
  assert: jest.Mock;
}

interface MockProvisioner {
  seedTenantRoles: jest.Mock;
  assignUserRole?: jest.Mock;
}

interface MockDomains {
  normalizeHostname: jest.Mock;
  isPlatformReserved?: jest.Mock;
  registerDomain?: jest.Mock;
  getDomainVerificationDetails?: jest.Mock;
}

interface MockAudit {
  record: jest.Mock;
}

describe('OnboardingService', () => {
  let service: OnboardingService;
  let mockDb: MockDb;
  let mockAuth: MockAuth;
  let mockProvisioner: MockProvisioner;
  let mockDomains: MockDomains;
  let mockAudit: MockAudit;

  const mockPrincipal: ResolvedPrincipal = {
    userId: '01955b0a-7b3b-7411-9a4f-000000000001',
    apiKeyId: null,
    sessionId: '01955b0a-7b3b-7411-9a4f-000000000002',
    actorType: 'user',
    tenant: {
      orgId: '01955b0a-7b3b-7411-9a4f-000000000010',
      workspaceId: '01955b0a-7b3b-7411-9a4f-000000000020',
      resellerId: null,
      isPlatformAdmin: true,
    },
    roles: [],
    permissions: [],
    authMethod: 'session',
    authenticatedAt: new Date(),
    authorizedOrganizationIds: ['01955b0a-7b3b-7411-9a4f-000000000010'],
    organizationStatus: 'active',
    inactiveOrganizations: {},
  };

  beforeEach(() => {
    mockDb = {
      withTenant: jest.fn(async (_session, work) => work(mockDb)),
      execute: jest.fn().mockResolvedValue({}),
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      onConflictDoNothing: jest.fn().mockResolvedValue({}),
    };

    mockAuth = {
      assert: jest.fn().mockResolvedValue(true),
    };

    mockProvisioner = {
      seedTenantRoles: jest.fn().mockResolvedValue({ created: ['org_admin'], existing: [] }),
    };

    mockDomains = {
      normalizeHostname: jest.fn((h) => h.trim().toLowerCase()),
      isPlatformReserved: jest.fn((h) => h.includes('admin') || h.includes('app')),
    };

    mockAudit = {
      record: jest.fn().mockResolvedValue(true),
    };

    service = new OnboardingService(
      mockDb as unknown as TenantDatabase,
      mockAuth as unknown as AuthorizationService,
      mockProvisioner as unknown as TenantRoleProvisioner,
      mockDomains as unknown as DomainsService,
      mockAudit as unknown as AuditWriter,
    );
  });

  describe('onboardDirectCustomer', () => {
    it('successfully provisions direct customer with organization, workspace, roles, and subdomain', async () => {
      const defaultResellerId = '01955b0a-7b3b-7411-9a4f-res000000000';
      const createdOrg = {
        id: '01955b0a-7b3b-7411-9a4f-org000000001',
        name: 'Direct Customer Inc',
        slug: 'direct-cust',
        resellerId: defaultResellerId,
      };
      const createdWorkspace = {
        id: '01955b0a-7b3b-7411-9a4f-ws0000000001',
      };
      const createdDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000001',
        domain: 'direct-cust.alendei.io',
        domainType: 'subdomain',
        status: 'active',
        verificationMethod: 'platform_subdomain',
        verificationValue: 'platform-verified',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const createdUser = {
        id: '01955b0a-7b3b-7411-9a4f-usr000000001',
      };
      const orgAdminRole = {
        id: '01955b0a-7b3b-7411-9a4f-rol000000001',
      };

      // Mock sequence of database calls:
      // 1. platformDefaultReseller
      // 2. existingOrg check (slug)
      // 3. existingDomain check
      // 4. existingUser check
      // 5. orgAdminRole check
      mockDb.where
        .mockResolvedValueOnce([{ id: defaultResellerId }]) // platformDefaultReseller
        .mockResolvedValueOnce([]) // no slug conflict
        .mockResolvedValueOnce([]) // no domain conflict
        .mockResolvedValueOnce([]) // user does not exist yet
        .mockResolvedValueOnce([orgAdminRole]); // org_admin role found

      // Mock returns for inserts:
      // 1. org insert
      // 2. workspace insert
      // 3. domain insert
      // 4. user insert
      mockDb.returning
        .mockResolvedValueOnce([createdOrg])
        .mockResolvedValueOnce([createdWorkspace])
        .mockResolvedValueOnce([createdDomain])
        .mockResolvedValueOnce([createdUser]);

      const result = await service.onboardDirectCustomer(mockPrincipal, {
        name: 'Direct Customer Inc',
        slug: 'direct-cust',
        adminUser: {
          email: 'admin@directcustomer.com',
          firstName: 'Alice',
          lastName: 'Direct',
        },
      });

      expect(result.organizationSlug).toBe('direct-cust');
      expect(result.portalUrl).toBe('https://direct-cust.alendei.io');
      expect(result.defaultWorkspaceId).toBe(createdWorkspace.id);
      expect(result.adminUserId).toBe(createdUser.id);
      expect(mockProvisioner.seedTenantRoles).toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.CUSTOMER_ONBOARDED,
        }),
        expect.anything(),
      );
    });

    it('refuses customer onboarding if organization slug is already taken', async () => {
      mockDb.where
        .mockResolvedValueOnce([{ id: 'default-res-id' }]) // reseller
        .mockResolvedValueOnce([{ id: 'existing-org-id' }]); // duplicate slug

      await expect(
        service.onboardDirectCustomer(mockPrincipal, {
          name: 'Direct Customer Inc',
          slug: 'duplicate-slug',
          adminUser: {
            email: 'admin@test.com',
            firstName: 'A',
            lastName: 'B',
          },
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.RESOURCE_CONFLICT,
      });
    });
  });

  describe('onboardWhiteLabelCustomer', () => {
    it('provisions white-label customer with custom domain DNS challenge', async () => {
      const resellerId = '01955b0a-7b3b-7411-9a4f-res000000002';
      const createdOrg = {
        id: '01955b0a-7b3b-7411-9a4f-org000000002',
        name: 'WhiteLabel Brand',
        slug: 'whitelabel-brand',
        resellerId,
      };
      const createdWorkspace = { id: '01955b0a-7b3b-7411-9a4f-ws0000000002' };
      const createdSubdomain = {
        id: 'dom-sub',
        domain: 'whitelabel-brand.alendei.io',
        domainType: 'subdomain',
        status: 'active',
        verificationMethod: 'platform_subdomain',
        verificationValue: 'platform-verified',
        verificationStatus: 'verified',
        isPrimary: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const createdCustomDomain = {
        id: 'dom-custom',
        domain: 'console.customerbrand.com',
        domainType: 'custom',
        status: 'pending_verification',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=whitelabel123',
        verificationStatus: 'pending',
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const createdUser = { id: 'usr-1' };
      const orgAdminRole = { id: 'rol-1' };

      mockDb.where
        .mockResolvedValueOnce([]) // no slug conflict
        .mockResolvedValueOnce([]) // no subdomain conflict
        .mockResolvedValueOnce([]) // no user conflict
        .mockResolvedValueOnce([orgAdminRole]); // org_admin role

      mockDb.returning
        .mockResolvedValueOnce([createdOrg])
        .mockResolvedValueOnce([createdWorkspace])
        .mockResolvedValueOnce([createdSubdomain])
        .mockResolvedValueOnce([createdCustomDomain])
        .mockResolvedValueOnce([createdUser]);

      const result = await service.onboardWhiteLabelCustomer(mockPrincipal, {
        name: 'WhiteLabel Brand',
        slug: 'whitelabel-brand',
        resellerId,
        customDomain: 'console.customerbrand.com',
        adminUser: {
          email: 'admin@customerbrand.com',
          firstName: 'Brand',
          lastName: 'Manager',
        },
        brandConfig: {
          brandName: 'CustomerBrand Platform',
          primaryColor: '#8b5cf6',
        },
      });

      expect(result.domain.domain).toBe('console.customerbrand.com');
      expect(result.domain.domainType).toBe('custom');
      expect(result.domain.status).toBe('pending_verification');
      expect(result.portalUrl).toBe('https://console.customerbrand.com');
      expect(result.branding.brandName).toBe('CustomerBrand Platform');
    });
  });
});
