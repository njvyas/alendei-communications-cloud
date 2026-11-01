import { PERMISSIONS } from '@acc/contracts';
import type { AuthPrincipal } from '@acc/contracts';
import { PlatformSupportService } from './platform-support.service';
import type { TenantDatabase } from '../database/tenant-database.service';
import type { AuthorizationService } from '../auth/authorization.service';
import type { AuditWriter } from '../audit/audit-writer.service';
import type { ListQuery } from '../common/http/list-query';
import { AppException } from '../common/errors/app.exception';

interface MockDb {
  auth: {
    execute: jest.Mock;
    select: jest.Mock;
  };
  withTenant: jest.Mock;
}

interface MockAuth {
  assert: jest.Mock;
}

interface MockAudit {
  record: jest.Mock;
}

interface MockLists {
  resolve: jest.Mock;
  fetchSize: jest.Mock;
  paginate: jest.Mock;
}

function getSql(query: unknown): string {
  if (!query) return '';
  if (typeof query === 'string') return query;
  const q = query as {
    sql?: string;
    queryChunks?: Array<{ value?: string; strings?: string[] } | string>;
  };
  if (q.sql) return q.sql;
  if (Array.isArray(q.queryChunks)) {
    return q.queryChunks
      .map((c) =>
        typeof c === 'object' && c !== null
          ? 'value' in c && c.value
            ? c.value
            : Array.isArray(c.strings)
              ? c.strings.join('')
              : String(c)
          : String(c),
      )
      .join(' ');
  }
  return JSON.stringify(query);
}

