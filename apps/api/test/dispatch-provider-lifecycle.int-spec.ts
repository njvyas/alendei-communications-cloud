/**
 * Issue #20: a provider that is not `active` (disabled or draining) is an
 * eligibility outcome, not a dispatcher fault.
 *
 * `ProviderStateStore.admit` refuses such a provider with
 * PROVIDER_LIFECYCLE_CONFLICT before the circuit is consulted. The dispatcher
 * logs that at warn and tries the next candidate; only an unexpected admission
 * error is logged at error. When no candidate is admitted the message still
 * fails NO_ELIGIBLE_PROVIDER, with event details derived from what the
 * candidates actually did.
 *
 * Deterministic: the worker loop is off for this suite (`setup-env.ts`); each
 * case queues one message and calls `claimBatch` + `processClaim` directly.
 * Simulator providers only; no network. Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
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

const LIFECYCLE_ONLY = 'No assigned provider is active (disabled or draining)';
const CIRCUIT_ONLY = 'All assigned provider circuits refused admission';
const MIXED =
  'No assigned provider was admitted: some are not active (disabled or draining), the others were refused admission';
const LIFECYCLE_WARN = 'Provider is not active (disabled or draining); trying next candidate';
const CIRCUIT_WARN = 'Provider circuit refused admission; trying next candidate';
const ADMISSION_ERROR = 'Error checking circuit admission for provider';

type ProviderShape =
  | { status: 'active' | 'disabled' | 'draining' }
  | { status: 'active'; circuit: 'open' }
  | { status: 'active'; adapterKey: string };

describe('Issue #20: dispatcher provider lifecycle diagnostics', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  let channelId: string;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  let warned: jest.SpyInstance;
  let errored: jest.SpyInstance;
  let admitSpy: jest.SpyInstance;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    const [channel] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = channel!.id;
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
    const logger = (dispatcher as unknown as { logger: Record<string, (m: unknown) => void> })
      .logger;
    warned = jest.spyOn(logger, 'warn');
    errored = jest.spyOn(logger, 'error');
    admitSpy = jest.spyOn(ProviderStateStore.prototype, 'admit');
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
          .delete(schema.contacts)
          .where(inArray(schema.contacts.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(inArray(schema.organizationProviderAssignments.orgId, orgIds))
          .catch(() => {});
      }
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
      for (const t of tenants) await destroyTenant(h.admin, t).catch(() => {});
    } finally {
      await h.close();
    }
  });

  // --- fixtures ---------------------------------------------------------------

  async function tenant(label: string): Promise<TenantFixture> {
    const t = await createTenant(h.admin, label, credentials);
    tenants.push(t);
    return t;
  }

  /** A simulator provider of the given shape, assigned (active) to `t` at `priority`. */
  async function assignedProvider(
    t: TenantFixture,
    priority: number,
    shape: ProviderShape,
  ): Promise<string> {
    const slug = `i20-${randomBytes(4).toString('hex')}`;
    const open = 'circuit' in shape;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `Issue 20 ${slug}`,
        slug,
        adapterKey: 'adapterKey' in shape ? shape.adapterKey : 'simulator',
        status: shape.status,
        healthState: 'healthy',
        circuitState: open ? 'open' : 'closed',
        // Just opened: well inside the platform policy's cooldown.
        circuitChangedAt: open ? new Date() : null,
        circuitGeneration: open ? 1 : 0,
      })
      .returning();
    providers.push(p!.id);
    await h.admin.insert(schema.providerCapabilities).values({
      providerId: p!.id,
      capabilityKey: 'simulator_behavior',
      value: 'SUCCESS',
    });
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: t.orgId,
      channelId,
      providerId: p!.id,
      priority,
      status: 'active',
    });
    return p!.id;
  }

  async function queuedMessage(t: TenantFixture): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      displayName: 'Issue 20 recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      contactId,
      channelId,
      recipientAddress: `+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      status: 'queued',
      payload: { text: 'Issue 20' },
      correlationId: uuidv7(),
    });
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: t.orgId,
      priority: 1,
      dispatchEpoch: 1,
    });
    return messageId;
  }

  async function claimAndProcess(messageId: string) {
    const claims = await dispatcher.claimBatch(10);
    expect(claims.map((c) => c.messageId)).toEqual([messageId]);
    return dispatcher.processClaim(claims[0]!);
  }

  async function messageRow(id: string) {
    const [m] = await h.admin.select().from(schema.messages).where(eq(schema.messages.id, id));
    return m!;
  }

  async function attemptsOf(id: string) {
    return h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, id));
  }

  async function failedEventPayload(id: string) {
    const events = await h.admin
      .select({ type: schema.messageEvents.eventType, payload: schema.messageEvents.payload })
      .from(schema.messageEvents)
      .where(eq(schema.messageEvents.messageId, id));
    const failed = events.filter((e) => e.type === 'message.failed');
    expect(failed).toHaveLength(1);
    return failed[0]!.payload as Record<string, unknown>;
  }

  /** The dispatcher's log entries with message `msg`, from `spy`. */
  function entries(spy: jest.SpyInstance, msg: string): Record<string, unknown>[] {
    return spy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => typeof e === 'object' && e !== null && e.msg === msg);
  }

  async function expectNoEligibleProvider(messageId: string, details: string) {
    const m = await messageRow(messageId);
    expect(m.status).toBe('failed');
    expect(m.failureReason).toBe('NO_ELIGIBLE_PROVIDER');
    expect(await attemptsOf(messageId)).toHaveLength(0);
    expect(await failedEventPayload(messageId)).toEqual({
      reason: 'NO_ELIGIBLE_PROVIDER',
      details,
    });
  }

  // --- cases ------------------------------------------------------------------

  it('1. falls back past a disabled provider to the next active one, warning (not erroring)', async () => {
    const t = await tenant('i20-fallback');
    const disabled = await assignedProvider(t, 1, { status: 'disabled' });
    const active = await assignedProvider(t, 2, { status: 'active' });
    const messageId = await queuedMessage(t);

    const result = await claimAndProcess(messageId);

    expect(result.outcome).not.toBe('circuit_refused');
    expect(result.error).toBeUndefined();
    const attempts = await attemptsOf(messageId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.providerId).toBe(active);
    expect(entries(warned, LIFECYCLE_WARN)).toEqual([
      {
        msg: LIFECYCLE_WARN,
        providerId: disabled,
        status: 'disabled',
        messageId,
        orgId: t.orgId,
      },
    ]);
    expect(errored).not.toHaveBeenCalled();
    expect(admitSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), disabled);
    expect(admitSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), active);
  });

  it('2. fails NO_ELIGIBLE_PROVIDER with no attempt when the only provider is disabled', async () => {
    const t = await tenant('i20-disabled');
    const disabled = await assignedProvider(t, 1, { status: 'disabled' });
    const messageId = await queuedMessage(t);

    await expect(claimAndProcess(messageId)).resolves.toEqual({
      messageId,
      outcome: 'circuit_refused',
      error: 'NO_ELIGIBLE_PROVIDER',
    });

    await expectNoEligibleProvider(messageId, LIFECYCLE_ONLY);
    expect(entries(warned, LIFECYCLE_WARN)).toEqual([
      {
        msg: LIFECYCLE_WARN,
        providerId: disabled,
        status: 'disabled',
        messageId,
        orgId: t.orgId,
      },
    ]);
    expect(errored).not.toHaveBeenCalled();
    expect(admitSpy).not.toHaveBeenCalled();
  });

  it('3. treats a draining provider the same way', async () => {
    const t = await tenant('i20-draining');
    const draining = await assignedProvider(t, 1, { status: 'draining' });
    const messageId = await queuedMessage(t);

    await expect(claimAndProcess(messageId)).resolves.toMatchObject({
      outcome: 'circuit_refused',
      error: 'NO_ELIGIBLE_PROVIDER',
    });

    await expectNoEligibleProvider(messageId, LIFECYCLE_ONLY);
    expect(entries(warned, LIFECYCLE_WARN)).toEqual([
      {
        msg: LIFECYCLE_WARN,
        providerId: draining,
        status: 'draining',
        messageId,
        orgId: t.orgId,
      },
    ]);
    expect(errored).not.toHaveBeenCalled();
    expect(admitSpy).not.toHaveBeenCalled();
  });

  it('4. keeps the existing details when every circuit refuses admission', async () => {
    const t = await tenant('i20-circuit');
    const open = await assignedProvider(t, 1, { status: 'active', circuit: 'open' });
    const messageId = await queuedMessage(t);

    await expect(claimAndProcess(messageId)).resolves.toMatchObject({
      outcome: 'circuit_refused',
      error: 'NO_ELIGIBLE_PROVIDER',
    });

    await expectNoEligibleProvider(messageId, CIRCUIT_ONLY);
    expect(entries(warned, CIRCUIT_WARN)).toEqual([
      { msg: CIRCUIT_WARN, providerId: open, state: 'open', messageId, orgId: t.orgId },
    ]);
    expect(entries(warned, LIFECYCLE_WARN)).toHaveLength(0);
    expect(errored).not.toHaveBeenCalled();
    expect(admitSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), open);
  });

  it('5. combines the explanation when lifecycle and circuit refusals are mixed', async () => {
    const t = await tenant('i20-mixed');
    const disabled = await assignedProvider(t, 1, { status: 'disabled' });
    const open = await assignedProvider(t, 2, { status: 'active', circuit: 'open' });
    const messageId = await queuedMessage(t);

    await expect(claimAndProcess(messageId)).resolves.toMatchObject({
      outcome: 'circuit_refused',
      error: 'NO_ELIGIBLE_PROVIDER',
    });

    await expectNoEligibleProvider(messageId, MIXED);
    expect(entries(warned, LIFECYCLE_WARN)).toEqual([
      {
        msg: LIFECYCLE_WARN,
        providerId: disabled,
        status: 'disabled',
        messageId,
        orgId: t.orgId,
      },
    ]);
    expect(entries(warned, CIRCUIT_WARN)).toEqual([
      { msg: CIRCUIT_WARN, providerId: open, state: 'open', messageId, orgId: t.orgId },
    ]);
    expect(errored).not.toHaveBeenCalled();
    expect(admitSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), disabled);
    expect(admitSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), open);
  });

  it('6. logs an unexpected admission error at error level, in the safe structured form', async () => {
    const t = await tenant('i20-error');
    const unregistered = await assignedProvider(t, 1, {
      status: 'active',
      adapterKey: 'unregistered_adapter',
    });
    const messageId = await queuedMessage(t);

    await expect(claimAndProcess(messageId)).resolves.toMatchObject({
      outcome: 'circuit_refused',
      error: 'NO_ELIGIBLE_PROVIDER',
    });

    await expectNoEligibleProvider(messageId, CIRCUIT_ONLY);
    const logged = entries(errored, ADMISSION_ERROR);
    expect(logged).toEqual([
      {
        msg: ADMISSION_ERROR,
        error: "The provider's adapter is not registered",
        providerId: unregistered,
        messageId,
        orgId: t.orgId,
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain('unregistered_adapter');
    expect(entries(warned, LIFECYCLE_WARN)).toHaveLength(0);
  });

  it('7. leaves the no-assignment path unchanged', async () => {
    const t = await tenant('i20-empty');
    const messageId = await queuedMessage(t);

    await expect(claimAndProcess(messageId)).resolves.toEqual({
      messageId,
      outcome: 'failed',
      error: 'No active provider assignment for channel',
    });

    const m = await messageRow(messageId);
    expect(m.status).toBe('failed');
    expect(m.failureReason).toBe('No active provider assignment for channel');
    expect(await attemptsOf(messageId)).toHaveLength(0);
    expect(await failedEventPayload(messageId)).toEqual({
      reason: 'No active provider assignment for channel',
      attempts: 0,
    });
    expect(entries(warned, LIFECYCLE_WARN)).toHaveLength(0);
    expect(errored).not.toHaveBeenCalled();
    expect(admitSpy).not.toHaveBeenCalled();
  });
});
