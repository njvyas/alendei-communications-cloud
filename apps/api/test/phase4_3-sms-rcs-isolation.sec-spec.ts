/**
 * Phase 4.3 (Gate F.3), batch F.3-3: idempotency and cross-tenant isolation for
 * SMS and RCS messages.
 *
 * Phase 4.1 covers an SMS idempotent replay and a cross-tenant SMS template
 * probe (`phase4_1-data-foundation.sec-spec.ts`). This suite covers the rest:
 *   1. Idempotency — an RCS replay returns the same message with one queue row;
 *      a key reused with a different SMS or RCS body is refused and stores
 *      nothing; the same key in another tenant is that tenant's own request; a
 *      replay after dispatch neither re-enqueues nor resubmits.
 *   2. HTTP isolation — tenant B cannot read tenant A's SMS or RCS messages, does
 *      not see them in its list, and cannot send into tenant A's organization.
 *   3. Database isolation — under `acc_app` with tenant B's context, A's SMS and
 *      RCS messages, attempts and events are invisible and unchangeable, while A's
 *      own context sees them (so the check is not vacuous); under `acc_dispatch`,
 *      a live claim on B's message exposes none of A's content.
 *
 * Simulator providers only; no network. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  PERMISSIONS,
  type ProviderSubmission,
  type RcsBasicPayload,
  type SmsDltMetadata,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
const RCS_TEXT: RcsBasicPayload = { messageType: 'text', text: 'Your table is ready' };
const RCS_OTHER: RcsBasicPayload = { messageType: 'text', text: 'Your table is cancelled' };

interface Sender {
  readonly tenant: TenantFixture;
  readonly token: string;
  readonly smsTemplateId: string;
}

describe('Phase 4.3 F.3-3: SMS and RCS idempotency and cross-tenant isolation', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  let appPool: Pool;
  const channelIds: Record<string, string> = {};
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const customRoles: string[] = [];
  let a: Sender;
  let b: Sender;
  let recipientSeq = 0;
  let simulated: jest.SpyInstance;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['sms', 'rcs']));
    for (const row of rows) channelIds[row.code] = row.id;

    a = await sender('p43-iso-a');
    b = await sender('p43-iso-b');
    for (const s of [a, b]) {
      await assigned(s, 'sms');
      await assigned(s, 'rcs');
    }
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
      if (appPool) await appPool.end();
      if (dispatchPool) await dispatchPool.end();
      const orgIds = tenants.map((t) => t.orgId);
      if (providers.length > 0) {
        await purgeProviderHealth(
          h.admin,
          inArray(schema.providerHealth.providerId, providers),
        ).catch(() => {});
      }
      if (orgIds.length > 0) {
        await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, orgIds)).catch(
          () => {},
        );
        await h.admin
          .delete(schema.messageAttempts)
          .where(inArray(schema.messageAttempts.orgId, orgIds))
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
      key: `p43_iso_${randomBytes(4).toString('hex')}`,
      name: 'Phase 4.3 isolation sender',
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
        name: `p43_iso_otp_${randomBytes(3).toString('hex')}`,
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

  async function assigned(s: Sender, channel: 'sms' | 'rcs'): Promise<string> {
    const slug = `p43-iso-${channel}-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelIds[channel]!,
        name: `Phase 4.3 ${slug}`,
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
      value: 'SUCCESS',
    });
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: s.tenant.orgId,
      channelId: channelIds[channel]!,
      providerId: p!.id,
      priority: 1,
      status: 'active',
    });
    return p!.id;
  }

  function nextRecipient(): string {
    recipientSeq += 1;
    return `+1202555${String(6000 + recipientSeq).padStart(4, '0')}`;
  }

  const smsBody = (s: Sender, recipient: string, code = '123456') => ({
    channelCode: 'sms',
    recipient,
    templateId: s.smsTemplateId,
    payload: { variables: { '1': code } },
  });
  const rcsBody = (recipient: string, payload: RcsBasicPayload = RCS_TEXT) => ({
    channelCode: 'rcs',
    recipient,
    payload,
  });

  function post(s: Sender, body: Record<string, unknown>, key?: string, orgId = s.tenant.orgId) {
    const req = request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Acc-Organization', orgId);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  }

  function get(s: Sender, path: string) {
    return request(h.app.getHttpServer())
      .get(url(path))
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Acc-Organization', s.tenant.orgId);
  }

  async function messageCount(orgId: string): Promise<number> {
    const { rows } = await h.admin.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM messages WHERE org_id = ${orgId}`,
    );
    return Number(rows[0]!.n);
  }

  async function queueRows(messageId: string) {
    return h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, messageId));
  }

  /** Sends one SMS and one RCS message for `s` and dispatches both, so each has an attempt and events. */
  async function dispatchedPair(s: Sender): Promise<{ sms: string; rcs: string }> {
    const sms = (await post(s, smsBody(s, nextRecipient())).expect(202)).body.data.id as string;
    const rcs = (await post(s, rcsBody(nextRecipient())).expect(202)).body.data.id as string;
    for (const id of [sms, rcs]) {
      const [claim] = await dispatcher.claimBatch(1);
      expect(claim?.messageId).toBe(id);
      expect((await dispatcher.processClaim(claim!)).outcome).toBe('accepted');
    }
    return { sms, rcs };
  }

  // --- 1. idempotency -----------------------------------------------------------

  describe('1. idempotency', () => {
    it('an RCS replay returns the same message, with one message row and one queue row', async () => {
      const key = randomUUID();
      const body = rcsBody(nextRecipient());
      const before = await messageCount(a.tenant.orgId);

      const first = await post(a, body, key).expect(202);
      const second = await post(a, body, key).expect(202);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data).toEqual(first.body.data);
      expect(await messageCount(a.tenant.orgId)).toBe(before + 1);
      expect(await queueRows(first.body.data.id)).toHaveLength(1);
    });

    it.each(['sms', 'rcs'] as const)(
      '%s: a key reused with a different body is refused 422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH and stores nothing',
      async (channel) => {
        const key = randomUUID();
        const recipient = nextRecipient();
        const original = channel === 'sms' ? smsBody(a, recipient, '111111') : rcsBody(recipient);
        const changed =
          channel === 'sms' ? smsBody(a, recipient, '222222') : rcsBody(recipient, RCS_OTHER);

        const first = await post(a, original, key).expect(202);
        const before = await messageCount(a.tenant.orgId);
        const conflict = await post(a, changed, key).expect(422);

        expect(conflict.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
        // The refusal does not echo the original request or its message.
        expect(JSON.stringify(conflict.body)).not.toContain(first.body.data.id);
        expect(await messageCount(a.tenant.orgId)).toBe(before);
        const [stored] = await h.admin
          .select({ payload: schema.messages.payload })
          .from(schema.messages)
          .where(eq(schema.messages.id, first.body.data.id));
        expect(JSON.stringify(stored!.payload)).not.toContain(
          channel === 'sms' ? '222222' : 'cancelled',
        );
      },
    );

    it.each(['sms', 'rcs'] as const)(
      '%s: the same key in another tenant is that tenant’s own request, never a replay of the first',
      async (channel) => {
        const key = randomUUID();
        const recipient = nextRecipient();
        const fromA = await post(
          a,
          channel === 'sms' ? smsBody(a, recipient) : rcsBody(recipient),
          key,
        ).expect(202);
        const fromB = await post(
          b,
          channel === 'sms' ? smsBody(b, recipient) : rcsBody(recipient),
          key,
        ).expect(202);

        expect(fromB.body.data.id).not.toBe(fromA.body.data.id);
        const owners = await h.admin
          .select({ id: schema.messages.id, orgId: schema.messages.orgId })
          .from(schema.messages)
          .where(inArray(schema.messages.id, [fromA.body.data.id, fromB.body.data.id]));
        expect(Object.fromEntries(owners.map((m) => [m.id, m.orgId]))).toEqual({
          [fromA.body.data.id]: a.tenant.orgId,
          [fromB.body.data.id]: b.tenant.orgId,
        });
      },
    );

    it.each(['sms', 'rcs'] as const)(
      '%s: a replay after dispatch neither re-enqueues nor resubmits',
      async (channel) => {
        const key = randomUUID();
        const body = channel === 'sms' ? smsBody(a, nextRecipient()) : rcsBody(nextRecipient());
        const first = await post(a, body, key).expect(202);
        const id = first.body.data.id as string;
        const [claim] = await dispatcher.claimBatch(1);
        expect(claim?.messageId).toBe(id);
        expect((await dispatcher.processClaim(claim!)).outcome).toBe('accepted');
        expect(simulated).toHaveBeenCalledTimes(1);

        const replay = await post(a, body, key).expect(202);

        expect(replay.body.data.id).toBe(id);
        expect(await queueRows(id)).toHaveLength(0);
        expect(await dispatcher.claimBatch(1)).toEqual([]);
        expect(simulated).toHaveBeenCalledTimes(1);
        const attempts = await h.admin
          .select()
          .from(schema.messageAttempts)
          .where(eq(schema.messageAttempts.messageId, id));
        expect(attempts).toHaveLength(1);
        const [m] = await h.admin
          .select({ status: schema.messages.status })
          .from(schema.messages)
          .where(eq(schema.messages.id, id));
        expect(m!.status).toBe('accepted');
        // Exactly what the simulator received, once.
        const submission = simulated.mock.calls[0]![2] as ProviderSubmission;
        expect(submission.channel).toBe(channel);
      },
    );
  });

  // --- 2. HTTP isolation ----------------------------------------------------------

  describe('2. HTTP isolation', () => {
    it('tenant B cannot read tenant A’s SMS or RCS message (404, as for a message that does not exist)', async () => {
      const { sms, rcs } = await dispatchedPair(a);
      for (const id of [sms, rcs]) {
        const own = await get(a, `/messages/${id}`).expect(200);
        expect(own.body.data.id).toBe(id);
        const foreign = await get(b, `/messages/${id}`).expect(404);
        expect(foreign.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
        const missing = await get(b, `/messages/${uuidv7()}`).expect(404);
        expect(foreign.body.error.code).toBe(missing.body.error.code);
        expect(JSON.stringify(foreign.body)).not.toContain(a.tenant.orgId);
      }
    });

    it('tenant B’s message list, filtered by SMS or RCS, never includes tenant A’s messages', async () => {
      const { sms, rcs } = await dispatchedPair(a);
      for (const channel of ['sms', 'rcs'] as const) {
        const res = await get(b, `/messages?channelCode=${channel}&limit=100`).expect(200);
        const ids = (res.body.data as { id: string }[]).map((m) => m.id);
        expect(ids).not.toContain(sms);
        expect(ids).not.toContain(rcs);
        const ownList = await get(a, `/messages?channelCode=${channel}&limit=100`).expect(200);
        expect((ownList.body.data as { id: string }[]).map((m) => m.id)).toContain(
          channel === 'sms' ? sms : rcs,
        );
      }
    });

    it.each(['sms', 'rcs'] as const)(
      '%s: tenant B cannot send into tenant A’s organization; nothing is stored there',
      async (channel) => {
        const before = await messageCount(a.tenant.orgId);
        const body = channel === 'sms' ? smsBody(a, nextRecipient()) : rcsBody(nextRecipient());
        const res = await post(b, body, randomUUID(), a.tenant.orgId);

        // Refused at scope selection, before the send path is reached, and
        // without confirming that the organization exists.
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
        expect(JSON.stringify(res.body)).not.toContain(a.tenant.orgId);
        expect(await messageCount(a.tenant.orgId)).toBe(before);
      },
    );
  });

  // --- 3. database isolation ---------------------------------------------------------

  describe('3. database isolation', () => {
    async function asApp<T>(
      tenant: TenantFixture,
      work: (
        q: (text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>,
      ) => Promise<void>,
    ) {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true)`,
          [tenant.orgId, tenant.userId],
        );
        await work((text, values) => client.query(text, values) as never);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }

    it('acc_app: under tenant B’s context, A’s SMS and RCS messages, attempts and events are invisible and unchangeable', async () => {
      const { sms, rcs } = await dispatchedPair(a);
      const ids = [sms, rcs];

      // Positive control: A's own context sees all three tables' rows.
      await asApp(a.tenant, async (q) => {
        expect((await q(`SELECT id FROM messages WHERE id = ANY($1)`, [ids])).rows).toHaveLength(2);
        expect(
          (await q(`SELECT id FROM message_attempts WHERE message_id = ANY($1)`, [ids])).rows,
        ).toHaveLength(2);
        expect(
          (await q(`SELECT id FROM message_events WHERE message_id = ANY($1)`, [ids])).rows.length,
        ).toBeGreaterThanOrEqual(2);
      });

      await asApp(b.tenant, async (q) => {
        expect((await q(`SELECT id FROM messages WHERE id = ANY($1)`, [ids])).rows).toHaveLength(0);
        expect(
          (await q(`SELECT id FROM message_attempts WHERE message_id = ANY($1)`, [ids])).rows,
        ).toHaveLength(0);
        expect(
          (await q(`SELECT id FROM message_events WHERE message_id = ANY($1)`, [ids])).rows,
        ).toHaveLength(0);
        const updated = await q(
          `UPDATE messages SET failure_reason = 'cross-tenant' WHERE id = ANY($1)`,
          [ids],
        );
        expect(updated.rowCount).toBe(0);
      });

      const rows = await h.admin
        .select({ failureReason: schema.messages.failureReason })
        .from(schema.messages)
        .where(inArray(schema.messages.id, ids));
      expect(rows.every((r) => r.failureReason !== 'cross-tenant')).toBe(true);
    });

    it('acc_dispatch: a live claim on B’s message exposes none of A’s SMS or RCS content', async () => {
      const { sms, rcs } = await dispatchedPair(a);
      const bMessage = (await post(b, rcsBody(nextRecipient())).expect(202)).body.data.id as string;
      const client = await dispatchPool.connect();
      try {
        await client.query('BEGIN');
        const token = randomUUID();
        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = $1, claimed_until = now() + interval '30 seconds',
               dispatch_epoch = dispatch_epoch + 1
           WHERE message_id = $2`,
          [token, bMessage],
        );
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [b.tenant.orgId, bMessage, token],
        );

        // Positive control: the claimed message itself is visible.
        expect(
          (await client.query(`SELECT id FROM messages WHERE id = $1`, [bMessage])).rows,
        ).toHaveLength(1);

        const ids = [sms, rcs];
        expect(
          (await client.query(`SELECT id FROM messages WHERE id = ANY($1)`, [ids])).rows,
        ).toHaveLength(0);
        expect(
          (await client.query(`SELECT id FROM message_attempts WHERE message_id = ANY($1)`, [ids]))
            .rows,
        ).toHaveLength(0);
        // Stricter still: acc_dispatch may only write events, never read them
        // (migration 0033 grants INSERT alone), so no tenant's events are readable.
        await client.query('SAVEPOINT read_events');
        await expect(
          client.query(`SELECT id FROM message_events WHERE message_id = ANY($1)`, [ids]),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT read_events');
        const updated = await client.query(
          `UPDATE messages SET status = 'failed' WHERE id = ANY($1)`,
          [ids],
        );
        expect(updated.rowCount).toBe(0);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      const statuses = await h.admin
        .select({ status: schema.messages.status })
        .from(schema.messages)
        .where(
          and(inArray(schema.messages.id, [sms, rcs]), eq(schema.messages.orgId, a.tenant.orgId)),
        );
      expect(statuses.map((s) => s.status)).toEqual(['accepted', 'accepted']);
    });
  });
});
