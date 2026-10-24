/**
 * Phase 4.3 G-2 (approach B, migration 0037): the dispatcher re-checks
 * suppression and consent on every claim.
 *
 * The send path refuses a suppressed or revoked recipient, but a message can
 * wait in the queue — or between a failed attempt and its fallback re-claim —
 * while either changes. This suite sends real SMS messages over HTTP, changes
 * the recipient's state afterwards, and dispatches:
 *   1. A channel-specific or organization-wide suppression, or a consent revoke,
 *      added after queueing settles the message `failed` with the code as its
 *      reason: no attempt, no adapter call, `message.failed` written before the
 *      queue row is released. A later re-grant, a suppression on another
 *      channel, a cleared one, or another tenant's, does not block.
 *   2. A fallback re-claim is re-checked: suppression or revoke after the first
 *      provider failed stops the message before the second provider.
 *   3. Parity: for each recipient state, the send path's verdict and the
 *      dispatcher's verdict are the same.
 *
 * The HTTP server listens once for the suite: supertest's per-request
 * listen/close otherwise races under concurrent requests. Simulator providers
 * only; no network. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, type SmsDltMetadata } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import { SimulatorAdapter } from '../src/provider-adapters/simulator.adapter';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  purgeProviderHealth,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

const TEMPLATE_DLT: SmsDltMetadata = {
  entityId: '1201159123456789012',
  templateId: '1207161234567890123',
  headerId: 'ALENDE',
};

interface Sender {
  readonly tenant: TenantFixture;
  readonly token: string;
  readonly smsTemplateId: string;
}

/** A recipient state applied after a first, clean send; `apply` gets that message's contact. */
interface RecipientState {
  readonly label: string;
  readonly apply: (address: string, contactId: string) => Promise<void>;
}

