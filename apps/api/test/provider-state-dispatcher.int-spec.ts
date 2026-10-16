/**
 * Verification of HIGH-6 (dispatcher audit suppression for system actors)
 * and MEDIUM-7 (correlation ID propagation & missing HTTP context safety).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { type AuthPrincipal } from '@acc/contracts';
import { schema } from '@acc/db';
import { desc, eq, sql } from 'drizzle-orm';

import { RequestContext } from '../src/common/context/request-context';
import { CredentialService } from '../src/iam/credential.service';
import { ProviderSubmissionExecutor } from '../src/provider-adapters/submission-executor';
import { ProviderStateStore } from '../src/providers/provider-state.store';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  purgeProviderHealth,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('ProviderStateStore Dispatcher Execution (HIGH-6 & MEDIUM-7)', () => {
  let h: Harness;
  let store: ProviderStateStore;
  let executor: ProviderSubmissionExecutor;
  let channelId: string;
  let providerId: string;
  let tenant: TenantFixture | undefined;

  beforeAll(async () => {
    h = await startHarness();
    store = h.app.get(ProviderStateStore);
    executor = h.app.get(ProviderSubmissionExecutor);

    // Fetch existing SMS channel or insert test channel
    const channels = await h.admin.select().from(schema.channels);
    if (channels.length > 0) {
      channelId = channels[0]!.id;
    } else {
      const [c] = await h.admin
        .insert(schema.channels)
        .values({
          channelCode: 'sms',
          name: 'SMS',
          category: 'messaging',
          messageTypes: ['text'],
        })
        .returning();
      channelId = c!.id;
    }

    // Insert test provider
    const slug = `test-prov-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `Provider ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerId = p!.id;
  }, 60_000);

  afterAll(async () => {
    try {
      if (h?.admin) {
        if (providerId) {
          await purgeProviderHealth(h.admin, sql`provider_id = ${providerId}`).catch(() => {});
        }
        if (tenant) {
          await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, tenant.orgId)).catch(
            () => {},
          );
          await h.admin
            .delete(schema.messageAttempts)
            .where(eq(schema.messageAttempts.orgId, tenant.orgId))
            .catch(() => {});
          await h.admin
            .delete(schema.messages)
            .where(eq(schema.messages.orgId, tenant.orgId))
            .catch(() => {});
          await h.admin
            .delete(schema.contacts)
            .where(eq(schema.contacts.orgId, tenant.orgId))
            .catch(() => {});
          await h.admin
            .delete(schema.organizationProviderAssignments)
            .where(eq(schema.organizationProviderAssignments.orgId, tenant.orgId))
            .catch(() => {});
          await destroyTenant(h.admin, tenant).catch(() => {});
        }
        if (providerId) {
          await h.admin
            .delete(schema.providers)
            .where(eq(schema.providers.id, providerId))
            .catch(() => {});
        }
      }
    } catch {
      // Best-effort cleanup
    } finally {
      await h.close();
    }
  });

  it('MEDIUM-7: RequestContext.correlationId() safely returns fallback outside HTTP context', () => {
    expect(RequestContext.correlationId()).toBe('no-correlation-id');

    const result = RequestContext.run(
      {
        correlationId: 'test-corr-1234',
        requestId: randomUUID(),
        causationId: null,
        traceId: null,
        principal: null,
        ip: null,
        userAgent: null,
      },
      () => RequestContext.correlationId(),
    );
    expect(result).toBe('test-corr-1234');
  });

  it('HIGH-6: System actor skips audit log insertion during submission recording, and records attemptId', async () => {
    tenant = await createTenant(h.admin, 'disp-test', h.app.get(CredentialService));

    // Assign provider to organization for channel
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: tenant.orgId,
      channelId,
      providerId,
      priority: 1,
      status: 'active',
    });

    // Insert contact, message and attempt to satisfy FK provider_health_attempt_provider_fk
    const [contact] = await h.admin
      .insert(schema.contacts)
      .values({
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
      })
      .returning();

    const [msg] = await h.admin
      .insert(schema.messages)
      .values({
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        contactId: contact!.id,
        channelId,
        recipientAddress: '+1234567890',
        payload: { text: 'Test' },
        status: 'submitting',
        correlationId: randomUUID(),
      })
      .returning();

    const [att] = await h.admin
      .insert(schema.messageAttempts)
      .values({
        messageId: msg!.id,
        orgId: tenant.orgId,
        providerId,
        channelId,
        attemptNumber: 1,
        fencingEpoch: 0,
        claimToken: randomUUID(),
        status: 'submitting',
      })
      .returning();

    const attemptId = att!.id;

    const systemPrincipal: AuthPrincipal = {
      actorType: 'system',
      userId: null,
      apiKeyId: null,
      roles: [],
      tenant: { orgId: null, resellerId: null },
      session: null,
    };

    // 1. Admit submission under system principal
    const admission = await h.admin.transaction(async (tx) => {
      return store.admit(tx, systemPrincipal, providerId);
    });

    if (!admission.admitted) {
      throw new Error('Expected provider submission to be admitted');
    }

    // 2. Execute submission via executor with 500 failure
    const settled = await executor.execute(
      admission.admission,
      {
        to: '+1234567890',
        type: 'text',
        content: { text: 'Test' },
      },
      '500',
    );

    // 3. Count audit logs before recordSubmission
    const auditBefore = await h.admin.select().from(schema.auditLogs);

    // 4. Record submission with attemptId under system principal
    await h.admin.transaction(async (tx) => {
      await store.recordSubmission(tx, systemPrincipal, settled, { attemptId });
    });

    // 5. Verify attemptId is saved in providerHealth
    const [healthSample] = await h.admin
      .select()
      .from(schema.providerHealth)
      .where(eq(schema.providerHealth.providerId, providerId))
      .orderBy(desc(schema.providerHealth.observedAt), desc(schema.providerHealth.id))
      .limit(1);

    expect(healthSample).toBeDefined();
    expect(healthSample?.attemptId).toBe(attemptId);
    expect(healthSample?.outcome).toBe('provider_error');

    // 6. Verify NO new audit logs were created by system actor (HIGH-6 audit suppression)
    const auditAfter = await h.admin.select().from(schema.auditLogs);
    expect(auditAfter.length).toBe(auditBefore.length);
  });
});
