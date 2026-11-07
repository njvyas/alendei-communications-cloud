import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { type AuthPrincipal } from '@acc/contracts';
import { schema } from '@acc/db';
import { ListContactActivitiesDto } from './contacts.dto';
import { ContactsService } from './contacts.service';
import { CursorCodec } from '../common/http/cursor';
import type { TenantDatabase } from '../database/tenant-database.service';
import type { AuthorizationService } from '../auth/authorization.service';
import type { AuditWriter } from '../audit/audit-writer.service';
import type { ListQuery } from '../common/http/list-query';
import type { IdempotencyService } from '../idempotency/idempotency.service';

const codeOf = (file: string): string =>
  readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const serviceCode = codeOf('contacts.service.ts');
const controllerCode = codeOf('contacts.controller.ts');

const errorsFor = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
    (e) => e.property,
  );

describe('Phase 8A — Contact Activity Backend Integration', () => {
  const cursors = new CursorCodec('test-secret-at-least-32-chars-long-for-hmac!!');

  describe('Boundary and controller annotations', () => {
    it('defines the activities routes on both workspace-scoped and direct paths', () => {
      expect(controllerCode).toContain('workspaces/:workspaceId/contacts/:contactId/activities');
      expect(controllerCode).toContain('contacts/:contactId/activities');
    });

    it('enforces PERMISSIONS.CONTACTS_READ on both activities endpoints', () => {
      const activitiesMatches = controllerCode.match(
        /@Get\(['"](?:workspaces\/:workspaceId\/)?contacts\/:contactId\/activities['"]\)[\s\S]*?listActivities/g,
      );
      expect(activitiesMatches).not.toBeNull();
      expect(activitiesMatches!.length).toBe(2);
      for (const m of activitiesMatches!) {
        expect(m).toContain('PERMISSIONS.CONTACTS_READ');
        expect(m).toContain('AcceptedCredentials');
      }
    });

    it('enforces tenant isolation through loadContact with orgId matching', () => {
      expect(serviceCode).toMatch(/loadContact\([\s\S]*?PERMISSIONS\.CONTACTS_READ/);
      expect(serviceCode).toContain('eq(schema.contacts.orgId, orgId)');
    });
  });

  describe('DTO validation', () => {
    it('accepts valid category filters', async () => {
      for (const category of ['all', 'message', 'consent', 'identity', 'profile'] as const) {
        expect(await errorsFor(ListContactActivitiesDto, { category })).toEqual([]);
      }
    });

    it('rejects unsupported categories and invalid types', async () => {
      expect(await errorsFor(ListContactActivitiesDto, { category: 'fabricated' })).toContain(
        'category',
      );
      expect(await errorsFor(ListContactActivitiesDto, { category: 'billing' })).toContain(
        'category',
      );
      expect(
        await errorsFor(ListContactActivitiesDto, { category: 123 as unknown as string }),
      ).toContain('category');
    });

    it('accepts valid pagination parameters', async () => {
      expect(
        await errorsFor(ListContactActivitiesDto, { limit: 50, cursor: 'valid-cursor' }),
      ).toEqual([]);
      expect(await errorsFor(ListContactActivitiesDto, { limit: 0 })).toContain('limit');
      expect(await errorsFor(ListContactActivitiesDto, { limit: 200 })).toContain('limit');
    });
  });

  describe('Service implementation: ContactsService.listActivities', () => {
    const orgId = '01900000-0000-7000-8000-000000000001';
    const workspaceId = '01900000-0000-7000-8000-000000000002';
    const contactId = '01900000-0000-7000-8000-000000000003';
    const otherOrgId = '01900000-0000-7000-8000-000000000099';

    const principal: AuthPrincipal = {
      type: 'user',
      userId: '01900000-0000-7000-8000-000000000010',
      tenant: { orgId } as never,
      roles: [],
    } as unknown as AuthPrincipal;

    const mockContact = {
      id: contactId,
      orgId,
      workspaceId,
      firstName: 'Alice',
      lastName: 'Smith',
      metadata: { tags: ['VIP'] },
      createdAt: new Date('2026-11-01T10:00:00Z'),
      updatedAt: new Date('2026-11-05T14:30:00Z'), // updatedAt should NOT generate synthetic events
    };

    let service: ContactsService;
    let mockTx: { select: jest.Mock };

    function createMockQuery(
      defaultRows: unknown[] = [],
      tableMap: Map<unknown, unknown[]> = new Map(),
    ) {
      return {
        from: jest.fn((table: unknown) => {
          const rows = tableMap.get(table) ?? defaultRows;
          const chain: { leftJoin: jest.Mock; where: jest.Mock } = {
            leftJoin: jest.fn(),
            where: jest.fn().mockResolvedValue(rows),
          };
          chain.leftJoin.mockReturnValue(chain);
          return chain;
        }),
      };
    }

    beforeEach(() => {
      mockTx = {
        select: jest.fn(),
      };

      const mockDb = {
        withRequestTenant: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
      } as unknown as TenantDatabase;

      const mockAuth: Partial<AuthorizationService> = {
        assert: jest.fn().mockResolvedValue(undefined),
      };

      service = new ContactsService(
        mockDb,
        mockAuth as AuthorizationService,
        {} as AuditWriter,
        {} as ListQuery,
        {} as IdempotencyService,
        cursors,
      );

      // Mock loadContact
      jest.spyOn(service, 'loadContact').mockImplementation(async (_tx, p, cId, _perm, wId) => {
        if (p.tenant?.orgId !== orgId) {
          throw new Error('Contact not found');
        }
        if (cId !== contactId) {
          throw new Error('Contact not found');
        }
        if (wId && wId !== workspaceId) {
          throw new Error('Contact not found');
        }
        return mockContact as never;
      });
    });

    it('returns genuine contact_created event from contact.createdAt and no synthetic field updates', async () => {
      // Mock empty query responses for auditLogs, identities, consents, messages
      mockTx.select.mockReturnValue(createMockQuery([]));

      const result = await service.listActivities(principal, contactId, { category: 'all' });

      expect(result.items.length).toBe(1);
      const createdEvent = result.items[0];
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.type).toBe('contact_created');
      expect(createdEvent!.category).toBe('profile');
      expect(createdEvent!.timestamp).toBe('2026-11-01T10:00:00.000Z');

      // Crucial: no event was generated from contact.updatedAt
      expect(result.items.find((i) => i.type === ('field_updated' as never))).toBeUndefined();
    });

    it('returns zero message activities when no messages exist for contact (never fabricates messages)', async () => {
      mockTx.select.mockReturnValue(createMockQuery([]));

      const result = await service.listActivities(principal, contactId, { category: 'message' });

      expect(result.items).toEqual([]);
      expect(result.page.hasMore).toBe(false);
    });

    it('maps genuine message dispatched, delivered, read, and failed events from persisted records with accurate status and masked addresses', async () => {
      const channelId = '01900000-0000-7000-8000-000000000020';
      const msgSuccess = {
        id: '01900000-0000-7000-8000-000000000030',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'accepted',
        deliveryStatus: 'delivered',
        deliveredAt: new Date('2026-11-02T12:05:00Z'),
        readAt: new Date('2026-11-02T12:10:00Z'),
        createdAt: new Date('2026-11-02T12:00:00Z'),
        recipientAddress: '+12025550123',
      };

      const msgFailed = {
        id: '01900000-0000-7000-8000-000000000031',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'failed',
        deliveryStatus: 'undelivered',
        failureReason: 'Destination handset unreachable',
        completedAt: new Date('2026-11-03T09:01:00Z'),
        createdAt: new Date('2026-11-03T09:00:00Z'),
        recipientAddress: '+12025550123',
      };

      mockTx.select.mockReturnValue(
        createMockQuery([
          { message: msgSuccess, channelCode: 'whatsapp', templateName: 'order_update' },
          { message: msgFailed, channelCode: 'whatsapp', templateName: null },
        ]),
      );

      const result = await service.listActivities(principal, contactId, { category: 'message' });

      // msgSuccess (status: accepted) generates: message_sent, message_delivered, message_read (3)
      // msgFailed (status: failed) generates ONLY: message_failed (1) — NEVER message_sent!
      expect(result.items.length).toBe(4);

      const types = result.items.map((i) => i.type);
      expect(types).toContain('message_sent');
      expect(types).toContain('message_delivered');
      expect(types).toContain('message_read');
      expect(types).toContain('message_failed');

      // Verify dispatch item: only for msgSuccess
      const sentItem = result.items.find((i) => i.type === 'message_sent')!;
      expect(sentItem.title).toBe('WHATSAPP Dispatched');
      expect(sentItem.description).toContain('+1 •••• 0123');
      expect(sentItem.metadata?.recipientAddress).toBe('+1 •••• 0123');

      // Verify delivery details
      const deliveredItem = result.items.find((i) => i.type === 'message_delivered')!;
      expect(deliveredItem.statusTone).toBe('success');
      expect(deliveredItem.timestamp).toBe('2026-11-02T12:05:00.000Z');
      expect(deliveredItem.channelCode).toBe('whatsapp');
      expect(deliveredItem.metadata?.recipientAddress).toBe('+1 •••• 0123');

      // Verify read details
      const readItem = result.items.find((i) => i.type === 'message_read')!;
      expect(readItem.statusTone).toBe('accent');
      expect(readItem.timestamp).toBe('2026-11-02T12:10:00.000Z');
      expect(readItem.metadata?.recipientAddress).toBe('+1 •••• 0123');

      // Verify failed details: submission failure wording
      const failedItem = result.items.find((i) => i.type === 'message_failed')!;
      expect(failedItem.statusTone).toBe('error');
      expect(failedItem.title).toBe('WHATSAPP Submission Failed');
      expect(failedItem.description).toContain('Destination handset unreachable');
      expect(failedItem.metadata?.recipientAddress).toBe('+1 •••• 0123');

      // Regression: verify raw unmasked address '+12025550123' NEVER appears in result
      const serialized = JSON.stringify(result.items);
      expect(serialized).not.toContain('+12025550123');

      // Verify descending chronological order
      for (let i = 0; i < result.items.length - 1; i++) {
        const tA = new Date(result.items[i]!.timestamp).getTime();
        const tB = new Date(result.items[i + 1]!.timestamp).getTime();
        expect(tA).toBeGreaterThanOrEqual(tB);
      }
    });

    it('protects PII: sanitizes raw phone number and email address embedded in provider failure reasons', async () => {
      const channelId = '01900000-0000-7000-8000-000000000020';
      const rawPhone = '+12025550999';
      const rawEmail = 'sarah.connor@example.com';

      const phoneFailedMsg = {
        id: '01900000-0000-7000-8000-000000000041',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'failed',
        deliveryStatus: 'undelivered',
        failureReason: `Carrier rejected ${rawPhone}: destination handset unreachable`,
        completedAt: new Date('2026-11-05T09:01:00Z'),
        createdAt: new Date('2026-11-05T09:00:00Z'),
        recipientAddress: rawPhone,
      };

      const emailFailedMsg = {
        id: '01900000-0000-7000-8000-000000000042',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'failed',
        deliveryStatus: 'undelivered',
        failureReason: `SMTP 550 5.1.1 <${rawEmail}>: Recipient address rejected`,
        completedAt: new Date('2026-11-05T10:01:00Z'),
        createdAt: new Date('2026-11-05T10:00:00Z'),
        recipientAddress: rawEmail,
      };

      const downstreamFailedMsg = {
        id: '01900000-0000-7000-8000-000000000043',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'accepted',
        deliveryStatus: 'undelivered',
        failureReason: `Downstream delivery failed to ${rawPhone} (cc: ${rawEmail})`,
        completedAt: new Date('2026-11-05T11:01:00Z'),
        createdAt: new Date('2026-11-05T11:00:00Z'),
        recipientAddress: rawPhone,
      };

      mockTx.select.mockReturnValue(
        createMockQuery([
          { message: phoneFailedMsg, channelCode: 'sms', templateName: null },
          { message: emailFailedMsg, channelCode: 'email', templateName: null },
          { message: downstreamFailedMsg, channelCode: 'sms', templateName: null },
        ]),
      );

      const result = await service.listActivities(principal, contactId, { category: 'message' });

      // phoneFailedMsg: 1 message_failed
      // emailFailedMsg: 1 message_failed
      // downstreamFailedMsg: 1 message_sent, 1 message_failed
      expect(result.items.length).toBe(4);

      const phoneItem = result.items.find(
        (i) => i.id === `activity-msg-${phoneFailedMsg.id}-failed`,
      )!;
      expect(phoneItem).toBeDefined();
      expect(phoneItem.description).toContain('+1 •••• 0999');
      expect(phoneItem.metadata?.failureReason).toContain('+1 •••• 0999');

      const emailItem = result.items.find(
        (i) => i.id === `activity-msg-${emailFailedMsg.id}-failed`,
      )!;
      expect(emailItem).toBeDefined();
      expect(emailItem.description).toContain('s••••r@example.com');
      expect(emailItem.metadata?.failureReason).toContain('s••••r@example.com');

      const downstreamItem = result.items.find(
        (i) => i.id === `activity-msg-${downstreamFailedMsg.id}-failed`,
      )!;
      expect(downstreamItem).toBeDefined();
      expect(downstreamItem.description).toContain('+1 •••• 0999');
      expect(downstreamItem.description).toContain('s••••r@example.com');
      expect(downstreamItem.metadata?.failureReason).toContain('+1 •••• 0999');
      expect(downstreamItem.metadata?.failureReason).toContain('s••••r@example.com');

      // Regression: neither raw recipient phone number nor email appears anywhere in serialized response
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(rawPhone);
      expect(serialized).not.toContain(rawEmail);
    });

    it('emits message_pending for queued/routing/submitting messages and never emits message_sent without accepted status', async () => {
      const channelId = '01900000-0000-7000-8000-000000000020';
      const queuedMsg = {
        id: '01900000-0000-7000-8000-000000000035',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'queued',
        createdAt: new Date('2026-11-04T12:00:00Z'),
        recipientAddress: '+12025550999',
      };

      mockTx.select.mockReturnValue(
        createMockQuery([{ message: queuedMsg, channelCode: 'sms', templateName: null }]),
      );

      const result = await service.listActivities(principal, contactId, { category: 'message' });

      expect(result.items.length).toBe(1);
      const pendingEvent = result.items[0]!;
      expect(pendingEvent.type).toBe('message_pending');
      expect(pendingEvent.title).toBe('SMS Pending Dispatch');
      expect(pendingEvent.description).toContain('awaiting dispatch');
      expect(pendingEvent.metadata?.status).toBe('queued');
      expect(pendingEvent.metadata?.recipientAddress).toBe('+1 •••• 0999');

      // No message_sent event emitted
      expect(result.items.find((i) => i.type === 'message_sent')).toBeUndefined();
    });

    it('strictly masks identity addresses and prevents raw/normalized address leakage in metadata', async () => {
      const channelId = '01900000-0000-7000-8000-000000000020';
      const rawPhone = '+12025550888';
      const identityRow = {
        id: '01900000-0000-7000-8000-000000000045',
        orgId,
        contactId,
        channelId,
        rawAddress: rawPhone,
        normalizedAddress: rawPhone,
        isPrimary: true,
        status: 'active',
        createdAt: new Date('2026-11-01T08:00:00Z'),
        updatedAt: new Date('2026-11-01T08:00:00Z'),
      };

      mockTx.select
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              where: jest
                .fn()
                .mockResolvedValue([{ identity: identityRow, channelCode: 'whatsapp' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        });

      const result = await service.listActivities(principal, contactId, { category: 'identity' });

      expect(result.items.length).toBe(1);
      const event = result.items[0]!;
      expect(event.type).toBe('identity_added');
      expect(event.title).toBe('Identity Added (+1 •••• 0888)');
      expect(event.description).toContain('+1 •••• 0888');
      expect(event.metadata?.maskedAddress).toBe('+1 •••• 0888');

      // Raw and normalized address properties MUST NOT be present in metadata
      expect(event.metadata?.rawAddress).toBeUndefined();
      expect(event.metadata?.normalizedAddress).toBeUndefined();

      // Regression: raw phone number NEVER appears in response
      const serialized = JSON.stringify(result.items);
      expect(serialized).not.toContain(rawPhone);
    });

    it('maps genuine consent events and identity events from database', async () => {
      const channelId = '01900000-0000-7000-8000-000000000020';
      const consentRow = {
        id: '01900000-0000-7000-8000-000000000040',
        orgId,
        workspaceId,
        contactId,
        channelId,
        consentType: 'marketing',
        event: 'grant',
        occurredAt: new Date('2026-11-01T10:05:00Z'),
        source: 'web_form',
      };

      mockTx.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ consent: consentRow, channelCode: 'whatsapp' }]),
          }),
        }),
      });

      const result = await service.listActivities(principal, contactId, { category: 'consent' });
      expect(result.items.length).toBe(1);
      expect(result.items[0]!.type).toBe('consent_granted');
      expect(result.items[0]!.category).toBe('consent');
      expect(result.items[0]!.statusTone).toBe('success');
      expect(result.items[0]!.description).toContain(
        'MARKETING consent granted (Source: web_form)',
      );
    });

    it('enforces tenant isolation and rejects cross-tenant requests with 404', async () => {
      const crossTenantPrincipal: AuthPrincipal = {
        type: 'user',
        userId: '01900000-0000-7000-8000-000000000099',
        tenant: { orgId: otherOrgId } as never,
        roles: [],
      } as unknown as AuthPrincipal;

      await expect(
        service.listActivities(crossTenantPrincipal, contactId, { category: 'all' }),
      ).rejects.toThrow('Contact not found');
    });

    it('paginates stably using keyset cursors', async () => {
      // Return 3 activities with limit 2
      const msg1 = {
        id: '01900000-0000-7000-8000-000000000051',
        orgId,
        workspaceId,
        contactId,
        channelId: '01900000-0000-7000-8000-000000000020',
        status: 'accepted',
        createdAt: new Date('2026-11-04T10:00:00Z'),
        recipientAddress: '+12025550123',
      };
      const msg2 = {
        id: '01900000-0000-7000-8000-000000000052',
        orgId,
        workspaceId,
        contactId,
        channelId: '01900000-0000-7000-8000-000000000020',
        status: 'accepted',
        createdAt: new Date('2026-11-03T10:00:00Z'),
        recipientAddress: '+12025550123',
      };
      const msg3 = {
        id: '01900000-0000-7000-8000-000000000053',
        orgId,
        workspaceId,
        contactId,
        channelId: '01900000-0000-7000-8000-000000000020',
        status: 'accepted',
        createdAt: new Date('2026-11-02T10:00:00Z'),
        recipientAddress: '+12025550123',
      };

      mockTx.select.mockReturnValue(
        createMockQuery([
          { message: msg1, channelCode: 'sms', templateName: null },
          { message: msg2, channelCode: 'sms', templateName: null },
          { message: msg3, channelCode: 'sms', templateName: null },
        ]),
      );

      // Page 1: limit 2
      const page1 = await service.listActivities(principal, contactId, {
        limit: 2,
        category: 'message',
      });
      expect(page1.items.length).toBe(2);
      expect(page1.page.hasMore).toBe(true);
      expect(page1.page.nextCursor).not.toBeNull();

      // Page 2: with cursor
      const page2 = await service.listActivities(principal, contactId, {
        limit: 2,
        cursor: page1.page.nextCursor!,
        category: 'message',
      });
      expect(page2.items.length).toBe(1);
      expect(page2.page.hasMore).toBe(false);
      expect(page2.page.nextCursor).toBeNull();

      // Ensure no overlapping IDs between page 1 and page 2
      const p1Ids = page1.items.map((i) => i.id);
      const p2Ids = page2.items.map((i) => i.id);
      expect(p1Ids.some((id) => p2Ids.includes(id))).toBe(false);
    });

    it('protects PII in category=message: populates knownAddresses from identity rows to sanitize failureReason without returning identity events', async () => {
      const channelId = '01900000-0000-7000-8000-000000000020';
      const rawPhone = '+12025550999';
      const rawEmail = 'sarah.alternate@example.com';

      const identity1 = {
        id: '01900000-0000-7000-8000-000000000061',
        orgId,
        contactId,
        workspaceId,
        channelId,
        rawAddress: rawPhone,
        normalizedAddress: rawPhone,
        isPrimary: true,
        status: 'active',
        createdAt: new Date('2026-11-01T10:00:00Z'),
      };
      const identity2 = {
        id: '01900000-0000-7000-8000-000000000062',
        orgId,
        contactId,
        workspaceId,
        channelId: '01900000-0000-7000-8000-000000000021',
        rawAddress: rawEmail,
        normalizedAddress: rawEmail,
        isPrimary: false,
        status: 'active',
        createdAt: new Date('2026-11-01T10:00:00Z'),
      };

      const msg = {
        id: '01900000-0000-7000-8000-000000000070',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'failed',
        deliveryStatus: 'undelivered',
        failureReason: `Provider rejected ${rawPhone} (alternate: ${rawEmail}): unreachable`,
        completedAt: new Date('2026-11-05T09:01:00Z'),
        createdAt: new Date('2026-11-05T09:00:00Z'),
        recipientAddress: rawPhone,
      };

      const tableMap = new Map<unknown, unknown[]>();
      tableMap.set(schema.contactIdentities, [
        { identity: identity1, channelCode: 'sms' },
        { identity: identity2, channelCode: 'email' },
      ]);
      tableMap.set(schema.messages, [{ message: msg, channelCode: 'sms', templateName: null }]);

      mockTx.select.mockReturnValue(createMockQuery([], tableMap));

      const result = await service.listActivities(principal, contactId, { category: 'message' });

      // Only 1 activity returned: the message failure (NO identity events leaked into category=message)
      expect(result.items.length).toBe(1);
      const failedItem = result.items[0]!;
      expect(failedItem.type).toBe('message_failed');
      expect(failedItem.category).toBe('message');

      // Failure reason in description and metadata must sanitize both the primary phone and alternate identity email
      expect(failedItem.description).toContain('+1 •••• 0999');
      expect(failedItem.description).toContain('s••••e@example.com');
      expect(failedItem.metadata?.failureReason).toContain('+1 •••• 0999');
      expect(failedItem.metadata?.failureReason).toContain('s••••e@example.com');

      // Regression: assert neither raw phone nor raw email appears anywhere in serialized response
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(rawPhone);
      expect(serialized).not.toContain(rawEmail);
    });

    it('correctly handles outcome_unknown with message_outcome_unknown and never emits message_sent or message_failed', async () => {
      const channelId = '01900000-0000-7000-8000-000000000020';
      const unknownMsg = {
        id: '01900000-0000-7000-8000-000000000080',
        orgId,
        workspaceId,
        contactId,
        channelId,
        status: 'outcome_unknown',
        createdAt: new Date('2026-11-04T12:00:00Z'),
        recipientAddress: '+12025550999',
      };

      mockTx.select.mockReturnValue(
        createMockQuery([{ message: unknownMsg, channelCode: 'whatsapp', templateName: null }]),
      );

      const result = await service.listActivities(principal, contactId, { category: 'message' });

      expect(result.items.length).toBe(1);
      const item = result.items[0]!;
      expect(item.type).toBe('message_outcome_unknown');
      expect(item.statusTone).toBe('warning');
      expect(item.title).toBe('WHATSAPP Dispatch Outcome Unknown');
      expect(item.description).toBe('Message submission outcome unknown');
      expect(item.metadata?.recipientAddress).toBe('+1 •••• 0999');

      // Regression: ensure it never generates message_sent or message_failed
      const types = result.items.map((i) => i.type);
      expect(types).not.toContain('message_sent');
      expect(types).not.toContain('message_failed');
    });
  });
});
