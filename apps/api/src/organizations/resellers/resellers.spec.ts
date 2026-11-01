import { HttpStatus } from '@nestjs/common';
import { AUDIT_ACTIONS, ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { ResellersService } from './resellers.service';
import type { ResolvedPrincipal } from '../../auth/auth.guard';
import { CursorCodec } from '../../common/http/cursor';
import { ListQuery } from '../../common/http/list-query';
import type { TenantDatabase } from '../../database/tenant-database.service';
import type { AuthorizationService } from '../../auth/authorization.service';
import type { AuditWriter } from '../../audit/audit-writer.service';

interface MockTx {
  select: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  groupBy?: jest.Mock;
  orderBy?: jest.Mock;
  limit?: jest.Mock;
  insert?: jest.Mock;
  values?: jest.Mock;
  returning?: jest.Mock;
  update?: jest.Mock;
  set?: jest.Mock;
}

interface MockDb {
  auth: {
    select: jest.Mock;
    from: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
  };
  withTenant: jest.Mock;
}

interface MockAuth {
  assert: jest.Mock;
}

interface MockAudit {
  record: jest.Mock;
}

describe('ResellersService', () => {
  let service: ResellersService;
  let mockDb: MockDb;
  let mockAuth: MockAuth;
  let mockAudit: MockAudit;
  let lists: ListQuery;

  const platformAdminPrincipal: ResolvedPrincipal = {
    userId: '01955b0a-7b3b-7411-9a4f-000000000001',
    apiKeyId: null,
    sessionId: '01955b0a-7b3b-7411-9a4f-000000000002',
    actorType: 'user',
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: true,
    },
    roles: [
      {
        roleId: '01955b0a-7b3b-7411-9a4f-000000000010',
        roleKey: 'alendei_super_admin',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: [PERMISSIONS.PLATFORM_TENANTS_MANAGE, PERMISSIONS.PLATFORM_TENANTS_READ],
      },
    ],
    permissions: [PERMISSIONS.PLATFORM_TENANTS_MANAGE, PERMISSIONS.PLATFORM_TENANTS_READ],
    authMethod: 'session',
    authenticatedAt: new Date(),
    authorizedOrganizationIds: [],
    organizationStatus: null,
    inactiveOrganizations: {},
  };

  const resellerAdminPrincipal: ResolvedPrincipal = {
    userId: '01955b0a-7b3b-7411-9a4f-000000000003',
    apiKeyId: null,
    sessionId: '01955b0a-7b3b-7411-9a4f-000000000004',
    actorType: 'user',
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: '01955b0a-7b3b-7411-9a4f-000000000100',
      isPlatformAdmin: false,
    },
    roles: [
      {
        roleId: '01955b0a-7b3b-7411-9a4f-000000000011',
        roleKey: 'reseller_admin',
        scopeType: 'reseller',
        scopeId: '01955b0a-7b3b-7411-9a4f-000000000100',
        orgId: null,
        permissions: [PERMISSIONS.RESELLERS_READ, PERMISSIONS.RESELLERS_UPDATE],
      },
    ],
    permissions: [PERMISSIONS.RESELLERS_READ, PERMISSIONS.RESELLERS_UPDATE],
    authMethod: 'session',
    authenticatedAt: new Date(),
    authorizedOrganizationIds: [],
    organizationStatus: null,
    inactiveOrganizations: {},
  };

  const unprivilegedPrincipal: ResolvedPrincipal = {
    userId: '01955b0a-7b3b-7411-9a4f-000000000005',
    apiKeyId: null,
    sessionId: '01955b0a-7b3b-7411-9a4f-000000000006',
    actorType: 'user',
    tenant: {
      orgId: '01955b0a-7b3b-7411-9a4f-000000000200',
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    roles: [
      {
        roleId: '01955b0a-7b3b-7411-9a4f-000000000012',
        roleKey: 'read_only',
        scopeType: 'organization',
        scopeId: '01955b0a-7b3b-7411-9a4f-000000000200',
        orgId: '01955b0a-7b3b-7411-9a4f-000000000200',
        permissions: [PERMISSIONS.ORGANIZATIONS_READ],
      },
    ],
    permissions: [PERMISSIONS.ORGANIZATIONS_READ],
    authMethod: 'session',
    authenticatedAt: new Date(),
    authorizedOrganizationIds: ['01955b0a-7b3b-7411-9a4f-000000000200'],
    organizationStatus: 'active',
    inactiveOrganizations: {},
  };

  beforeEach(() => {
    lists = new ListQuery(new CursorCodec('a-test-signing-secret'));
    mockAuth = {
      assert: jest.fn().mockResolvedValue(undefined),
    };
    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    mockDb = {
      auth: {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      },
      withTenant: jest.fn(async (_session: unknown, work: (tx: MockTx) => Promise<unknown>) => {
        const tx: MockTx = {
          select: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockResolvedValue([]),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
          insert: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
        };
        return work(tx);
      }),
    };

    service = new ResellersService(
      mockDb as unknown as TenantDatabase,
      mockAuth as unknown as AuthorizationService,
      mockAudit as unknown as AuditWriter,
      lists,
    );
  });

  describe('Authorization and Reach', () => {
    it('refuses unprivileged caller with 403 AUTHZ_SCOPE_DENIED', async () => {
      await expect(service.list(unprivilegedPrincipal)).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.FORBIDDEN,
          code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        }),
      );
    });

    it('refuses access to out-of-reach reseller with 404 RESELLER_NOT_FOUND', async () => {
      await expect(
        service.get(resellerAdminPrincipal, '01955b0a-7b3b-7411-9a4f-000000000999'),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESELLER_NOT_FOUND,
        }),
      );
    });
  });

  describe('Creation', () => {
    it('refuses creation with duplicate slug (409 RESOURCE_CONFLICT)', async () => {
      mockDb.withTenant.mockImplementation(
        async (_session: unknown, work: (tx: MockTx) => Promise<unknown>) => {
          const tx: MockTx = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([{ id: 'existing-id' }]),
          };
          return work(tx);
        },
      );

      await expect(
        service.create(platformAdminPrincipal, {
          name: 'Acme Reseller',
          slug: 'acme-reseller',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
        }),
      );
    });

    it('refuses creation with duplicate domain (409 RESOURCE_CONFLICT)', async () => {
      let queryCount = 0;
      mockDb.withTenant.mockImplementation(
        async (_session: unknown, work: (tx: MockTx) => Promise<unknown>) => {
          const tx: MockTx = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockImplementation(() => {
              queryCount++;
              if (queryCount === 1) return Promise.resolve([]); // slug check
              return Promise.resolve([{ id: 'existing-domain-id' }]); // domain check
            }),
          };
          return work(tx);
        },
      );

      await expect(
        service.create(platformAdminPrincipal, {
          name: 'Acme Reseller',
          slug: 'acme-reseller',
          domain: 'portal.acmereseller.com',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
        }),
      );
    });

    it('creates reseller and records reseller.created audit record', async () => {
      const inserted = {
        id: '01955b0a-7b3b-7411-9a4f-000000000050',
        name: 'Apex Telecom',
        slug: 'apex-telecom',
        domain: 'portal.apextelecom.com',
        brandConfig: {},
        defaultMarkupPct: '12.500',
        status: 'active' as const,
        isPlatformDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.withTenant.mockImplementation(
        async (_session: unknown, work: (tx: MockTx) => Promise<unknown>) => {
          const tx: MockTx = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([]),
            insert: jest.fn().mockReturnThis(),
            values: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([inserted]),
          };
          return work(tx);
        },
      );

      const result = await service.create(platformAdminPrincipal, {
        name: 'Apex Telecom',
        slug: 'apex-telecom',
        domain: 'portal.apextelecom.com',
        defaultMarkupPct: '12.500',
      });

      expect(result.id).toBe(inserted.id);
      expect(result.slug).toBe('apex-telecom');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.RESELLER_CREATED,
          resourceType: 'Reseller',
          resourceId: inserted.id,
        }),
        expect.anything(),
      );
    });
  });

  describe('Updates and Lifecycle', () => {
    it('refuses non-platform admin from updating reseller custom domain (403 AUTHZ_SCOPE_DENIED)', async () => {
      mockDb.withTenant.mockImplementation(
        async (_session: unknown, work: (tx: MockTx) => Promise<unknown>) => {
          const tx: MockTx = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([
              {
                id: '01955b0a-7b3b-7411-9a4f-000000000100',
                name: 'Reseller One',
                slug: 'reseller-one',
                domain: null,
              },
            ]),
          };
          return work(tx);
        },
      );

      await expect(
        service.update(resellerAdminPrincipal, '01955b0a-7b3b-7411-9a4f-000000000100', {
          domain: 'portal.resellerone.com',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.FORBIDDEN,
          code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        }),
      );
    });

    it('refuses suspending the platform default reseller (409 RESOURCE_CONFLICT)', async () => {
      mockDb.withTenant.mockImplementation(
        async (_session: unknown, work: (tx: MockTx) => Promise<unknown>) => {
          const tx: MockTx = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([
              {
                id: '01955b0a-7b3b-7411-9a4f-000000000001',
                name: 'Alendei Direct',
                status: 'active',
                isPlatformDefault: true,
              },
            ]),
          };
          return work(tx);
        },
      );

      await expect(
        service.transition(
          platformAdminPrincipal,
          '01955b0a-7b3b-7411-9a4f-000000000001',
          'suspend',
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
        }),
      );
    });

    it('refuses invalid status transitions (409 RESELLER_LIFECYCLE_CONFLICT)', async () => {
      mockDb.withTenant.mockImplementation(
        async (_session: unknown, work: (tx: MockTx) => Promise<unknown>) => {
          const tx: MockTx = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([
              {
                id: '01955b0a-7b3b-7411-9a4f-000000000050',
                name: 'Reseller',
                status: 'suspended',
                isPlatformDefault: false,
              },
            ]),
          };
          return work(tx);
        },
      );

      await expect(
        service.transition(
          platformAdminPrincipal,
          '01955b0a-7b3b-7411-9a4f-000000000050',
          'suspend', // already suspended
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESELLER_LIFECYCLE_CONFLICT,
        }),
      );
    });
  });
});
