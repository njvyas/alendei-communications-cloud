/**
 * Gate D.3 final remediation — the Provider Router cannot bypass circuit
 * admission (`PROVIDER_ADAPTER.md` §6h).
 *
 * **Provider Router eligibility is advisory; circuit admission is
 * authoritative and mandatory immediately before provider submission.**
 *
 * No router exists yet (routing is a later phase). What a router could do is
 * exactly what any code can do: read eligibility, go through admission, and
 * call `ProviderSubmissionExecutor.execute` — the only path to an adapter's
 * `send()`. This suite drives the real application (test-send is today's only
 * submission path) and, beside it, attempts every bypass a router could try
 * against the real executor in the real container. A provider call is counted
 * at the simulator itself, so "zero submissions" means the provider was never
 * reached. Concurrency is made deterministic by parking requests on the
 * provider row lock.
 */
import { randomBytes } from 'node:crypto';

import {
  PLATFORM_ROLE_KEYS,
  PROVIDER_CIRCUIT_DEFAULTS as SEEDED,
  PROVIDER_CIRCUIT_POLICY_FIELDS,
  type ProviderSubmission,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  CircuitAdmissionRequired,
  CircuitAdmissions,
  type CircuitAdmission,
} from '../src/provider-adapters/circuit-admission';
import { SimulatorAdapter } from '../src/provider-adapters/simulator.adapter';
import { ProviderSubmissionExecutor } from '../src/provider-adapters/submission-executor';
import { routingEligibility } from '../src/providers/provider-state-machine';
import { circuitPolicyOf, circuitSnapshot } from '../src/providers/provider-views';
import {
  ManualProviderClock,
  PASSWORD,
  PREFIX,
  purgeAudit,
  purgeProviderHealth,
  startHarness,
  type Harness,
} from './auth-harness';

jest.setTimeout(60_000);

