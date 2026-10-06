/**
 * Connection-pool isolation of authentication and authorization refusals
 * (ADR-015 R-1, R-12; pre-Phase-3 audit HIGH-1).
 *
 * Before R-1, sign-in and API-key authentication ran Argon2 while holding an
 * `acc_auth` connection, so a burst of attempts — unknown addresses included,
 * no credential needed — pinned the whole identity pool and stalled every
 * authenticated request behind it. A refused authorization wrote its record on
 * a *second* `acc_app` connection while the caller still held one, so enough
 * concurrent denials deadlocked the application pool. Both are pinned here
 * deterministically: a test-only gate parks callers exactly where the old code
 * held a connection, and the suite observes the pools while they wait. No
 * assertion depends on timing luck — the time bounds only distinguish "never
 * waited for a connection" from the five-second acquisition timeout.
 *
 * The pools are small on purpose (`DATABASE_POOL_MAX=4`: `acc_app` 4,
 * `acc_auth` 2, set by `pool-isolation.env.ts` before the application module
 * loads), so each burst is larger than the pool it would have pinned.
 */
// First, before anything that imports `AppModule`: it sets the pool size.
import { AUTH_POOL_MAX, POOL_MAX, PREVIOUS_DATABASE_POOL_MAX } from './pool-isolation.env';

