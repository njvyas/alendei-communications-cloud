/**
 * Phase 7 PR 7-3: the shared submission core against the real database
 * (handover §11.3 item 5, §8).
 *
 *   - Called directly inside a caller-owned tenant transaction under a session
 *     principal, the core creates exactly what `POST /messages` creates, with the
 *     caller's correlation id, and the caller's commit makes it visible.
 *   - A tenant session with no user and no API key — the shape a bare "system"
 *     caller would have — is refused by RLS (`app_content_context_valid`, 0027):
 *     the core fails closed and nothing commits. This documents the constraint the
 *     campaign executor identity (D-5, before 8B-3) must satisfy; 7-3 does not
 *     weaken it.
 *   - A caller error after `submit` rolls the message back with the caller's
 *     transaction: the core never commits on its own.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { type AuthPrincipal } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { AuthorizationService } from '../src/auth/authorization.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import { MessageSubmissionCore } from '../src/messages/submission/message-submission.core';
import { authorizeSubmission } from '../src/messages/submission/submission-authorization';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('Phase 7-3: MessageSubmissionCore in a caller-owned transaction', () => {
  let h: Harness;
  let db: TenantDatabase;
  let core: MessageSubmissionCore;
  let tenant: TenantFixture;
  let providerId: string;
  let whatsappId: string;
  let seq = 0;

  /** Stands in for an authorization decision already made by the caller. */
  const allow = { assert: async () => undefined } as unknown as AuthorizationService;
  const principal = {} as AuthPrincipal;

  beforeAll(async () => {
    h = await startHarness();
    db = h.app.get(TenantDatabase);
    core = h.app.get(MessageSubmissionCore);
    tenant = await createTenant(h.admin, 'p73-core', h.app.get(CredentialService));
    const [ch] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    whatsappId = ch!.id;
    const slug = `p73-core-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: whatsappId,
        name: `Phase 7-3 ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerId = p!.id;
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: tenant.orgId,
      channelId: whatsappId,
      providerId,
      priority: 1,
      status: 'active',
    });
  }, 60_000);

  afterAll(async () => {
    try {
      const org = [tenant.orgId];
      await h.admin
        .delete(schema.messageDispatchQueue)
        .where(inArray(schema.messageDispatchQueue.orgId, org))
        .catch(() => {});
      await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, org)).catch(() => {});
      await h.admin
        .delete(schema.messages)
        .where(inArray(schema.messages.orgId, org))
        .catch(() => {});
      await h.admin
        .delete(schema.contactIdentities)
        .where(inArray(schema.contactIdentities.orgId, org))
        .catch(() => {});
      await h.admin
        .delete(schema.contacts)
        .where(inArray(schema.contacts.orgId, org))
        .catch(() => {});
      await h.admin
        .delete(schema.organizationProviderAssignments)
        .where(inArray(schema.organizationProviderAssignments.orgId, org))
        .catch(() => {});
      await h.admin
        .delete(schema.providers)
        .where(eq(schema.providers.id, providerId))
        .catch(() => {});
      await destroyTenant(h.admin, tenant).catch(() => {});
    } finally {
      await h.close();
    }
  });

  const recipient = () => {
    seq += 1;
    return `+1202558${String(1000 + seq).padStart(4, '0')}`;
  };

  async function counts() {
    const n = async (table: string) => {
      const { rows } = await h.admin.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)} WHERE org_id = ${tenant.orgId}`,
      );
      return Number(rows[0]!.n);
    };
    return {
      messages: await n('messages'),
      queue: await n('message_dispatch_queue'),
      events: await n('message_events'),
      contacts: await n('contacts'),
      identities: await n('contact_identities'),
    };
  }

  const request = (to: string) => ({
    channelCode: 'whatsapp',
    recipient: to,
    payload: { text: 'core direct' },
  });

  it("creates the message in the caller's transaction, with the caller's correlation id", async () => {
    const before = await counts();
    const correlationId = `p73-core-${randomBytes(6).toString('hex')}`;
    const result = await db.withTenant(
      { orgId: tenant.orgId, userId: tenant.userId, resellerId: tenant.resellerId },
      async (tx) => {
        const authorization = await authorizeSubmission(allow, tx, principal, tenant.orgId);
        return core.submit(
          tx,
          { orgId: tenant.orgId, correlationId, authorization },
          request(recipient()),
        );
      },
    );
    expect(result).toMatchObject({
      status: 'queued',
      correlationId,
      workspaceId: tenant.workspaceId,
      channelId: whatsappId,
      channelCode: 'whatsapp',
    });
    const [row] = await h.admin
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, result.messageId));
    expect(row).toMatchObject({ orgId: tenant.orgId, correlationId, status: 'queued' });
    expect(row!.createdAt.toISOString()).toBe(result.createdAt.toISOString());
    expect(await counts()).toEqual({
      messages: before.messages + 1,
      queue: before.queue + 1,
      events: before.events + 1,
      contacts: before.contacts + 1,
      identities: before.identities + 1,
    });
  });

  it('fails closed under a tenant session with no user and no API key; nothing commits', async () => {
    const before = await counts();
    const error = await db
      .withTenant({ orgId: tenant.orgId, resellerId: tenant.resellerId }, async (tx) => {
        const authorization = await authorizeSubmission(allow, tx, principal, tenant.orgId);
        return core.submit(
          tx,
          { orgId: tenant.orgId, correlationId: 'p73-no-principal', authorization },
          request(recipient()),
        );
      })
      .then(
        () => null,
        (e: unknown) => e as { cause?: { code?: string } },
      );
    // Refused by row-level security (insufficient_privilege), not by any check of the core.
    expect(error?.cause?.code).toBe('42501');
    expect(await counts()).toEqual(before);
  });

  it("rolls back with the caller's transaction when the caller fails after submit", async () => {
    const before = await counts();
    await expect(
      db.withTenant(
        { orgId: tenant.orgId, userId: tenant.userId, resellerId: tenant.resellerId },
        async (tx) => {
          const authorization = await authorizeSubmission(allow, tx, principal, tenant.orgId);
          await core.submit(
            tx,
            { orgId: tenant.orgId, correlationId: 'p73-rollback', authorization },
            request(recipient()),
          );
          throw new Error('caller failed after submit');
        },
      ),
    ).rejects.toThrow('caller failed after submit');
    expect(await counts()).toEqual(before);
  });
});