describe('PlatformSupportService', () => {
  let service: PlatformSupportService;
  let mockDb: MockDb;
  let mockAuth: MockAuth;
  let mockAudit: MockAudit;
  let mockLists: MockLists;

  const mockPrincipal: AuthPrincipal = {
    userId: '11111111-1111-7111-8111-111111111111',
    actorType: 'user',
    apiKeyId: null,
    sessionId: null,
    roles: [
      {
        roleId: '22222222-2222-7222-8222-222222222222',
        roleKey: 'alendei_support',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: [PERMISSIONS.PLATFORM_SUPPORT_READ],
      },
    ],
    permissions: [PERMISSIONS.PLATFORM_SUPPORT_READ],
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
  };

  beforeEach(() => {
    mockDb = {
      auth: {
        execute: jest.fn().mockResolvedValue({ rows: [] }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
      },
      withTenant: jest.fn((_ctx, callback) => {
        const mockTx = {
          execute: jest.fn().mockResolvedValue({ rows: [] }),
          select: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        };
        return callback(mockTx);
      }),
    };

    mockAuth = {
      assert: jest.fn().mockResolvedValue(undefined),
    };

    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    mockLists = {
      resolve: jest.fn().mockReturnValue({
        limit: 50,
        sortToken: '-occurredAt',
        spec: { field: 'occurredAt', direction: 'desc' },
        orderBy: [],
        after: undefined,
      }),
      fetchSize: jest.fn().mockReturnValue(51),
      paginate: jest.fn().mockReturnValue({
        items: [],
        page: { nextCursor: null, hasMore: false, limit: 50 },
      }),
    };

    service = new PlatformSupportService(
      mockDb as unknown as TenantDatabase,
      mockAuth as unknown as AuthorizationService,
      mockAudit as unknown as AuditWriter,
      mockLists as unknown as ListQuery,
    );
  });

  describe('getOrganizationOverview', () => {
    it('throws 404 when organization is not found in database', async () => {
      mockDb.withTenant = jest.fn((_ctx, callback) => {
        const mockTx = {
          execute: jest.fn().mockResolvedValue({ rows: [] }),
        };
        return callback(mockTx);
      });

      await expect(
        service.getOrganizationOverview(mockPrincipal, '33333333-3333-7333-8333-333333333333'),
      ).rejects.toThrow(AppException);
    });

    it('asserts PLATFORM_SUPPORT_READ permission at platform scope', async () => {
      const orgId = '33333333-3333-7333-8333-333333333333';
      mockDb.withTenant = jest.fn((_ctx, callback) => {
        const mockTx = {
          execute: jest.fn().mockImplementation((query) => {
            const sqlText = getSql(query);
            if (sqlText.includes('FROM organizations')) {
              return Promise.resolve({
                rows: [
                  {
                    id: orgId,
                    name: 'Acme Corp',
                    slug: 'acme',
                    status: 'active',
                    type: 'customer',
                    resellerId: null,
                    brandConfig: null,
                    createdAt: '2026-01-01T00:00:00Z',
                    updatedAt: '2026-01-01T00:00:00Z',
                  },
                ],
              });
            }
            if (sqlText.includes('FROM workspaces')) {
              return Promise.resolve({ rows: [] });
            }
            if (sqlText.includes('FROM teams')) {
              return Promise.resolve({ rows: [] });
            }
            return Promise.resolve({ rows: [{}] });
          }),
        };
        return callback(mockTx);
      });

      const res = await service.getOrganizationOverview(mockPrincipal, orgId);

      expect(mockAuth.assert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          principal: mockPrincipal,
          permission: PERMISSIONS.PLATFORM_SUPPORT_READ,
          target: { scopeType: 'platform', scopeId: null },
        }),
      );
      expect(res.organization.id).toBe(orgId);
      expect(res.organization.name).toBe('Acme Corp');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform.support.diagnostic_read',
          resourceType: 'platform_support',
          resourceId: orgId,
          outcome: 'success',
        }),
        expect.anything(),
      );
    });
  });

  describe('getOrganizationRouting', () => {
    it('returns channels, assignments and provider health diagnostics', async () => {
      const orgId = '33333333-3333-7333-8333-333333333333';
      mockDb.withTenant = jest.fn((_ctx, callback) => {
        const mockTx = {
          execute: jest.fn().mockImplementation((query) => {
            const sqlText = getSql(query);
            if (sqlText.includes('FROM organizations')) {
              return Promise.resolve({ rows: [{ id: orgId }] });
            }
            if (sqlText.includes('FROM channels c')) {
              return Promise.resolve({
                rows: [
                  {
                    id: 'c1',
                    code: 'sms',
                    name: 'SMS Channel',
                    status: 'active',
                    defaultProviderId: 'p1',
                    fallbackProviderId: null,
                  },
                ],
              });
            }
            if (sqlText.includes('FROM organization_provider_assignments a')) {
              return Promise.resolve({
                rows: [
                  {
                    id: 'a1',
                    channel: 'sms',
                    providerId: 'p1',
                    providerName: 'Twilio Gateway',
                    providerType: 'twilio',
                    status: 'active',
                    priority: 1,
                    isFallback: false,
                    assignedAt: '2026-01-01T00:00:00Z',
                  },
                ],
              });
            }
            if (sqlText.includes('FROM providers p')) {
              return Promise.resolve({
                rows: [
                  {
                    providerId: 'p1',
                    providerName: 'Twilio Gateway',
                    channel: 'sms',
                    status: 'active',
                    healthState: 'healthy',
                    circuitState: 'closed',
                    failureCount: 0,
                    lastFailureAt: null,
                  },
                ],
              });
            }
            return Promise.resolve({ rows: [] });
          }),
        };
        return callback(mockTx);
      });

      const res = await service.getOrganizationRouting(mockPrincipal, orgId);

      expect(res.channels).toHaveLength(1);
      expect(res.channels[0]!.code).toBe('sms');
      expect(res.assignments).toHaveLength(1);
      expect(res.providerHealth).toHaveLength(1);
      expect(res.providerHealth[0]!.circuitState).toBe('closed');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform.support.diagnostic_read',
          metadata: { tool: 'routing' },
        }),
        expect.anything(),
      );
    });
  });

  describe('getOrganizationDispatch', () => {
    it('masks recipient PII and returns recent failures with provider attempts', async () => {
      const orgId = '33333333-3333-7333-8333-333333333333';
      const msgId = '44444444-4444-7444-8444-444444444444';
      mockDb.withTenant = jest.fn((_ctx, callback) => {
        const mockTx = {
          execute: jest.fn().mockImplementation((query) => {
            const sqlText = getSql(query);
            if (sqlText.includes('FROM organizations')) {
              return Promise.resolve({ rows: [{ id: orgId }] });
            }
            if (sqlText.includes('app_platform_support_dispatch_diagnostics')) {
              return Promise.resolve({
                rows: [
                  {
                    diagnostics: {
                      queue: { pendingCount: 2, claimedCount: 1, delayedCount: 0 },
                      recentFailures: [
                        {
                          messageId: msgId,
                          channel: 'sms',
                          status: 'failed',
                          failureReason: 'provider timeout on submission',
                          failureCategory: 'timeout',
                          recipientAddress: '+15551234567',
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:01:00Z',
                          lastAttemptAt: '2026-01-01T00:00:30Z',
                          providerAttempts: [
                            {
                              attemptNumber: 1,
                              providerId: 'p1',
                              providerType: 'twilio',
                              errorType: 'timeout',
                              httpStatus: null,
                              latencyMs: 3000,
                              attemptedAt: '2026-01-01T00:00:30Z',
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              });
            }
            return Promise.resolve({ rows: [] });
          }),
        };
        return callback(mockTx);
      });

      const res = await service.getOrganizationDispatch(mockPrincipal, orgId, { limit: 10 });

      expect(res.queue.pendingCount).toBe(2);
      expect(res.queue.claimedCount).toBe(1);
      expect(res.recentFailures).toHaveLength(1);
      const failure = res.recentFailures[0]!;
      expect(failure.messageId).toBe(msgId);
      expect(failure.maskedRecipient).not.toBe('+15551234567');
      expect(failure.maskedRecipient).toContain('•');
      expect(failure.failureCategory).toBe('timeout');
      expect(failure.providerAttempts).toHaveLength(1);
      expect(failure.providerAttempts[0]!.latencyMs).toBe(3000);
    });
  });

  describe('searchAuditLogs', () => {
    it('executes paginated search and records diagnostic read audit log', async () => {
      mockDb.withTenant = jest.fn((_ctx, callback) => {
        const mockTx = {
          select: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([
            {
              id: 'log1',
              occurredAt: new Date('2026-01-01T00:00:00Z'),
              action: 'user.login',
              outcome: 'success',
              actorType: 'user',
              actorUserId: 'u1',
              resourceType: 'Session',
              resourceId: 's1',
              scopeType: 'organization',
              scopeId: 'org1',
              orgId: 'org1',
              metadata: { ip: '127.0.0.1' },
              ip: '127.0.0.1',
              userAgent: 'test-agent',
            },
          ]),
        };
        return callback(mockTx);
      });

      mockLists.paginate.mockReturnValue({
        items: [
          {
            id: 'log1',
            occurredAt: new Date('2026-01-01T00:00:00Z'),
            action: 'user.login',
            outcome: 'success',
            actorType: 'user',
            actorUserId: 'u1',
            resourceType: 'Session',
            resourceId: 's1',
            scopeType: 'organization',
            scopeId: 'org1',
            orgId: 'org1',
            metadata: { ip: '127.0.0.1' },
            ip: '127.0.0.1',
            userAgent: 'test-agent',
          },
        ],
        page: { nextCursor: null, hasMore: false, limit: 50 },
      });

      const res = await service.searchAuditLogs(mockPrincipal, { limit: 50 });

      expect(res.data).toHaveLength(1);
      expect(res.data[0]!.id).toBe('log1');
      expect(res.page.hasMore).toBe(false);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform.support.diagnostic_read',
          resourceType: 'platform_support',
        }),
        expect.anything(),
      );
    });
  });
});
