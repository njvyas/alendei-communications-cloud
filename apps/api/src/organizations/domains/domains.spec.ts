import { AUDIT_ACTIONS, ERROR_CODES } from '@acc/contracts';
import { AppException } from '../../common/errors/app.exception';
import { DomainsService } from './domains.service';
import type { ResolvedPrincipal } from '../../auth/auth.guard';
import type { TenantDatabase } from '../../database/tenant-database.service';
import type { AuthorizationService } from '../../auth/authorization.service';
import type { AuditWriter } from '../../audit/audit-writer.service';

interface MockQueryBuilder {
  select: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  insert: jest.Mock;
  values: jest.Mock;
  returning: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;
  delete: jest.Mock;
}

interface MockDb extends MockQueryBuilder {
  withTenant: jest.Mock;
  auth: {
    transaction: jest.Mock;
    select: jest.Mock;
  };
}

interface MockAuth {
  assert: jest.Mock;
}

interface MockAudit {
  record: jest.Mock;
}

describe('DomainsService', () => {
  let service: DomainsService;
  let mockDb: MockDb;
  let mockAuth: MockAuth;
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
      isPlatformAdmin: false,
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
      auth: {
        transaction: jest.fn(async (work) => work(mockDb)),
        // addressOrganization: the addressed organization exists (identity plane).
        select: jest.fn(() => ({
          from: () => ({ where: () => Promise.resolve([{ resellerId: null }]) }),
        })),
      },
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
    };

    mockAuth = {
      assert: jest.fn().mockResolvedValue(true),
    };

    mockAudit = {
      record: jest.fn().mockResolvedValue(true),
    };

    service = new DomainsService(
      mockDb as unknown as TenantDatabase,
      mockAuth as unknown as AuthorizationService,
      mockAudit as unknown as AuditWriter,
    );
  });

  describe('organization addressing (QA defect D-1)', () => {
    const otherOrg = '01955b0a-7b3b-7411-9a4f-000000000099';

    it('refuses an organization the principal is not connected to with 404, before any tenant session or authorization', async () => {
      for (const work of [
        () => service.listDomains(mockPrincipal, otherOrg),
        () => service.getBranding(mockPrincipal, otherOrg),
        () => service.updateBranding(mockPrincipal, otherOrg, { brandName: 'x' }),
        () => service.removeDomain(mockPrincipal, otherOrg, '01955b0a-7b3b-7411-9a4f-000000000098'),
      ]) {
        await expect(work()).rejects.toMatchObject({
          status: 404,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
      }
      expect(mockDb.withTenant).not.toHaveBeenCalled();
      expect(mockAuth.assert).not.toHaveBeenCalled();
    });

    it('refuses a nonexistent organization with the same 404', async () => {
      mockDb.auth.select.mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([]) }),
      });
      await expect(service.listDomains(mockPrincipal, otherOrg)).rejects.toMatchObject({
        status: 404,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
      });
      expect(mockDb.withTenant).not.toHaveBeenCalled();
    });

    it('authorizes as the principal placed in the addressed organization, with a matching session', async () => {
      const orgId = mockPrincipal.authorizedOrganizationIds[0]!;
      mockDb.orderBy.mockResolvedValueOnce([]);
      await service.listDomains(
        { ...mockPrincipal, tenant: { ...mockPrincipal.tenant, orgId: null, workspaceId: null } },
        orgId,
      );
      expect(mockDb.withTenant).toHaveBeenCalledWith(
        expect.objectContaining({ orgId, userId: mockPrincipal.userId, resellerId: null }),
        expect.any(Function),
      );
      expect(mockAuth.assert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          principal: expect.objectContaining({
            tenant: expect.objectContaining({ orgId, workspaceId: null }),
          }),
        }),
      );
    });
  });

  describe('normalizeHostname', () => {
    it('strips ports, protocols, path and trailing dots and converts to lowercase', () => {
      expect(service.normalizeHostname('  https://Customer1.Alendei.IO:8443/login  ')).toBe(
        'customer1.alendei.io',
      );
      expect(service.normalizeHostname('console.CustomerBrand.com.')).toBe(
        'console.customerbrand.com',
      );
      expect(service.normalizeHostname('http://Admin.Alendei.io/')).toBe('admin.alendei.io');
    });

    it('rejects invalid or dangerous hostnames', () => {
      expect(() => service.normalizeHostname('')).toThrow(AppException);
      expect(() => service.normalizeHostname('invalid..domain')).toThrow(AppException);
      expect(() => service.normalizeHostname('domain with spaces.com')).toThrow(AppException);
      expect(() => service.normalizeHostname('<script>evil.com')).toThrow(AppException);
    });
  });

  describe('isPlatformReserved', () => {
    it('identifies platform reserved hostnames', () => {
      expect(service.isPlatformReserved('app.alendei.io')).toBe(true);
      expect(service.isPlatformReserved('admin.alendei.io')).toBe(true);
      expect(service.isPlatformReserved('api.alendei.io')).toBe(true);
      expect(service.isPlatformReserved('alendei.com')).toBe(true);
      expect(service.isPlatformReserved('www.alendei.com')).toBe(true);
      expect(service.isPlatformReserved('portal.alendei.com')).toBe(true);
      expect(service.isPlatformReserved('customer1.alendei.io')).toBe(false);
      expect(service.isPlatformReserved('console.mybrand.com')).toBe(false);
    });
  });

  describe('resolveHostname', () => {
    it('resolves admin.alendei.io to platform admin portal', async () => {
      const res = await service.resolveHostname('admin.alendei.io:443');
      expect(res.matched).toBe(true);
      expect(res.portalType).toBe('admin');
      expect(res.branding.brandName).toBe('Alendei Administration');
      expect(res.branding.primaryColor).toBe('#6366f1');
    });

    it('resolves app.alendei.io to console portal with platform default branding', async () => {
      const res = await service.resolveHostname('app.alendei.io');
      expect(res.matched).toBe(true);
      expect(res.portalType).toBe('console');
      expect(res.branding.brandName).toBe('Alendei Cloud');
    });

    it('resolves active verified customer domain with hierarchical branding', async () => {
      const orgId = '01955b0a-7b3b-7411-9a4f-000000000010';
      const mockDomainRow = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000001',
        orgId,
        domain: 'customer1.alendei.io',
        domainType: 'subdomain',
        status: 'active',
        verificationStatus: 'verified',
      };
      const mockOrg = {
        id: orgId,
        slug: 'customer1',
        name: 'Customer 1 Corp',
        resellerId: '01955b0a-7b3b-7411-9a4f-res000000001',
        status: 'active',
        brandConfig: {
          brandName: 'Custom Customer Brand',
          primaryColor: '#10b981',
        },
      };
      const mockReseller = {
        id: '01955b0a-7b3b-7411-9a4f-res000000001',
        status: 'active',
        brandConfig: {
          supportEmail: 'reseller-support@partner.com',
        },
      };

      // Mock chain of selects
      mockDb.where
        .mockResolvedValueOnce([mockDomainRow]) // organizationDomains
        .mockResolvedValueOnce([mockOrg]) // organizations
        .mockResolvedValueOnce([mockReseller]); // resellers

      const res = await service.resolveHostname('customer1.alendei.io');
      expect(res.matched).toBe(true);
      expect(res.portalType).toBe('customer');
      expect(res.organization?.id).toBe(orgId);
      expect(res.organization?.slug).toBe('customer1');
      expect(res.branding.brandName).toBe('Custom Customer Brand');
      expect(res.branding.primaryColor).toBe('#10b981');
      expect(res.branding.supportEmail).toBe('reseller-support@partner.com');
    });

    it('returns matched: false for unknown or unverified domains', async () => {
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // no org domain, no reseller
      const res = await service.resolveHostname('unknown-domain.com');
      expect(res.matched).toBe(false);
      expect(res.portalType).toBe('default');
      expect(res.organization).toBeNull();
    });
  });

  describe('registerDomain', () => {
    it('refuses to register platform-reserved domains', async () => {
      await expect(
        service.registerDomain(mockPrincipal, mockPrincipal.tenant.orgId!, {
          domain: 'app.alendei.io',
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_RESERVED,
      });
    });

    it('refuses duplicate domains with 409 Conflict', async () => {
      mockDb.where.mockResolvedValueOnce([{ id: 'existing-dom-id' }]); // duplicate check

      await expect(
        service.registerDomain(mockPrincipal, mockPrincipal.tenant.orgId!, {
          domain: 'customer1.alendei.io',
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_ALREADY_EXISTS,
      });
    });

    it('auto-verifies .alendei.io subdomains as active', async () => {
      mockDb.where
        .mockResolvedValueOnce([]) // no duplicate org domain
        .mockResolvedValueOnce([]); // no duplicate reseller domain

      const insertedRow = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000001',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'customer1.alendei.io',
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
      mockDb.returning.mockResolvedValueOnce([insertedRow]);

      const result = await service.registerDomain(mockPrincipal, mockPrincipal.tenant.orgId!, {
        domain: 'customer1.alendei.io',
        isPrimary: true,
      });

      expect(result.domain).toBe('customer1.alendei.io');
      expect(result.status).toBe('active');
      expect(result.verificationStatus).toBe('verified');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.DOMAIN_REGISTERED,
        }),
        expect.anything(),
      );
    });

    it('registers custom domains in pending_verification state with DNS challenge', async () => {
      mockDb.where
        .mockResolvedValueOnce([]) // no duplicate org domain
        .mockResolvedValueOnce([]); // no duplicate reseller domain

      const insertedRow = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000002',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.mybrand.com',
        domainType: 'custom',
        status: 'pending_verification',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=challenge123',
        verificationStatus: 'pending',
        verifiedAt: null,
        isPrimary: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.returning.mockResolvedValueOnce([insertedRow]);

      const result = await service.registerDomain(mockPrincipal, mockPrincipal.tenant.orgId!, {
        domain: 'console.mybrand.com',
      });

      expect(result.domain).toBe('console.mybrand.com');
      expect(result.status).toBe('pending_verification');
      expect(result.verificationStatus).toBe('pending');
      expect(result.verificationMethod).toBe('dns_txt');
    });

    it('handles cross-tenant duplicate domain 23505 unique violation cleanly as DOMAIN_ALREADY_EXISTS', async () => {
      mockDb.where
        .mockResolvedValueOnce([]) // not found in same org
        .mockResolvedValueOnce([]); // not found in resellers

      mockDb.returning.mockRejectedValueOnce(
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "organization_domains_domain_key"',
          ),
          { code: '23505' },
        ),
      );

      await expect(
        service.registerDomain(mockPrincipal, mockPrincipal.tenant.orgId!, {
          domain: 'console.alreadyregistered.com',
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_ALREADY_EXISTS,
      });
    });
  });

  describe('verifyDomain', () => {
    it('transitions custom domain to verified and active when DNS TXT matches challenge', async () => {
      const existingDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000002',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.mybrand.com',
        status: 'pending_verification',
        verificationStatus: 'pending',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=challenge123',
        createdAt: new Date(),
      };
      const updatedDomain = {
        ...existingDomain,
        status: 'active',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        isPrimary: false,
        domainType: 'custom',
        updatedAt: new Date(),
      };

      mockDb.where.mockResolvedValueOnce([existingDomain]);
      mockDb.returning.mockResolvedValueOnce([updatedDomain]);

      // Mock DNS resolver returning matching TXT chunk
      service.setDnsResolver(
        jest.fn().mockResolvedValue([['acc-domain-verification=challenge123']]),
      );

      const result = await service.verifyDomain(
        mockPrincipal,
        mockPrincipal.tenant.orgId!,
        existingDomain.id,
      );

      expect(result.status).toBe('active');
      expect(result.verificationStatus).toBe('verified');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.DOMAIN_VERIFIED,
        }),
        expect.anything(),
      );
    });

    it('fails verification with DOMAIN_VERIFICATION_FAILED when DNS TXT record is missing', async () => {
      const existingDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000002',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.mybrand.com',
        status: 'pending_verification',
        verificationStatus: 'pending',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=challenge123',
        createdAt: new Date(),
      };

      mockDb.where.mockResolvedValueOnce([existingDomain]);
      mockDb.where.mockResolvedValueOnce([]); // update set verificationStatus: failed

      service.setDnsResolver(
        jest
          .fn()
          .mockRejectedValue(Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' })),
      );

      await expect(
        service.verifyDomain(mockPrincipal, mockPrincipal.tenant.orgId!, existingDomain.id),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_VERIFICATION_FAILED,
      });
    });

    it('fails verification with DOMAIN_VERIFICATION_FAILED when DNS TXT record has wrong value', async () => {
      const existingDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000002',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.mybrand.com',
        status: 'pending_verification',
        verificationStatus: 'pending',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=challenge123',
        createdAt: new Date(),
      };

      mockDb.where.mockResolvedValueOnce([existingDomain]);
      mockDb.where.mockResolvedValueOnce([]); // update set verificationStatus: failed

      service.setDnsResolver(jest.fn().mockResolvedValue([['wrong-token']]));

      await expect(
        service.verifyDomain(mockPrincipal, mockPrincipal.tenant.orgId!, existingDomain.id),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_VERIFICATION_FAILED,
      });
    });

    it('fails verification with DOMAIN_VERIFICATION_FAILED when challenge has expired (>72 hours)', async () => {
      const expiredDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000002',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.mybrand.com',
        status: 'pending_verification',
        verificationStatus: 'pending',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=challenge123',
        createdAt: new Date(Date.now() - 80 * 60 * 60 * 1000), // 80 hours ago
      };

      mockDb.where.mockResolvedValueOnce([expiredDomain]);
      mockDb.where.mockResolvedValueOnce([]);

      await expect(
        service.verifyDomain(mockPrincipal, mockPrincipal.tenant.orgId!, expiredDomain.id),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_VERIFICATION_FAILED,
      });
    });

    it('refuses to verify a suspended domain', async () => {
      const suspendedDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000002',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.mybrand.com',
        status: 'suspended',
      };
      mockDb.where.mockResolvedValueOnce([suspendedDomain]);

      await expect(
        service.verifyDomain(mockPrincipal, mockPrincipal.tenant.orgId!, suspendedDomain.id),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_SUSPENDED,
      });
    });

    it('regenerates challenge token via regenerateChallenge', async () => {
      const unverifiedDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000002',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.mybrand.com',
        status: 'pending_verification',
        verificationStatus: 'pending',
        verificationMethod: 'dns_txt',
        verificationValue: 'old-challenge',
        createdAt: new Date(),
      };

      const updatedDomain = {
        ...unverifiedDomain,
        verificationValue: 'acc-domain-verification=new-token-123',
      };

      mockDb.where.mockResolvedValueOnce([unverifiedDomain]);
      mockDb.returning.mockResolvedValueOnce([updatedDomain]);

      const result = await service.regenerateChallenge(
        mockPrincipal,
        mockPrincipal.tenant.orgId!,
        unverifiedDomain.id,
      );

      expect(result.domain).toBe('console.mybrand.com');
      expect(result.record.value).toBe('acc-domain-verification=new-token-123');
    });

    it('refuses to regenerate challenge for already verified and active domain', async () => {
      const verifiedDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000003',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.verified.com',
        status: 'active',
        verificationStatus: 'verified',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=active-123',
        createdAt: new Date(),
      };

      mockDb.where.mockResolvedValueOnce([verifiedDomain]);

      await expect(
        service.regenerateChallenge(mockPrincipal, mockPrincipal.tenant.orgId!, verifiedDomain.id),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_LIFECYCLE_CONFLICT,
      });
    });

    it('fails closed when concurrent challenge rotation occurs during verification', async () => {
      const pendingDomain = {
        id: '01955b0a-7b3b-7411-9a4f-dom000000004',
        orgId: mockPrincipal.tenant.orgId,
        domain: 'console.race.com',
        status: 'pending_verification',
        verificationStatus: 'pending',
        verificationMethod: 'dns_txt',
        verificationValue: 'acc-domain-verification=old-token',
        createdAt: new Date(),
      };

      mockDb.where.mockResolvedValueOnce([pendingDomain]);
      service.setDnsResolver(jest.fn().mockResolvedValue([['acc-domain-verification=old-token']]));
      // Simulate concurrent rotation: update returns empty array because verificationValue condition didn't match
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(
        service.verifyDomain(mockPrincipal, mockPrincipal.tenant.orgId!, pendingDomain.id),
      ).rejects.toMatchObject({
        code: ERROR_CODES.DOMAIN_LIFECYCLE_CONFLICT,
      });
    });
  });

  describe('branding configuration', () => {
    it('updates organization brandConfig and emits audit record', async () => {
      const orgId = mockPrincipal.tenant.orgId!;
      const existingOrg = {
        id: orgId,
        brandConfig: { brandName: 'Old Name' },
      };

      mockDb.where.mockResolvedValueOnce([existingOrg]);

      const updated = await service.updateBranding(mockPrincipal, orgId, {
        brandName: 'New Brand Name',
        primaryColor: '#6366f1',
      });

      expect(updated.brandName).toBe('New Brand Name');
      expect(updated.primaryColor).toBe('#6366f1');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.BRANDING_UPDATED,
        }),
        expect.anything(),
      );
    });

    it('validates branding URLs and rejects protocol-relative URLs', async () => {
      const { plainToInstance } = await import('class-transformer');
      const { validate } = await import('class-validator');
      const { UpdateBrandingDto } = await import('./domains.dto');

      const invalidDto = plainToInstance(UpdateBrandingDto, {
        logoUrl: '//attacker.com/evil-logo.png',
        faviconUrl: '//evil.com/favicon.ico',
        customCss: 'body { background: url("http://evil.com/leak"); }',
      });

      const errors = await validate(invalidDto);
      const propertyErrors = errors.map((e) => e.property);
      expect(propertyErrors).toContain('logoUrl');
      expect(propertyErrors).toContain('faviconUrl');
      expect(propertyErrors).toContain('customCss');

      const validDto = plainToInstance(UpdateBrandingDto, {
        logoUrl: 'https://cdn.example.com/logo.png',
        faviconUrl: '/assets/favicon.ico',
        customCss: ':root { --brand-radius: 8px; font-family: sans-serif; }',
      });

      const validErrors = await validate(validDto);
      expect(validErrors.length).toBe(0);
    });
  });
});