describe('Phase 4.3 G-2: dispatch-time suppression and consent re-check', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  const channelIds: Record<string, string> = {};
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const customRoles: string[] = [];
  let a: Sender;
  let other: TenantFixture;
  let recipientSeq = 0;
  let priorityBand = 0;
  let simulated: jest.SpyInstance;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    // One listening server for the suite (see the header).
    await new Promise<void>((resolve) => h.app.getHttpServer().listen(0, resolve));
    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['sms', 'whatsapp']));
    for (const row of rows) channelIds[row.code] = row.id;

    a = await sender('g2-int-a');
    other = await createTenant(h.admin, 'g2-int-other', credentials);
    tenants.push(other);
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
    simulated = jest.spyOn(
      SimulatorAdapter.prototype as unknown as { simulate: () => unknown },
      'simulate',
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await h.admin.delete(schema.messageDispatchQueue);
  });

  afterAll(async () => {
    try {
      if (dispatchPool) await dispatchPool.end();
      const orgIds = tenants.map((t) => t.orgId);
      if (providers.length > 0) {
        await purgeProviderHealth(
          h.admin,
          inArray(schema.providerHealth.providerId, providers),
        ).catch(() => {});
      }
      if (orgIds.length > 0) {
        await h.admin.delete(schema.messageDispatchQueue).catch(() => {});
        await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, orgIds)).catch(
          () => {},
        );
        await h.admin
          .delete(schema.messageAttempts)
          .where(inArray(schema.messageAttempts.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.messages)
          .where(inArray(schema.messages.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(inArray(schema.organizationProviderAssignments.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.templates)
          .where(inArray(schema.templates.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.consentEvents)
          .where(inArray(schema.consentEvents.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.suppressions)
          .where(inArray(schema.suppressions.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.contactIdentities)
          .where(inArray(schema.contactIdentities.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.contacts)
          .where(inArray(schema.contacts.orgId, orgIds))
          .catch(() => {});
      }
      if (customRoles.length > 0) {
        await h.admin
          .delete(schema.userRoles)
          .where(inArray(schema.userRoles.roleId, customRoles))
          .catch(() => {});
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, customRoles))
          .catch(() => {});
        await h.admin
          .delete(schema.roles)
          .where(inArray(schema.roles.id, customRoles))
          .catch(() => {});
      }
      for (const t of tenants) await destroyTenant(h.admin, t).catch(() => {});
      if (providers.length > 0) {
        await h.admin
          .delete(schema.providerCapabilities)
          .where(inArray(schema.providerCapabilities.providerId, providers))
          .catch(() => {});
        await h.admin
          .delete(schema.providers)
          .where(inArray(schema.providers.id, providers))
          .catch(() => {});
      }
    } finally {
      await h.close();
    }
  });

  // --- fixtures ---------------------------------------------------------------

  /** A tenant whose user may send and read messages, with an approved DLT-bound SMS template. */
  async function sender(label: string): Promise<Sender> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
      );
    const roleId = uuidv7();
    customRoles.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `g2_int_${randomBytes(4).toString('hex')}`,
      name: 'G-2 sender',
      description: 'Sends and reads messages',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    for (const p of perms) {
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId: p.id, orgId: tenant.orgId });
    }
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: tenant.userId,
        roleId,
        scopeType: 'organization',
        scopeId: tenant.orgId,
      });
    });
    const [template] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: tenant.orgId,
        channelId: channelIds.sms!,
        name: `g2_otp_${randomBytes(3).toString('hex')}`,
        body: 'Your verification code is {{1}}.',
        variables: { names: ['1'], dlt: TEMPLATE_DLT },
        approvalStatus: 'approved',
      })
      .returning();
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: login.body.data.accessToken as string, smsTemplateId: template!.id };
  }

  /** A new SMS simulator provider assigned to `a` (fresh per test: fallback excludes attempted ones). */
  async function smsProvider(rank: number, behavior = 'SUCCESS'): Promise<string> {
    const slug = `g2-sms-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelIds.sms!,
        name: `G-2 ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    await h.admin.insert(schema.providerCapabilities).values({
      providerId: p!.id,
      capabilityKey: 'simulator_behavior',
      value: behavior,
    });
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: a.tenant.orgId,
      channelId: channelIds.sms!,
      providerId: p!.id,
      priority: priorityBand + rank,
      status: 'active',
    });
    return p!.id;
  }

  /**
   * Disables every assignment of `a` and starts a fresh priority band, so each
   * test controls its own providers. Assignments are disabled, not deleted
   * (attempts reference them), and priority is unique per channel whatever the
   * status.
   */
  async function clearAssignments(): Promise<void> {
    await h.admin
      .update(schema.organizationProviderAssignments)
      .set({ status: 'disabled' })
      .where(eq(schema.organizationProviderAssignments.orgId, a.tenant.orgId));
    priorityBand += 10;
  }

  function nextRecipient(): string {
    recipientSeq += 1;
    return `+1202555${String(8000 + recipientSeq).padStart(4, '0')}`;
  }

  function send(recipient: string) {
    return request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Acc-Organization', a.tenant.orgId)
      .send({
        channelCode: 'sms',
        recipient,
        templateId: a.smsTemplateId,
        payload: { variables: { '1': '123456' } },
      });
  }

  /** Sends to a clean recipient; returns the queued message and the contact the send path resolved. */
  async function queued(recipient: string): Promise<{ messageId: string; contactId: string }> {
    const res = await send(recipient);
    expect(res.status).toBe(202);
    const messageId = res.body.data.id as string;
    return { messageId, contactId: (await messageRow(messageId)).contactId };
  }

  async function suppress(
    orgId: string,
    address: string,
    channel: string | null,
    status: 'active' | 'cleared' = 'active',
  ): Promise<void> {
    await h.admin.insert(schema.suppressions).values({
      orgId,
      channelId: channel ? channelIds[channel]! : null,
      rawAddress: address,
      normalizedAddress: address,
      reason: 'G-2 test',
      status,
      ...(status === 'cleared' ? { clearedAt: new Date(), clearedReason: 'G-2 test' } : {}),
    });
  }

  async function consent(
    contactId: string,
    event: 'grant' | 'revoke',
    occurredAt: string,
    channel = 'sms',
  ): Promise<void> {
    await h.admin.execute(sql`
      INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel_id, consent_type, event, occurred_at, source)
      VALUES (${uuidv7()}, ${a.tenant.orgId}, ${a.tenant.workspaceId}, ${contactId}, ${channelIds[channel]!},
              'transactional', ${event}, ${occurredAt}::timestamptz, 'g2-int-spec')`);
  }

  /** Claims and processes exactly one queued message; fails the test if another is claimed. */
  async function dispatchOnce(expectedMessageId: string) {
    const [claim] = await dispatcher.claimBatch(1);
    expect(claim?.messageId).toBe(expectedMessageId);
    return dispatcher.processClaim(claim!);
  }

  async function messageRow(id: string) {
    const [m] = await h.admin.select().from(schema.messages).where(eq(schema.messages.id, id));
    return m!;
  }

  async function attemptsOf(id: string) {
    return h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, id))
      .orderBy(schema.messageAttempts.attemptNumber);
  }

  async function eventsOf(id: string) {
    return h.admin
      .select({ type: schema.messageEvents.eventType, payload: schema.messageEvents.payload })
      .from(schema.messageEvents)
      .where(eq(schema.messageEvents.messageId, id))
      .orderBy(schema.messageEvents.createdAt, schema.messageEvents.id);
  }

  async function queueRows(id: string) {
    return h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, id));
  }

  /** The blocked message is terminal with `code`, with nothing submitted on this claim. */
  async function expectBlocked(messageId: string, code: string, priorAttempts: number) {
    const m = await messageRow(messageId);
    expect([m.status, m.failureReason]).toEqual(['failed', code]);
    expect(m.completedAt).not.toBeNull();
    expect(await attemptsOf(messageId)).toHaveLength(priorAttempts);
    const events = await eventsOf(messageId);
    expect(events.at(-1)).toEqual({
      type: 'message.failed',
      payload: { reason: code, attempts: priorAttempts },
    });
    expect(await queueRows(messageId)).toEqual([]);
  }

  // --- 1. state changed after queueing ----------------------------------------

  describe('1. recipient state changed after the message was queued', () => {
    beforeEach(async () => {
      await clearAssignments();
      await smsProvider(1);
    });

    it.each([
      ['a channel-specific suppression', 'sms'],
      ['an organization-wide suppression', null],
    ] as const)(
      '%s settles it failed RECIPIENT_SUPPRESSED, before any provider',
      async (_l, ch) => {
        const recipient = nextRecipient();
        const { messageId } = await queued(recipient);
        await suppress(a.tenant.orgId, recipient, ch);

        const result = await dispatchOnce(messageId);
        expect(result).toEqual({
          messageId,
          outcome: 'failed',
          error: ERROR_CODES.RECIPIENT_SUPPRESSED,
        });
        await expectBlocked(messageId, ERROR_CODES.RECIPIENT_SUPPRESSED, 0);
        expect(simulated).not.toHaveBeenCalled();
      },
    );

    it('a consent revoke settles it failed CONSENT_REVOKED, before any provider', async () => {
      const recipient = nextRecipient();
      const { messageId, contactId } = await queued(recipient);
      await consent(contactId, 'grant', '2026-10-24T09:00:00.000Z');
      await consent(contactId, 'revoke', '2026-10-24T09:30:00.000Z');

      const result = await dispatchOnce(messageId);
      expect(result.outcome).toBe('failed');
      expect(result.error).toBe(ERROR_CODES.CONSENT_REVOKED);
      await expectBlocked(messageId, ERROR_CODES.CONSENT_REVOKED, 0);
      expect(simulated).not.toHaveBeenCalled();
    });

    it('does not block on a later re-grant, another channel’s suppression, a cleared one, or another tenant’s', async () => {
      const regranted = nextRecipient();
      const r1 = await queued(regranted);
      await consent(r1.contactId, 'revoke', '2026-10-24T09:00:00.000Z');
      await consent(r1.contactId, 'grant', '2026-10-24T09:30:00.000Z');

      const otherChannel = nextRecipient();
      const r2 = await queued(otherChannel);
      await suppress(a.tenant.orgId, otherChannel, 'whatsapp');

      const cleared = nextRecipient();
      const r3 = await queued(cleared);
      await suppress(a.tenant.orgId, cleared, 'sms', 'cleared');

      const otherTenant = nextRecipient();
      const r4 = await queued(otherTenant);
      await suppress(other.orgId, otherTenant, null);

      for (const { messageId } of [r1, r2, r3, r4]) {
        expect((await dispatchOnce(messageId)).outcome).toBe('accepted');
        expect((await messageRow(messageId)).status).toBe('accepted');
      }
      expect(simulated).toHaveBeenCalledTimes(4);
    });
  });

  // --- 2. fallback re-claim -----------------------------------------------------

  describe('2. a fallback re-claim is re-checked', () => {
    beforeEach(async () => {
      await clearAssignments();
    });

    it.each([
      ['suppression', ERROR_CODES.RECIPIENT_SUPPRESSED],
      ['consent revoke', ERROR_CODES.CONSENT_REVOKED],
    ] as const)(
      'a %s after the primary failed stops it before the secondary provider',
      async (kind, code) => {
        const primary = await smsProvider(1, '500');
        await smsProvider(2);
        const recipient = nextRecipient();
        const { messageId, contactId } = await queued(recipient);

        const first = await dispatchOnce(messageId);
        expect(first.outcome).toBe('failed');
        expect(first.error).toContain('PROVIDER_ERROR');
        expect((await messageRow(messageId)).status).toBe('queued');

        if (kind === 'suppression') await suppress(a.tenant.orgId, recipient, 'sms');
        else await consent(contactId, 'revoke', '2026-10-24T09:00:00.000Z');

        const second = await dispatchOnce(messageId);
        expect(second).toEqual({ messageId, outcome: 'failed', error: code });
        await expectBlocked(messageId, code, 1);
        const attempts = await attemptsOf(messageId);
        expect(attempts.map((x) => [x.providerId, x.status])).toEqual([[primary, 'failed']]);
        // Only the primary was ever reached.
        expect(simulated).toHaveBeenCalledTimes(1);
      },
    );

    it('a fallback re-claim with an unchanged recipient still reaches the secondary (control)', async () => {
      await smsProvider(1, '500');
      const secondary = await smsProvider(2);
      const { messageId } = await queued(nextRecipient());

      expect((await dispatchOnce(messageId)).outcome).toBe('failed');
      expect((await dispatchOnce(messageId)).outcome).toBe('accepted');
      const attempts = await attemptsOf(messageId);
      expect(attempts.map((x) => x.providerId).at(-1)).toBe(secondary);
    });
  });

  // --- 3. send / dispatch parity ------------------------------------------------

  describe('3. send-path and dispatch verdicts agree', () => {
    beforeEach(async () => {
      await clearAssignments();
      await smsProvider(1);
    });

    const states: RecipientState[] = [
      { label: 'no suppression or consent events', apply: async () => {} },
      {
        label: 'active SMS suppression',
        apply: (addr) => suppress(a.tenant.orgId, addr, 'sms'),
      },
      {
        label: 'active organization-wide suppression',
        apply: (addr) => suppress(a.tenant.orgId, addr, null),
      },
      {
        label: 'active WhatsApp-only suppression',
        apply: (addr) => suppress(a.tenant.orgId, addr, 'whatsapp'),
      },
      {
        label: 'cleared SMS and organization-wide suppressions',
        apply: async (addr) => {
          await suppress(a.tenant.orgId, addr, 'sms', 'cleared');
          await suppress(a.tenant.orgId, addr, null, 'cleared');
        },
      },
      {
        label: 'another tenant’s suppression of the same address',
        apply: (addr) => suppress(other.orgId, addr, null),
      },
      {
        label: 'grant only',
        apply: (_a, c) => consent(c, 'grant', '2026-10-24T09:00:00.000Z'),
      },
      {
        label: 'revoke only',
        apply: (_a, c) => consent(c, 'revoke', '2026-10-24T09:00:00.000Z'),
      },
      {
        label: 'revoke, then a later grant',
        apply: async (_a, c) => {
          await consent(c, 'revoke', '2026-10-24T09:00:00.000Z');
          await consent(c, 'grant', '2026-10-24T09:00:01.000Z');
        },
      },
      {
        label: 'grant, then a later revoke',
        apply: async (_a, c) => {
          await consent(c, 'grant', '2026-10-24T09:00:00.000Z');
          await consent(c, 'revoke', '2026-10-24T09:00:01.000Z');
        },
      },
      {
        label: 'grant and revoke at the same instant',
        apply: async (_a, c) => {
          await consent(c, 'grant', '2026-10-24T09:00:00.000Z');
          await consent(c, 'revoke', '2026-10-24T09:00:00.000Z');
        },
      },
      {
        label: 'revoke 500 µs before a grant, in the same millisecond',
        apply: async (_a, c) => {
          await consent(c, 'revoke', '2026-10-24T09:00:00.123400Z');
          await consent(c, 'grant', '2026-10-24T09:00:00.123900Z');
        },
      },
      {
        label: 'revoke on WhatsApp only',
        apply: (_a, c) => consent(c, 'revoke', '2026-10-24T09:00:00.000Z', 'whatsapp'),
      },
      {
        label: 'suppressed and revoked (suppression reported first)',
        apply: async (addr, c) => {
          await suppress(a.tenant.orgId, addr, null);
          await consent(c, 'revoke', '2026-10-24T09:00:00.000Z');
        },
      },
    ];

    it('for every recipient state, POST /messages and the dispatcher reach the same verdict', async () => {
      const table: Array<{ state: string; send: string; dispatch: string }> = [];
      for (const state of states) {
        const recipient = nextRecipient();
        // Queued while the recipient was clean; then the state changes.
        const { messageId, contactId } = await queued(recipient);
        await state.apply(recipient, contactId);

        const res = await send(recipient);
        const sendVerdict =
          res.status === 202 ? 'accepted' : `${res.status} ${res.body.error?.code as string}`;

        // Dispatch everything queued: the earlier message, and the new one if accepted.
        const results = await dispatcher.dispatchBatch(10);
        const earlier = results.find((r) => r.messageId === messageId);
        expect(earlier).toBeDefined();
        const m = await messageRow(messageId);
        const dispatchVerdict =
          m.status === 'accepted' ? 'accepted' : `422 ${m.failureReason ?? m.status}`;

        table.push({ state: state.label, send: sendVerdict, dispatch: dispatchVerdict });
        if (res.status === 202) {
          expect((await messageRow(res.body.data.id as string)).status).toBe('accepted');
        }
      }
      expect(table.map((r) => [r.state, r.dispatch])).toEqual(table.map((r) => [r.state, r.send]));
      // The fixtures cover both outcomes of each rule, not one verdict throughout.
      expect(new Set(table.map((r) => r.send))).toEqual(
        new Set(['accepted', '422 RECIPIENT_SUPPRESSED', '422 CONSENT_REVOKED']),
      );
    });
  });
});
