// Must stay the first import: it switches the dispatch loop on before the
// application module (and its configuration) is loaded.
import { POLL_INTERVAL_MS, PREVIOUS } from './dispatch-worker.env';

import { randomBytes, randomUUID } from 'node:crypto';
import { PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { DispatchWorker } from '../src/messages/dispatch/dispatch.worker';
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

// Each case signs a user in (Argon2) and waits for real poll cycles and leases;
// Jest's per-project testTimeout does not apply, so the default 5 s is too tight.
jest.setTimeout(30_000);
const TERMINAL = new Set(['accepted', 'failed', 'outcome_unknown']);

/**
 * B1 (first release): the dispatch loop runs inside the booted application
 * (ADR-014 §9, D18). Every message here is submitted over HTTP or left in the
 * queue, and reaches its final state with nothing in the suite calling the
 * dispatcher. Each case uses its own tenant, so a running loop — which serves
 * the whole queue — cannot blur one case's assertions with another's.
 */
describe('Dispatch worker in the booted application (B1, ADR-014 D18)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let channelId: string;
  let messagesPermissionIds: string[];
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const roleIds: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);

    const [channel] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'))
      .limit(1);
    channelId = channel!.id;

    messagesPermissionIds = (
      await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(
          inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
        )
    ).map((p) => p.id);
  }, 60_000);

  afterAll(async () => {
    try {
      const orgIds = tenants.map((t) => t.orgId);
      if (orgIds.length > 0) {
        await h.admin
          .delete(schema.messageDispatchQueue)
          .where(inArray(schema.messageDispatchQueue.orgId, orgIds));
        await purgeMessageEvents(h.admin, inArray(schema.messageEvents.orgId, orgIds));
        if (providers.length > 0) {
          await purgeProviderHealth(h.admin, inArray(schema.providerHealth.providerId, providers));
        }
        await h.admin
          .delete(schema.messageAttempts)
          .where(inArray(schema.messageAttempts.orgId, orgIds));
        await h.admin.delete(schema.messages).where(inArray(schema.messages.orgId, orgIds));
        await h.admin
          .delete(schema.contactIdentities)
          .where(inArray(schema.contactIdentities.orgId, orgIds));
        await h.admin.delete(schema.contacts).where(inArray(schema.contacts.orgId, orgIds));
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(inArray(schema.organizationProviderAssignments.orgId, orgIds));
      }
      if (providers.length > 0) {
        await h.admin
          .delete(schema.providerCapabilities)
          .where(inArray(schema.providerCapabilities.providerId, providers));
        await h.admin.delete(schema.providers).where(inArray(schema.providers.id, providers));
      }
      if (roleIds.length > 0) {
        await h.admin.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, roleIds));
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roleIds));
        await h.admin.delete(schema.roles).where(inArray(schema.roles.id, roleIds));
      }
      for (const t of tenants) await destroyTenant(h.admin, t);
    } finally {
      await h.close();
      for (const [key, value] of Object.entries(PREVIOUS)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  // --- fixtures ---------------------------------------------------------------

  interface Sender {
    readonly tenant: TenantFixture;
    readonly token: string;
  }

  /** A tenant whose admin may send and read messages, signed in. */
  async function sender(label: string): Promise<Sender> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);
    const roleId = uuidv7();
    roleIds.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `dw_role_${randomBytes(4).toString('hex')}`,
      name: 'Messages Role',
      description: 'Allows messages send and read',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    for (const permissionId of messagesPermissionIds) {
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId, orgId: tenant.orgId });
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
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: login.body.data.accessToken as string };
  }

  /** An active simulator provider on WhatsApp, optionally scripted to misbehave. */
  async function provider(behavior?: '500' | 'TIMEOUT'): Promise<string> {
    const slug = `dw-${randomBytes(4).toString('hex')}`;
    const [row] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `WhatsApp Simulator ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(row!.id);
    if (behavior) {
      await h.admin.insert(schema.providerCapabilities).values({
        providerId: row!.id,
        capabilityKey: 'simulator_behavior',
        value: behavior,
      });
    }
    return row!.id;
  }

  async function assign(tenant: TenantFixture, providerId: string, priority: number) {
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: tenant.orgId,
      channelId,
      providerId,
      priority,
      status: 'active',
    });
  }

  /**
   * Sequential callers only: concurrent first sends to one new recipient race on
   * creating its contact identity (a pre-existing `POST /messages` defect,
   * reported with B1), which is not what these cases test.
   */
  async function submit(
    s: Sender,
    text = 'B1 dispatch',
    recipient = '+12025550199',
  ): Promise<string> {
    const res = await request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Acc-Organization', s.tenant.orgId)
      .set('Idempotency-Key', randomUUID())
      .send({ channelCode: 'whatsapp', recipient, payload: { text } });
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('queued');
    return res.body.data.id as string;
  }

  /** Reads the message over the API until it is terminal. */
  async function settled(s: Sender, messageId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await request(h.app.getHttpServer())
        .get(url(`/messages/${messageId}`))
        .set('Authorization', `Bearer ${s.token}`)
        .set('X-Acc-Organization', s.tenant.orgId)
        .expect(200);
      if (TERMINAL.has(res.body.data.status)) return res.body.data;
      if (Date.now() > deadline) {
        throw new Error(`message ${messageId} still ${res.body.data.status} after ${timeoutMs} ms`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  const attemptsOf = (messageId: string) =>
    h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, messageId));
  const queueRowOf = async (messageId: string) =>
    (
      await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, messageId))
    )[0];
  const eventTypesOf = async (messageId: string) =>
    (
      await h.admin
        .select({ type: schema.messageEvents.eventType })
        .from(schema.messageEvents)
        .where(eq(schema.messageEvents.messageId, messageId))
    ).map((e) => e.type);

  /** A queued message written directly, for states the API cannot produce. */
  async function seedQueued(tenant: TenantFixture): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      displayName: 'B1 Recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      contactId,
      channelId,
      recipientAddress: '+12025550199',
      status: 'queued',
      payload: { text: 'seeded' },
      correlationId: uuidv7(),
    });
    return messageId;
  }

  // --- the loop is wired --------------------------------------------------------

  it('the loop runs in the booted application', () => {
    expect(h.app.get(DispatchWorker).isRunning()).toBe(true);
  });

  it('a submitted message reaches its final state with no manual dispatch: accepted, one attempt, queue row gone', async () => {
    const s = await sender('dw-accept');
    await assign(s.tenant, await provider(), 1);

    const messageId = await submit(s);
    const message = await settled(s, messageId);

    expect(message.status).toBe('accepted');
    const attempts = await attemptsOf(messageId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('accepted');
    expect(await queueRowOf(messageId)).toBeUndefined();
    expect(await eventTypesOf(messageId)).toEqual(
      expect.arrayContaining(['message.queued', 'message.submitting', 'message.accepted']),
    );
  });

  it('tenant isolation holds after dispatch: another organization cannot read the message (404)', async () => {
    const a = await sender('dw-iso-a');
    const b = await sender('dw-iso-b');
    await assign(a.tenant, await provider(), 1);

    const messageId = await submit(a);
    await settled(a, messageId);

    await request(h.app.getHttpServer())
      .get(url(`/messages/${messageId}`))
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Acc-Organization', b.tenant.orgId)
      .expect(404);
  });

  // --- retry and failure --------------------------------------------------------

  it('a provider error falls back to the next provider and is accepted (attempts 1 failed, 2 accepted)', async () => {
    const s = await sender('dw-fallback');
    const failing = await provider('500');
    const healthy = await provider();
    await assign(s.tenant, failing, 1);
    await assign(s.tenant, healthy, 2);

    const messageId = await submit(s);
    const message = await settled(s, messageId);

    expect(message.status).toBe('accepted');
    const attempts = (await attemptsOf(messageId)).sort(
      (x, y) => x.attemptNumber - y.attemptNumber,
    );
    expect(attempts.map((a) => [a.providerId, a.status])).toEqual([
      [failing, 'failed'],
      [healthy, 'accepted'],
    ]);
  });

  it('when every provider fails the message fails terminally (NO_ELIGIBLE_PROVIDER) and leaves the queue', async () => {
    const s = await sender('dw-exhaust');
    await assign(s.tenant, await provider('500'), 1);

    const messageId = await submit(s);
    const message = await settled(s, messageId);

    expect(message.status).toBe('failed');
    expect(message.failureReason).toBe('NO_ELIGIBLE_PROVIDER');
    expect(await attemptsOf(messageId)).toHaveLength(1);
    expect(await queueRowOf(messageId)).toBeUndefined();
  });

  it('an ambiguous submission (timeout) ends outcome_unknown and is never retried', async () => {
    const s = await sender('dw-timeout');
    await assign(s.tenant, await provider('TIMEOUT'), 1);
    await assign(s.tenant, await provider(), 2);

    const messageId = await submit(s);
    const message = await settled(s, messageId);

    expect(message.status).toBe('outcome_unknown');
    expect(await attemptsOf(messageId)).toHaveLength(1);
  });

  // --- lease recovery -----------------------------------------------------------

  it('a claim abandoned before submission is recovered when its lease expires, then dispatched', async () => {
    const s = await sender('dw-stale-claim');
    await assign(s.tenant, await provider(), 1);
    const messageId = await seedQueued(s.tenant);
    // A worker claimed it and vanished: the lease has run out.
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: s.tenant.orgId,
      priority: 1,
      dispatchEpoch: 1,
      claimToken: randomUUID(),
      claimedUntil: new Date(Date.now() - 5_000),
    });

    const message = await settled(s, messageId);

    expect(message.status).toBe('accepted');
    expect(await attemptsOf(messageId)).toHaveLength(1);
  });

  it('a submission interrupted mid-flight is recovered as outcome_unknown, never resubmitted', async () => {
    const s = await sender('dw-crash');
    const providerId = await provider();
    await assign(s.tenant, providerId, 1);
    const messageId = await seedQueued(s.tenant);
    const claimToken = randomUUID();
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: s.tenant.orgId,
      priority: 1,
      dispatchEpoch: 1,
      claimToken,
      // Held while the attempt is written, so the loop cannot claim it first.
      claimedUntil: new Date(Date.now() + 60_000),
    });
    const attemptId = uuidv7();
    await h.admin.insert(schema.messageAttempts).values({
      id: attemptId,
      messageId,
      orgId: s.tenant.orgId,
      providerId,
      channelId,
      attemptNumber: 1,
      status: 'submitting',
      claimToken,
      fencingEpoch: 1,
    });
    await h.admin
      .update(schema.messages)
      .set({ currentAttemptId: attemptId, status: 'submitting' })
      .where(eq(schema.messages.id, messageId));
    // The worker that wrote the attempt died: its lease runs out.
    await h.admin
      .update(schema.messageDispatchQueue)
      .set({ claimedUntil: new Date(Date.now() - 5_000) })
      .where(eq(schema.messageDispatchQueue.messageId, messageId));

    const message = await settled(s, messageId);

    expect(message.status).toBe('outcome_unknown');
    const attempts = await attemptsOf(messageId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('outcome_unknown');
    expect(await queueRowOf(messageId)).toBeUndefined();
  });

  // --- concurrency --------------------------------------------------------------

  it('two instances polling one queue settle every message exactly once', async () => {
    const second = await startHarness();
    try {
      expect(second.app.get(DispatchWorker).isRunning()).toBe(true);
      const s = await sender('dw-two-instances');
      const providerId = await provider();
      await assign(s.tenant, providerId, 1);

      const ids: string[] = [];
      for (let i = 0; i < 25; i++)
        ids.push(await submit(s, `n${i}`, `+120255510${String(i).padStart(2, '0')}`));
      const finals = await Promise.all(ids.map((id) => settled(s, id, 30_000)));

      expect(finals.every((m) => m.status === 'accepted')).toBe(true);
      const attempts = await h.admin
        .select({ messageId: schema.messageAttempts.messageId })
        .from(schema.messageAttempts)
        .where(inArray(schema.messageAttempts.messageId, ids));
      expect(attempts).toHaveLength(ids.length);
      expect(new Set(attempts.map((a) => a.messageId)).size).toBe(ids.length);
      const accepted = await h.admin
        .select({ messageId: schema.messageEvents.messageId })
        .from(schema.messageEvents)
        .where(
          and(
            inArray(schema.messageEvents.messageId, ids),
            eq(schema.messageEvents.eventType, 'message.accepted'),
          ),
        );
      expect(accepted).toHaveLength(ids.length);
    } finally {
      await second.close();
    }
  }, 60_000);

  // --- graceful shutdown --------------------------------------------------------

  it('an instance closed mid-stream stops cleanly; nothing it held is lost or sent twice', async () => {
    const leaving = await startHarness();
    const worker = leaving.app.get(DispatchWorker);
    const s = await sender('dw-shutdown');
    await assign(s.tenant, await provider(), 1);

    const ids: string[] = [];
    for (let i = 0; i < 15; i++)
      ids.push(await submit(s, `s${i}`, `+120255520${String(i).padStart(2, '0')}`));
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 2));
    await leaving.close();
    expect(worker.isRunning()).toBe(false);

    // A submission abandoned mid-flight would surface as outcome_unknown (lease
    // recovery). Every message accepted means the closing instance finished what
    // it had started; the remaining instance took the rest, each exactly once.
    const finals = await Promise.all(ids.map((id) => settled(s, id, 30_000)));
    expect(finals.map((m) => m.status)).toEqual(ids.map(() => 'accepted'));
    const attempts = await h.admin
      .select({ messageId: schema.messageAttempts.messageId })
      .from(schema.messageAttempts)
      .where(inArray(schema.messageAttempts.messageId, ids));
    expect(attempts).toHaveLength(ids.length);
  }, 60_000);
});