describe('Gate D.3 — the Provider Router cannot bypass circuit admission', () => {
  let h: Harness;
  let lockPool: Pool;
  const clock = new ManualProviderClock();
  let token: string;
  let userId: string;
  const createdProviders: string[] = [];
  const createdRoles: string[] = [];
  const outstanding: (() => Promise<void> | void)[] = [];
  let channelSms: string;

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => randomBytes(5).toString('hex');
  const list = (values: string[]) =>
    sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    );

  /** Every call that reached the provider (the simulator's own entry point). */
  let providerCalls: jest.SpyInstance;
  /** Every admission the circuit issued, captured as issued. */
  let issued: CircuitAdmission[];

  const send = (id: string, behavior = 'SUCCESS') =>
    request(h.app.getHttpServer())
      .post(url(`/providers/${id}/test-send`))
      .set('authorization', `Bearer ${token}`)
      .send({ behavior });

  async function plantProvider(circuit: 'closed' | 'open' | 'open_elapsed' = 'closed') {
    const open = circuit !== 'closed';
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelSms,
        name: `rc-${suffix()}`,
        adapterKey: 'simulator',
        status: 'active',
        circuitState: open ? 'open' : 'closed',
        circuitGeneration: open ? 1 : 0,
        circuitChangedAt: !open
          ? null
          : circuit === 'open'
            ? clock.now()
            : new Date(clock.now().getTime() - SEEDED.cooldownMs),
      })
      .returning({ id: schema.providers.id });
    createdProviders.push(p!.id);
    return p!.id;
  }

  const providerRow = async (id: string) =>
    (await h.admin.select().from(schema.providers).where(eq(schema.providers.id, id)))[0]!;

  /** What a router reads first: the advisory eligibility, from persisted state. */
  async function eligibilityOf(id: string) {
    const policy = (await h.admin.select().from(schema.providerCircuitPolicy))[0]!;
    const row = await providerRow(id);
    return routingEligibility(
      row.status,
      circuitSnapshot(row),
      circuitPolicyOf(policy),
      clock.now(),
    );
  }

  /** A router going straight to the provider call with `credential` in place of an admission. */
  function directCall(id: string, credential: unknown) {
    const submission: ProviderSubmission = {
      submissionId: uuidv7(),
      correlationId: uuidv7(),
      channel: 'sms',
      recipient: 'simulator:test-recipient',
      content: { text: 'router bypass attempt' },
    };
    return h.app
      .get(ProviderSubmissionExecutor)
      .execute(
        credential,
        h.app.get(SimulatorAdapter).forBehavior('SUCCESS'),
        { providerId: id, adapterKey: 'simulator', channel: 'sms', capabilities: {} },
        submission,
        3000,
      );
  }

  async function setPolicy(overrides: Partial<typeof SEEDED>) {
    const current = (await h.admin.select().from(schema.providerCircuitPolicy))[0]!;
    await h.admin
      .update(schema.providerCircuitPolicy)
      .set({ ...circuitPolicyOf(current), ...overrides, version: current.version + 1 })
      .where(eq(schema.providerCircuitPolicy.scope, 'platform'));
  }
  async function restoreSeeded() {
    const current = (await h.admin.select().from(schema.providerCircuitPolicy))[0]!;
    if (PROVIDER_CIRCUIT_POLICY_FIELDS.every((f) => current[f] === SEEDED[f])) return;
    await setPolicy(SEEDED);
  }

  /**
   * Holds every admitted submission at the executor until released, so the
   * probes the circuit admitted stay in flight together and the limit measured
   * is the concurrent one (the invariant is about probes in flight at once).
   */
  function holdAdmitted() {
    const executor = h.app.get(ProviderSubmissionExecutor);
    const original = executor.execute.bind(executor);
    const waiting: (() => void)[] = [];
    const gate = {
      held: 0,
      open: false,
      releaseAll: () => {
        gate.open = true; // from now on nothing is held
        waiting.splice(0).forEach((w) => w());
      },
    };
    outstanding.push(() => gate.releaseAll());
    jest.spyOn(executor, 'execute').mockImplementation(async (...args) => {
      // Only a genuine admission presented for its own provider is held;
      // anything else goes straight to the real executor, which must refuse it.
      const admission = args[0] as CircuitAdmission;
      if (!gate.open && issued.includes(admission) && args[2].providerId === admission.providerId) {
        gate.held++;
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return original(...args);
    });
    return gate;
  }

  async function until(condition: () => boolean, what: string) {
    const deadline = Date.now() + 20_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  async function holdProviderLock(id: string) {
    const c = await lockPool.connect();
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM providers WHERE id = $1 FOR UPDATE', [id]);
    let held = true;
    const release = async () => {
      if (!held) return;
      held = false;
      await c.query('COMMIT');
      c.release();
    };
    outstanding.push(release);
    return { release };
  }

  async function waitForLockWaiters(n: number) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await h.admin.execute<{ n: number }>(
        sql`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and state = 'active'`,
      );
      if (rows[0]!.n >= n) return;
      if (Date.now() > deadline) throw new Error(`only ${rows[0]!.n} of ${n} lock waiters`);
      await new Promise((r) => setImmediate(r));
    }
  }

  beforeAll(async () => {
    h = await startHarness({ providerClock: clock });
    await new Promise<void>((resolve) => h.app.getHttpServer().listen(0, resolve));
    lockPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
    await restoreSeeded();
    const credentials = h.app.get(CredentialService);
    const email = `rc-tester-${suffix()}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    userId = u!.id;
    const roleId = await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: null,
          key: `test_rc_${suffix()}`,
          name: 'Test router-contract role',
          isSystemRole: false,
          allowedScopeTypes: ['platform'],
        })
        .returning({ id: schema.roles.id });
      createdRoles.push(role!.id);
      const perms = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(inArray(schema.permissions.key, ['providers.read', 'providers.test_send']));
      for (const p of perms)
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: p.id });
      await tx.insert(schema.userRoles).values({
        userId: u!.id,
        roleId: role!.id,
        scopeType: 'platform',
        scopeId: null,
      });
      return role!.id;
    });
    expect(roleId).toBeTruthy();
    await h.clearRateLimits();
    token = (
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken;
    const [sms] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'sms'));
    channelSms = sms!.id;
    // Platform role check: the seeded super-admin role exists (unused here, keeps the fixture honest).
    const [superAdmin] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
          isNull(schema.roles.orgId),
        ),
      );
    expect(superAdmin).toBeDefined();
  }, 180_000);

  beforeEach(() => {
    providerCalls = jest.spyOn(
      h.app.get(SimulatorAdapter) as unknown as { simulate: () => unknown },
      'simulate',
    );
    issued = [];
    const admissions = h.app.get(CircuitAdmissions);
    const issue = admissions.issue.bind(admissions);
    jest.spyOn(admissions, 'issue').mockImplementation((...args) => {
      const admission = issue(...args);
      issued.push(admission);
      return admission;
    });
  });

  afterEach(async () => {
    for (const release of outstanding.splice(0)) await release();
    jest.restoreAllMocks();
    await restoreSeeded();
  });

  afterAll(async () => {
    try {
      await restoreSeeded();
      await h.clearRateLimits();
      if (createdProviders.length > 0) {
        await purgeAudit(h.admin, sql`resource_id IN (${list(createdProviders)})`);
        await purgeProviderHealth(h.admin, sql`provider_id IN (${list(createdProviders)})`);
        await h.admin.execute(sql`DELETE FROM providers WHERE id IN (${list(createdProviders)})`);
      }
      await purgeAudit(h.admin, sql`actor_user_id = ${userId}`);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        await tx.execute(
          sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
        try {
          await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${userId}`);
          await tx.execute(
            sql`DELETE FROM role_permissions WHERE role_id IN (${list(createdRoles)})`,
          );
          await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(createdRoles)})`);
        } finally {
          await tx.execute(
            sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
          );
        }
      });
      await h.admin.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
      await h.admin.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    } finally {
      // Always release connections, even when a cleanup step fails (for
      // example on a mutated clone), so the run ends instead of hanging.
      await lockPool.end();
      await h.close();
    }
  }, 180_000);

  // ===========================================================================
  it('OPEN → zero normal submissions: through the submission path and around it, the provider is never reached', async () => {
    const id = await plantProvider('open');
    expect(await eligibilityOf(id)).toMatchObject({ verdict: 'excluded_open' });
    const results = await Promise.all(Array.from({ length: 8 }, () => send(id)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(409));
    expect(issued).toHaveLength(0); // the circuit issued no admission
    // A router that skips admission has nothing it can present.
    for (const credential of [
      undefined,
      await eligibilityOf(id),
      { providerId: id, generation: 1, probeId: null },
    ]) {
      await expect(directCall(id, credential)).rejects.toBeInstanceOf(CircuitAdmissionRequired);
    }
    expect(providerCalls).not.toHaveBeenCalled();
  });

  it('HALF_OPEN → no more than halfOpenMaxProbes submissions, however many concurrent routing requests arrive; no admission can be spent twice', async () => {
    await setPolicy({ halfOpenMaxProbes: 2 });
    const id = await plantProvider('open_elapsed');
    const gate = holdAdmitted();
    const lock = await holdProviderLock(id);
    const settled: request.Response[] = [];
    const pending = Array.from({ length: 6 }, () =>
      send(id).then((r) => {
        settled.push(r);
        return r;
      }),
    );
    await waitForLockWaiters(6); // every routing request parked on the provider row lock
    await lock.release();
    // With the admitted probes held in flight, every other request is decided.
    await until(() => settled.length === 4, 'four refusals');
    expect(settled.map((r) => r.status)).toEqual([409, 409, 409, 409]);
    expect(issued).toHaveLength(2); // exactly the configured probes were admitted…
    expect(gate.held).toBe(2); // …exactly they reached the provider call…
    gate.releaseAll();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(providerCalls).toHaveBeenCalledTimes(2); // …and the provider saw exactly two
    // Re-presenting a spent probe admission, concurrently, sends nothing more.
    const replays = await Promise.allSettled(
      issued.flatMap((a) => [directCall(id, a), directCall(id, a)]),
    );
    expect(
      replays.every((r) => r.status === 'rejected' && r.reason instanceof CircuitAdmissionRequired),
    ).toBe(true);
    expect(providerCalls).toHaveBeenCalledTimes(2);
  });

  it('CLOSED → submissions are permitted, each through exactly one admission', async () => {
    const id = await plantProvider('closed');
    expect(await eligibilityOf(id)).toEqual({ verdict: 'eligible' });
    for (let i = 0; i < 3; i++) await send(id).expect(200);
    expect(issued).toHaveLength(3);
    expect(providerCalls).toHaveBeenCalledTimes(3);
  });

  it('the eligibility read alone cannot authorize a submission — even when it says eligible', async () => {
    const id = await plantProvider('closed');
    const verdict = await eligibilityOf(id);
    expect(verdict).toEqual({ verdict: 'eligible' });
    await expect(directCall(id, verdict)).rejects.toThrow(CircuitAdmissionRequired);
    const half = await plantProvider('open_elapsed');
    const probeOnly = await eligibilityOf(half);
    expect(probeOnly).toMatchObject({ verdict: 'probe_only' });
    await expect(directCall(half, probeOnly)).rejects.toThrow(CircuitAdmissionRequired);
    expect(providerCalls).not.toHaveBeenCalled();
    // Reading eligibility claimed nothing: the probe slot is still free for a real admission.
    expect((await providerRow(half)).circuitProbes).toEqual([]);
  });

  it('the admission step is mandatory before the provider call: a missing, copied, foreign or spent admission never reaches the provider', async () => {
    const a = await plantProvider('closed');
    const b = await plantProvider('closed');
    await send(a).expect(200);
    const spent = issued[0]!;
    expect(spent.providerId).toBe(a);
    const attempts: [string, unknown, string][] = [
      ['missing', undefined, b],
      ['copied fields', { ...spent }, a],
      ['serialized', JSON.parse(JSON.stringify(spent)), a],
      ['spent', spent, a],
      ['foreign provider', spent, b],
    ];
    for (const [what, credential, target] of attempts) {
      const outcome = await directCall(target, credential).then(
        () => 'sent',
        (e: unknown) => (e instanceof CircuitAdmissionRequired ? 'refused' : String(e)),
      );
      expect(`${what} → ${outcome}`).toBe(`${what} → refused`);
    }
    expect(providerCalls).toHaveBeenCalledTimes(1); // only the admitted test-send

    // A genuine, unspent admission for A — its submission held in flight —
    // presented for B is refused for B, and still redeems for A afterwards.
    const gate = holdAdmitted();
    const inFlight = send(a).then((r) => r);
    await until(() => gate.held === 1, 'an admitted submission to A');
    const unspent = issued.at(-1)!;
    expect(unspent.providerId).toBe(a);
    await expect(directCall(b, unspent)).rejects.toThrow(
      'admission was issued for another provider',
    );
    gate.releaseAll();
    expect((await inFlight).status).toBe(200);
    expect(providerCalls).toHaveBeenCalledTimes(2);
  });

  it('concurrent routing requests that skip admission cannot ride along with admitted ones', async () => {
    await setPolicy({ halfOpenMaxProbes: 1 });
    const id = await plantProvider('open_elapsed');
    const gate = holdAdmitted();
    const lock = await holdProviderLock(id);
    const settled: request.Response[] = [];
    const admitted = Array.from({ length: 3 }, () =>
      send(id).then((r) => {
        settled.push(r);
        return r;
      }),
    );
    await waitForLockWaiters(3);
    const bypasses = Array.from({ length: 5 }, () =>
      directCall(id, { providerId: id, generation: 2, probeId: null }).then(
        () => 'sent',
        () => 'refused',
      ),
    );
    await lock.release();
    await until(() => settled.length === 2, 'two refusals');
    expect(gate.held).toBe(1);
    gate.releaseAll();
    const [results, bypassed] = await Promise.all([Promise.all(admitted), Promise.all(bypasses)]);
    expect(bypassed).toEqual(Array(5).fill('refused'));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(providerCalls).toHaveBeenCalledTimes(1);
  });
});