import { randomBytes } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import { AUDIT_ACTIONS, ERROR_CODES } from '@acc/contracts';
import { NestedPoolAcquisitionError, schema, type Database } from '@acc/db';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AuditWriter } from '../src/audit/audit-writer.service';
import { AppConfigService } from '../src/config/app-config.service';
import { APP_DB, APP_POOL, AUTH_DB, AUTH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import {
  ArrivalGate,
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  destroyUser,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (path: string) => `/${PREFIX}${path}`;

interface Outcome {
  readonly status: number;
  readonly body: { error?: { code: string; message: string; retryable: boolean } };
  readonly correlationId: string;
}

jest.setTimeout(30_000);

describe('pool isolation of authentication and authorization refusals (ADR-015 R-1, R-12)', () => {
  const credentialGate = new ArrivalGate();
  const scopeChainGate = new ArrivalGate();

  let h: Harness;
  let authPool: Pool;
  let appPool: Pool;
  let credentials: CredentialService;
  let orgA: TenantFixture;
  let raceUser: { userId: string; email: string };
  let workspaceUser: { userId: string; email: string };
  const extraUsers: string[] = [];

  beforeAll(async () => {
    h = await startHarness({ credentialGate, scopeChainGate });
    authPool = h.app.get<Pool>(AUTH_POOL);
    appPool = h.app.get<Pool>(APP_POOL);
    // Every burst below is sized against these; a pool that silently kept the
    // `.env` size would make them prove nothing.
    expect(appPool.options.max).toBe(POOL_MAX);
    expect(authPool.options.max).toBe(AUTH_POOL_MAX);
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'pool-a', credentials);
    raceUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'organization',
      orgA.orgId,
      'pool-race',
    );
    workspaceUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'pool-ws',
    );
  }, 60_000);

  afterAll(async () => {
    credentialGate.open();
    scopeChainGate.open();
    for (const id of [raceUser.userId, workspaceUser.userId, ...extraUsers]) {
      await destroyUser(h.admin, id);
    }
    await destroyTenant(h.admin, orgA);
    await h.close();
    if (PREVIOUS_DATABASE_POOL_MAX === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = PREVIOUS_DATABASE_POOL_MAX;
  }, 60_000);

  beforeEach(() => h.clearRateLimits());
  afterEach(async () => {
    credentialGate.open();
    scopeChainGate.open();
    jest.restoreAllMocks();
    await purgeAudit(h.admin, sql`true`);
  });

  // --- helpers ----------------------------------------------------------------

  /** Starts a request now (supertest is lazy) and settles to its outcome. */
  const send = (test: request.Test): Promise<Outcome> => {
    const correlationId = uuidv7();
    return test
      .set('x-correlation-id', correlationId)
      .then((res) => ({ status: res.status, body: res.body as Outcome['body'], correlationId }));
  };

  const login = (email: string, password = PASSWORD) =>
    send(request(h.app.getHttpServer()).post(url('/auth/login')).send({ email, password }));

  const get = (path: string, bearer: string) =>
    send(request(h.app.getHttpServer()).get(url(path)).set('authorization', `Bearer ${bearer}`));

  const tokenFor = async (email: string): Promise<string> => {
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  };

  const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount;

  const rowsFor = async (action: string, correlationIds: readonly string[]) => {
    const { rows } = await h.admin.execute<{
      correlation_id: string;
      actor_type: string;
      actor_user_id: string | null;
      actor_label: string | null;
      metadata: Record<string, unknown>;
    }>(
      sql`SELECT correlation_id::text, actor_type, actor_user_id, actor_label, metadata
            FROM audit_logs
           WHERE action = ${action}
             AND correlation_id::text IN (${sql.join(
               correlationIds.map((id) => sql`${id}`),
               sql`, `,
             )})`,
    );
    return rows;
  };

  /** Sessions of a user — live or not — created since `since`. */
  const sessionsSince = async (userId: string, since: Date) => {
    const { rows } = await h.admin.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId} AND created_at >= ${since.toISOString()}`,
    );
    return rows[0]!.n;
  };

  /** What a refusal says, without the per-request correlation id. */
  const shape = (o: Outcome) => ({
    status: o.status,
    code: o.body.error?.code,
    message: o.body.error?.message,
    retryable: o.body.error?.retryable,
  });

  // ---------------------------------------------------------------------------
  describe('1. sign-in bursts never pin the identity pool', () => {
    const N = AUTH_POOL_MAX * 2 + 1;

    const burst = async (attempts: (() => Promise<Outcome>)[]) => {
      const meToken = await tokenFor(orgA.email);
      await h.clearRateLimits();

      credentialGate.close();
      const pending = attempts.map((attempt) => attempt());
      await credentialGate.untilArrived(attempts.length);

      // Every attempt is inside step V, and none of them holds or awaits an
      // identity connection — the pool is free for everyone else.
      expect(checkedOut(authPool)).toBe(0);
      expect(authPool.waitingCount).toBe(0);
      const meStarted = Date.now();
      const me = await get('/auth/me', meToken);
      expect(me.status).toBe(200);
      expect(Date.now() - meStarted).toBeLessThan(1_000);

      const released = Date.now();
      credentialGate.open();
      const outcomes = await Promise.all(pending);
      const elapsed = Date.now() - released;
      return { outcomes, elapsed };
    };

    const expectUniformRefusals = async (outcomes: Outcome[], elapsed: number) => {
      expect(outcomes.filter((o) => o.status >= 500)).toEqual([]);
      for (const o of outcomes) {
        expect(shape(o)).toEqual(shape(outcomes[0]!));
      }
      expect(outcomes[0]!.status).toBe(401);
      expect(outcomes[0]!.body.error?.code).toBe(ERROR_CODES.AUTH_INVALID_CREDENTIALS);
      // Far below the 5 s acquisition timeout a queued connection would hit.
      expect(elapsed).toBeLessThan(2_000);
      const rows = await rowsFor(
        AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcomes.map((o) => o.correlationId),
      );
      expect(rows).toHaveLength(outcomes.length);
      expect(new Set(rows.map((r) => r.correlation_id)).size).toBe(outcomes.length);
    };

    it('unknown addresses', async () => {
      const { outcomes, elapsed } = await burst(
        Array.from({ length: N }, () => () => login(`nobody-${uuidv7()}@example.test`)),
      );
      await expectUniformRefusals(outcomes, elapsed);
      const rows = await rowsFor(
        AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcomes.map((o) => o.correlationId),
      );
      expect(rows.every((r) => r.actor_user_id === null && r.actor_type === 'system')).toBe(true);
      expect(rows.every((r) => r.metadata['reason'] === 'unknown_identity')).toBe(true);
    });

    it('wrong passwords', async () => {
      const { outcomes, elapsed } = await burst(
        Array.from({ length: N }, () => () => login(raceUser.email, 'not-the-password')),
      );
      await expectUniformRefusals(outcomes, elapsed);
      const rows = await rowsFor(
        AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcomes.map((o) => o.correlationId),
      );
      expect(rows.every((r) => r.actor_user_id === raceUser.userId)).toBe(true);
      expect(rows.every((r) => r.metadata['reason'] === 'invalid_password')).toBe(true);
    });

    it('a mixed burst: unknown, wrong password and a disabled account', async () => {
      const disabled = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'organization',
        orgA.orgId,
        'pool-off',
      );
      extraUsers.push(disabled.userId);
      await h.admin.execute(
        sql`UPDATE users SET status = 'disabled' WHERE id = ${disabled.userId}`,
      );

      const { outcomes, elapsed } = await burst([
        () => login(`nobody-${uuidv7()}@example.test`),
        () => login(raceUser.email, 'not-the-password'),
        () => login(disabled.email),
        () => login(`nobody-${uuidv7()}@example.test`),
        () => login(disabled.email, 'not-the-password'),
      ]);
      await expectUniformRefusals(outcomes, elapsed);
      const reasons = (
        await rowsFor(
          AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
          outcomes.map((o) => o.correlationId),
        )
      )
        .map((r) => String(r.metadata['reason']))
        .sort();
      expect(reasons).toEqual([
        'account_not_active',
        'invalid_password',
        'invalid_password',
        'unknown_identity',
        'unknown_identity',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('2. enumeration parity in identity-pool checkouts', () => {
    it('unknown, wrong-password and not-active attempts take the same number of checkouts', async () => {
      const inactive = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'organization',
        orgA.orgId,
        'pool-inactive',
      );
      extraUsers.push(inactive.userId);
      await h.admin.execute(
        sql`UPDATE users SET status = 'disabled' WHERE id = ${inactive.userId}`,
      );

      const checkouts = async (attempt: () => Promise<Outcome>) => {
        let n = 0;
        const count = () => {
          n += 1;
        };
        authPool.on('acquire', count);
        try {
          const outcome = await attempt();
          expect(outcome.status).toBe(401);
        } finally {
          authPool.off('acquire', count);
        }
        return n;
      };

      const unknown = await checkouts(() => login(`nobody-${uuidv7()}@example.test`));
      const wrong = await checkouts(() => login(raceUser.email, 'not-the-password'));
      const notActive = await checkouts(() => login(inactive.email));

      // R and F — one read, one failure record — and nothing else.
      expect({ unknown, wrong, notActive }).toEqual({ unknown: 2, wrong: 2, notActive: 2 });
    });
  });

  // ---------------------------------------------------------------------------
  describe('3. state changing between the read and the success transaction', () => {
    /** A correct sign-in for `raceUser`, parked in step V (wrapped: not awaited). */
    const parkedLogin = async () => {
      credentialGate.close();
      const pending = login(raceUser.email);
      await credentialGate.untilArrived(1);
      return { pending };
    };

    it('a disable committing during verification refuses the sign-in', async () => {
      const since = new Date(Date.now() - 1_000);
      const { pending } = await parkedLogin();
      await h.admin.execute(
        sql`UPDATE users SET status = 'disabled' WHERE id = ${raceUser.userId}`,
      );
      try {
        credentialGate.open();
        const outcome = await pending;
        expect(outcome.status).toBe(401);
        expect(outcome.body.error?.code).toBe(ERROR_CODES.AUTH_INVALID_CREDENTIALS);
        expect(await sessionsSince(raceUser.userId, since)).toBe(0);
        const rows = await rowsFor(AUDIT_ACTIONS.AUTH_LOGIN_FAILED, [outcome.correlationId]);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.actor_user_id).toBe(raceUser.userId);
        expect(rows[0]!.metadata['reason']).toBe('account_not_active');
        expect(await rowsFor(AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED, [outcome.correlationId])).toEqual(
          [],
        );
      } finally {
        await h.admin.execute(
          sql`UPDATE users SET status = 'active' WHERE id = ${raceUser.userId}`,
        );
      }
    });

    it('a password change committing during verification refuses the sign-in', async () => {
      const since = new Date(Date.now() - 1_000);
      const { rows: original } = await h.admin.execute<{ password_hash: string }>(
        sql`SELECT password_hash FROM users WHERE id = ${raceUser.userId}`,
      );
      const { pending } = await parkedLogin();
      const replaced = await credentials.hash('a-different-long-passphrase');
      await h.admin.execute(
        sql`UPDATE users SET password_hash = ${replaced} WHERE id = ${raceUser.userId}`,
      );
      try {
        credentialGate.open();
        const outcome = await pending;
        expect(outcome.status).toBe(401);
        expect(await sessionsSince(raceUser.userId, since)).toBe(0);
        const rows = await rowsFor(AUDIT_ACTIONS.AUTH_LOGIN_FAILED, [outcome.correlationId]);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.actor_user_id).toBe(raceUser.userId);
        expect(rows[0]!.metadata['reason']).toBe('invalid_password');
        // The concurrent change stands; the refused sign-in wrote nothing over it.
        const { rows: after } = await h.admin.execute<{ password_hash: string }>(
          sql`SELECT password_hash FROM users WHERE id = ${raceUser.userId}`,
        );
        expect(after[0]!.password_hash).toBe(replaced);
      } finally {
        await h.admin.execute(
          sql`UPDATE users SET password_hash = ${original[0]!.password_hash} WHERE id = ${raceUser.userId}`,
        );
      }
    });

    it('an undisturbed parked sign-in still succeeds', async () => {
      const { pending } = await parkedLogin();
      credentialGate.open();
      const outcome = await pending;
      expect(outcome.status).toBe(200);
      expect(
        await rowsFor(AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED, [outcome.correlationId]),
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('4. re-hash on sign-in', () => {
    it('upgrades a digest produced with weaker parameters, in the success transaction', async () => {
      const weak = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'organization',
        orgA.orgId,
        'pool-weak',
      );
      extraUsers.push(weak.userId);
      const { argon2 } = h.app.get(AppConfigService).auth;
      const weakDigest = await argon2Hash(PASSWORD, {
        memoryCost: 8_192,
        timeCost: argon2.timeCost,
        parallelism: argon2.parallelism,
      });
      expect(argon2.memoryCost).toBeGreaterThan(8_192);
      const updatedBefore = new Date(Date.now() - 60_000);
      await h.admin.execute(
        sql`UPDATE users SET password_hash = ${weakDigest}, password_updated_at = ${updatedBefore.toISOString()} WHERE id = ${weak.userId}`,
      );
      expect(credentials.needsRehash(weakDigest)).toBe(true);

      const outcome = await login(weak.email);
      expect(outcome.status).toBe(200);

      const { rows } = await h.admin.execute<{
        password_hash: string;
        password_updated_at: Date;
        last_login_at: Date | null;
      }>(
        sql`SELECT password_hash, password_updated_at, last_login_at FROM users WHERE id = ${weak.userId}`,
      );
      const row = rows[0]!;
      expect(row.password_hash).not.toBe(weakDigest);
      expect(row.password_hash).toContain(`$m=${argon2.memoryCost},`);
      expect(credentials.needsRehash(row.password_hash)).toBe(false);
      expect(await credentials.verify(row.password_hash, PASSWORD)).toBe(true);
      expect(new Date(row.password_updated_at).getTime()).toBeGreaterThan(updatedBefore.getTime());
      expect(row.last_login_at).not.toBeNull();
      // And the upgraded credential signs in.
      expect((await login(weak.email)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('5. API-key authentication never pins the identity pool', () => {
    const issueKey = async (): Promise<{ id: string; credential: string }> => {
      const secret = `secret-${uuidv7()}`;
      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      const [row] = await h.admin
        .insert(schema.apiKeys)
        .values({
          orgId: orgA.orgId,
          name: `key-${prefix}`,
          keyPrefix: prefix,
          keyHash: await credentials.hash(secret),
          createdBy: orgA.userId,
          scopes: ['workspaces.read'],
        })
        .returning({ id: schema.apiKeys.id });
      return { id: row!.id, credential: `${prefix}.${secret}` };
    };

    const lastUsed = async (id: string) => {
      const { rows } = await h.admin.execute<{ last_used_at: string | null }>(
        sql`SELECT last_used_at::text FROM api_keys WHERE id = ${id}`,
      );
      return rows[0]!.last_used_at;
    };

    it('a burst of garbage and valid keys verifies with no identity connection held', async () => {
      const key = await issueKey();
      const garbage = () => `ak_test_${randomBytes(8).toString('hex')}.not-a-secret`;

      credentialGate.close();
      const pending = [
        get('/tenants/workspaces', garbage()),
        get('/tenants/workspaces', key.credential),
        get('/tenants/workspaces', garbage()),
        get('/tenants/workspaces', key.credential),
        get('/tenants/workspaces', garbage()),
      ];
      await credentialGate.untilArrived(pending.length);
      expect(checkedOut(authPool)).toBe(0);
      expect(authPool.waitingCount).toBe(0);

      const released = Date.now();
      credentialGate.open();
      const outcomes = await Promise.all(pending);
      expect(Date.now() - released).toBeLessThan(2_000);
      expect(outcomes.map((o) => o.status)).toEqual([401, 200, 401, 200, 401]);
      expect(outcomes[0]!.body.error?.code).toBe(ERROR_CODES.AUTH_API_KEY_INVALID);
    });

    it('a revocation committing during verification refuses the key and records no use', async () => {
      const key = await issueKey();
      const before = await lastUsed(key.id);

      credentialGate.close();
      const pending = get('/tenants/workspaces', key.credential);
      await credentialGate.untilArrived(1);
      await h.admin.execute(sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${key.id}`);
      credentialGate.open();

      const outcome = await pending;
      expect(outcome.status).toBe(401);
      expect(outcome.body.error?.code).toBe(ERROR_CODES.AUTH_API_KEY_INVALID);
      expect(await lastUsed(key.id)).toBe(before);
      expect(await rowsFor(AUDIT_ACTIONS.API_KEY_AUTHENTICATED, [outcome.correlationId])).toEqual(
        [],
      );
    });

    it('an expiry passing during verification refuses the key', async () => {
      const key = await issueKey();
      credentialGate.close();
      const pending = get('/tenants/workspaces', key.credential);
      await credentialGate.untilArrived(1);
      await h.admin.execute(
        sql`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = ${key.id}`,
      );
      credentialGate.open();
      expect((await pending).status).toBe(401);
      expect(await lastUsed(key.id)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('6. concurrent denials never deadlock the application pool', () => {
    const appPoolMax = POOL_MAX;

    it('every denied request is a recorded 403 while the pool is saturated, and an authorized one still succeeds', async () => {
      const deniedToken = await tokenFor(workspaceUser.email);
      const allowedToken = await tokenFor(orgA.email);

      scopeChainGate.close();
      // Organization-level read for a principal whose only grant is one
      // workspace: resolved, visible, and refused inside the request's own
      // tenant transaction.
      const denied = Array.from({ length: appPoolMax + 1 }, () =>
        get('/tenants/workspaces', deniedToken),
      );
      // Every application connection is now held by a request parked inside
      // its transaction, at the authorization check; the last one waits.
      await scopeChainGate.untilArrived(appPoolMax);
      expect(checkedOut(appPool)).toBe(appPoolMax);

      const released = Date.now();
      scopeChainGate.open();
      const allowed = get('/tenants/workspaces', allowedToken);
      const outcomes = await Promise.all(denied);
      const elapsed = Date.now() - released;

      expect(outcomes.map((o) => o.status)).toEqual(Array(appPoolMax + 1).fill(403));
      for (const o of outcomes) expect(o.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      expect(elapsed).toBeLessThan(2_000);
      expect((await allowed).status).toBe(200);

      const rows = await rowsFor(
        AUDIT_ACTIONS.AUTHORIZATION_DENIED,
        outcomes.map((o) => o.correlationId),
      );
      expect(rows).toHaveLength(appPoolMax + 1);
      expect(new Set(rows.map((r) => r.correlation_id)).size).toBe(appPoolMax + 1);
      expect(rows.every((r) => r.actor_user_id === workspaceUser.userId)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('7. denial durability and failing closed', () => {
    it('the record is committed by the time the 403 arrives, though the request transaction rolled back', async () => {
      const token = await tokenFor(workspaceUser.email);
      const outcome = await get('/tenants/workspaces', token);
      expect(outcome.status).toBe(403);
      expect(outcome.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      // Read immediately, with no retry: it is already there.
      const rows = await rowsFor(AUDIT_ACTIONS.AUTHORIZATION_DENIED, [outcome.correlationId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata['permission']).toBe('workspaces.read');
    });

    it('a denial whose record cannot be written is a 500, never a plain 403', async () => {
      const token = await tokenFor(workspaceUser.email);
      const writer = h.app.get(AuditWriter);
      const real = writer.record.bind(writer);
      jest
        .spyOn(writer, 'record')
        .mockImplementation((input, tx) =>
          input.action === AUDIT_ACTIONS.AUTHORIZATION_DENIED
            ? Promise.reject(new Error('audit unavailable'))
            : real(input, tx),
        );

      const outcome = await get('/tenants/workspaces', token);
      expect(outcome.status).toBe(500);
      expect(outcome.body.error?.code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(await rowsFor(AUDIT_ACTIONS.AUTHORIZATION_DENIED, [outcome.correlationId])).toEqual(
        [],
      );
    });

    it('a sign-in failure whose record cannot be written is a 500, never a plain 401', async () => {
      const writer = h.app.get(AuditWriter);
      const real = writer.record.bind(writer);
      jest
        .spyOn(writer, 'record')
        .mockImplementation((input, tx) =>
          input.action === AUDIT_ACTIONS.AUTH_LOGIN_FAILED
            ? Promise.reject(new Error('audit unavailable'))
            : real(input, tx),
        );

      const outcome = await login(`nobody-${uuidv7()}@example.test`);
      expect(outcome.status).toBe(500);
      expect(outcome.body.error?.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    });
  });

  // ---------------------------------------------------------------------------
  describe('8. the application pools are guarded against nested acquisition', () => {
    /** The refusal, unwrapped from the query error Drizzle reports it in. */
    const refusalOf = (error: unknown): unknown =>
      error instanceof NestedPoolAcquisitionError || !(error instanceof Error)
        ? error
        : error.cause
          ? refusalOf(error.cause)
          : error;

    const fast = async (work: () => Promise<unknown>) => {
      const started = Date.now();
      const failure = await work().then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusalOf(failure)).toBeInstanceOf(NestedPoolAcquisitionError);
      // Refused at acquisition, not after waiting for a connection.
      expect(Date.now() - started).toBeLessThan(500);
    };

    it('refuses a statement on the identity pool from inside an identity transaction', async () => {
      const auth = h.app.get<Database>(AUTH_DB);
      await fast(() =>
        auth.transaction(async () => {
          await auth.select({ id: schema.users.id }).from(schema.users).limit(1);
        }),
      );
    });

    it('refuses an identity transaction inside an identity transaction', async () => {
      const auth = h.app.get<Database>(AUTH_DB);
      await fast(() => auth.transaction(() => auth.transaction(async () => undefined)));
    });

    it('refuses an application transaction inside an application transaction', async () => {
      const app = h.app.get<Database>(APP_DB);
      await fast(() => app.transaction(() => app.transaction(async () => undefined)));
    });

    it('refuses an application transaction inside an identity transaction', async () => {
      const app = h.app.get<Database>(APP_DB);
      const auth = h.app.get<Database>(AUTH_DB);
      await fast(() => auth.transaction(() => app.transaction(async () => undefined)));
    });

    it('allows an identity transaction inside an application transaction', async () => {
      const app = h.app.get<Database>(APP_DB);
      const auth = h.app.get<Database>(AUTH_DB);
      await expect(app.transaction(() => auth.transaction(async () => 'resolved'))).resolves.toBe(
        'resolved',
      );
    });

    it('leaves the pools clean afterwards', () => {
      expect(appPool.waitingCount).toBe(0);
      expect(authPool.waitingCount).toBe(0);
    });
  });
});
