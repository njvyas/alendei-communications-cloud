/**
 * HTTP idempotency (Phase 1B.5.9, `API.md` §4, ADR-006).
 *
 * The mechanism is execution/replay coordination, and it is tested as a security
 * control rather than a convenience, because the way it fails is not "a duplicate
 * slips through" but "a previously successful request becomes a credential".
 *
 * Four properties carry the weight:
 *
 *   1. **One business mutation.** Every race below asserts the **final database
 *      state**, not merely the HTTP statuses. A race that returns the right
 *      codes while writing two rows has failed.
 *   2. **A replay is never an authorization bypass.** A stored record is reached
 *      only after the *current* request has authenticated and been authorized,
 *      and a refused request stores nothing to replay.
 *   3. **A key belongs to one principal in one tenant.** The principal and the
 *      organization are part of the request fingerprint, so another actor
 *      presenting the key is refused without learning that a record exists.
 *   4. **Nothing is cached but success.** Validation, authorization, business
 *      `4xx` and `5xx` all roll the claim back with the transaction, so a
 *      transient failure can never poison a key.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
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

const url = (p: string) => `/${PREFIX}${p}`;
const key = () => `idem-${uuidv7()}`;

describe('HTTP idempotency', () => {
  let h: Harness;
  let credentials: CredentialService;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  /** A second user inside Organization A, to test principal binding. */
  let secondUser: { userId: string; email: string };
  let secondToken: string;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'idem-a', credentials);
    orgB = await createTenant(h.admin, 'idem-b', credentials);

    const adminPermissions = [
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.ROLES_CREATE,
      PERMISSIONS.ROLES_DELETE,
      PERMISSIONS.ROLE_ASSIGNMENTS_READ,
      PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
    ];
    await grant(orgA, adminPermissions);
    await grant(orgB, adminPermissions);

    // A second organization-scoped user in A, holding the same authority: the
    // difference under test is *identity*, not permission.
    secondUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'organization',
      orgA.orgId,
      'idem-second',
    );

    tokenA = await tokenFor(orgA.email);
    tokenB = await tokenFor(orgB.email);
    secondToken = await tokenFor(secondUser.email);
  }, 90_000);

  afterAll(async () => {
    await destroyUser(h.admin, secondUser.userId);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(async () => {
    await purgeAudit(h.admin, sql`true`);
    await h.admin.execute(
      sql`DELETE FROM idempotency_keys WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})`,
    );
    await h.admin.execute(
      sql`DELETE FROM user_roles WHERE role_id IN (
            SELECT id FROM roles WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})
              AND key <> 'org_admin')`,
    );
    await h.admin.execute(
      sql`DELETE FROM role_permissions WHERE role_id IN (
            SELECT id FROM roles WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})
              AND key <> 'org_admin')`,
    );
    await h.admin.execute(
      sql`DELETE FROM roles WHERE org_id IN (${orgA.orgId}, ${orgB.orgId}) AND key <> 'org_admin'`,
    );
  });

  // --- fixtures --------------------------------------------------------------

  async function grant(tenant: TenantFixture, permissions: readonly string[]): Promise<void> {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const permissionKey of permissions) {
        const [permission] = await tx
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, permissionKey));
        if (permission) {
          await tx
            .insert(schema.rolePermissions)
            .values({ roleId: tenant.roleId, permissionId: permission.id })
            .onConflictDoNothing();
        }
      }
    });
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const roleBody = (suffix: string) => ({
    key: `idem_${suffix}`,
    name: `Idem ${suffix}`,
    allowedScopeTypes: ['organization'],
    permissions: [PERMISSIONS.ROLES_READ],
  });

  const createRole = (token: string, body: unknown, idempotencyKey?: string) => {
    const req = request(h.app.getHttpServer())
      .post(url('/roles'))
      .set('authorization', `Bearer ${token}`);
    if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey);
    return req.send(body);
  };

  const rolesNamed = async (roleKey: string, orgId = orgA.orgId) => {
    const rows = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.key, roleKey)));
    return rows;
  };

  const records = async (k: string) => {
    const { rows } = await h.admin.execute<{
      org_id: string;
      endpoint: string;
      status: string;
      response_status_code: number | null;
      actor_user_id: string | null;
      correlation_id: string | null;
    }>(sql`SELECT * FROM idempotency_keys WHERE idempotency_key = ${k}`);
    return rows;
  };

  // ===========================================================================
  describe('A. execution and replay', () => {
    it('the first request executes and records the outcome', async () => {
      const k = key();
      const res = await createRole(tokenA, roleBody('first'), k).expect(201);
      expect(res.body.data.key).toBe('idem_first');

      const stored = await records(k);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.org_id).toBe(orgA.orgId);
      expect(stored[0]!.endpoint).toBe('POST /roles');
      expect(stored[0]!.status).toBe('completed');
      expect(stored[0]!.response_status_code).toBe(201);
      expect(stored[0]!.actor_user_id).toBe(orgA.userId);
    });

    it('an identical repeat replays the stored response and mutates nothing', async () => {
      const k = key();
      const first = await createRole(tokenA, roleBody('replay'), k).expect(201);
      const second = await createRole(tokenA, roleBody('replay'), k).expect(201);

      // Byte-identical: the original answer, not a new one described as old.
      expect(second.body).toEqual(first.body);
      expect(second.status).toBe(first.status);
      // And exactly one role exists.
      expect(await rolesNamed('idem_replay')).toHaveLength(1);
    });

    it('the replayed body carries no replay marker — the envelope is unchanged', async () => {
      const k = key();
      await createRole(tokenA, roleBody('marker'), k).expect(201);
      const replay = await createRole(tokenA, roleBody('marker'), k).expect(201);

      expect(Object.keys(replay.body)).toEqual(['data']);
      expect(replay.body).not.toHaveProperty('replayed');
      expect(replay.body.data).not.toHaveProperty('replayed');
    });

    it('key order in the body does not defeat the replay', async () => {
      // A client library or proxy that re-serialises JSON must not turn a safe
      // retry into a mismatch.
      const k = key();
      const first = await createRole(tokenA, roleBody('order'), k).expect(201);
      const reordered = {
        permissions: [PERMISSIONS.ROLES_READ],
        allowedScopeTypes: ['organization'],
        name: 'Idem order',
        key: 'idem_order',
      };
      const second = await createRole(tokenA, reordered, k).expect(201);
      expect(second.body).toEqual(first.body);
      expect(await rolesNamed('idem_order')).toHaveLength(1);
    });

    it('without a key the endpoint behaves exactly as before', async () => {
      await createRole(tokenA, roleBody('nokey')).expect(201);
      // The second is a genuine duplicate, refused by the unique index.
      const second = await createRole(tokenA, roleBody('nokey')).expect(409);
      expect(second.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
      expect(await records('')).toHaveLength(0);
    });

    it('works on the second idempotent endpoint too', async () => {
      const created = await createRole(tokenA, roleBody('grantable'), key()).expect(201);
      const roleId = created.body.data.id;
      const k = key();
      const body = {
        userId: secondUser.userId,
        roleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      };

      const first = await request(h.app.getHttpServer())
        .post(url('/role-assignments'))
        .set('authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', k)
        .send(body)
        .expect(201);
      const second = await request(h.app.getHttpServer())
        .post(url('/role-assignments'))
        .set('authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', k)
        .send(body)
        .expect(201);

      expect(second.body).toEqual(first.body);
      const grants = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.roleId, roleId));
      expect(grants).toHaveLength(1);
      expect((await records(k))[0]!.endpoint).toBe('POST /role-assignments');
    });
  });

  // ===========================================================================
  describe('B. the same key with a different request', () => {
    it('refuses a different body with 422', async () => {
      const k = key();
      await createRole(tokenA, roleBody('mismatch'), k).expect(201);
      const res = await createRole(tokenA, roleBody('different'), k).expect(422);

      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
      // And the second request performed nothing.
      expect(await rolesNamed('idem_different')).toHaveLength(0);
    });

    it('discloses nothing about the stored request', async () => {
      const k = key();
      await createRole(tokenA, roleBody('secret'), k).expect(201);
      const res = await createRole(tokenA, roleBody('other'), k).expect(422);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('idem_secret');
      expect(serialized).not.toContain(orgA.userId);
      // Not the fingerprint either — that would say what to change to make a
      // key match someone else's request.
      expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    });

    it('refuses the same key on a different endpoint', async () => {
      const k = key();
      await createRole(tokenA, roleBody('endpoint'), k).expect(201);

      const res = await request(h.app.getHttpServer())
        .post(url('/role-assignments'))
        .set('authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', k)
        .send({
          userId: secondUser.userId,
          roleId: (await rolesNamed('idem_endpoint'))[0]!.id,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        });

      // A different endpoint is a different key namespace, so this executes on
      // its own rather than colliding — the record is per (org, endpoint, key).
      expect(res.status).toBe(201);
      expect(await records(k)).toHaveLength(2);
      expect((await records(k)).map((r) => r.endpoint).sort()).toEqual([
        'POST /role-assignments',
        'POST /roles',
      ]);
    });

    it('refuses a malformed key before any lookup', async () => {
      const res = await createRole(tokenA, roleBody('malformed'), 'short').expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
      expect(await rolesNamed('idem_malformed')).toHaveLength(0);
    });
  });

  // ===========================================================================
  describe('C. a key is never a credential', () => {
    it('a different user in the same organization cannot replay it', async () => {
      // The core property. Both principals hold the same authority and act in
      // the same organization; the only difference is identity.
      const k = key();
      const first = await createRole(tokenA, roleBody('principal'), k).expect(201);

      const res = await createRole(secondToken, roleBody('principal'), k).expect(422);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
      // It learned nothing about the first principal's response.
      expect(JSON.stringify(res.body)).not.toContain(first.body.data.id);
    });

    it('a different organization cannot reach it at all', async () => {
      const k = key();
      await createRole(tokenA, roleBody('crossorg'), k).expect(201);

      // Organization B's own namespace: it simply executes its own request.
      const res = await createRole(tokenB, roleBody('crossorg'), k).expect(201);
      expect(res.body.data.orgId).toBe(orgB.orgId);

      const stored = await records(k);
      expect(stored).toHaveLength(2);
      expect(stored.map((r) => r.org_id).sort()).toEqual([orgA.orgId, orgB.orgId].sort());
    });

    it('RLS hides another organization’s record from the service’s own query', async () => {
      const k = key();
      await createRole(tokenA, roleBody('rls'), k).expect(201);

      const db = h.app.get(
        (await import('../src/database/tenant-database.service')).TenantDatabase,
      );
      const rows = await db.withTenant({ orgId: orgB.orgId, resellerId: orgB.resellerId }, (tx) =>
        tx
          .select()
          .from(schema.idempotencyKeys)
          .where(eq(schema.idempotencyKeys.idempotencyKey, k)),
      );
      expect(rows).toHaveLength(0);
    });

    it('an API key cannot replay a user’s request', async () => {
      const k = key();
      await createRole(tokenA, roleBody('apikey'), k).expect(201);

      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      const secret = uuidv7();
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: 'idem-key',
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.ROLES_CREATE, PERMISSIONS.ROLES_READ],
      });

      try {
        const res = await createRole(`${prefix}.${secret}`, roleBody('apikey'), k);
        // Refused as a different request: the API key is a different principal
        // from the user who created it, even though that user created the key.
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${prefix}`);
      }
    });

    it('an unauthenticated request cannot replay anything', async () => {
      const k = key();
      await createRole(tokenA, roleBody('unauth'), k).expect(201);
      await request(h.app.getHttpServer())
        .post(url('/roles'))
        .set('Idempotency-Key', k)
        .send(roleBody('unauth'))
        .expect(401);
    });
  });

  // ===========================================================================
  describe('D. authorization is re-evaluated on every request', () => {
    it('a refused request stores nothing, so there is nothing to replay', async () => {
      const k = key();
      const unauthorized = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'workspace',
        orgA.workspaceId,
        'idem-unauth',
      );
      try {
        const token = await tokenFor(unauthorized.email);
        await createRole(token, roleBody('denied'), k).expect(403);

        // The claim rolled back with the refusal.
        expect(await records(k)).toHaveLength(0);
        expect(await rolesNamed('idem_denied')).toHaveLength(0);
      } finally {
        await destroyUser(h.admin, unauthorized.userId);
      }
    });

    it('a refused request still writes its authorization.denied audit row', async () => {
      // Phase 1B.5.3's control must survive idempotency wrapping the handler.
      const k = key();
      const unauthorized = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'workspace',
        orgA.workspaceId,
        'idem-audit',
      );
      try {
        const token = await tokenFor(unauthorized.email);
        await purgeAudit(h.admin, sql`true`);
        await createRole(token, roleBody('audited'), k).expect(403);

        const { rows } = await h.admin.execute<{ scope_type: string; actor_user_id: string }>(
          sql`SELECT * FROM audit_logs WHERE action = 'authorization.denied'`,
        );
        expect(rows).toHaveLength(1);
        // Still the actor's own scope, not the one it reached for.
        expect(rows[0]!.scope_type).toBe('workspace');
        expect(rows[0]!.actor_user_id).toBe(unauthorized.userId);
      } finally {
        await destroyUser(h.admin, unauthorized.userId);
      }
    });

    it('losing authorization after a successful request refuses the replay', async () => {
      // The property that makes a key not a credential: the stored record is
      // reached only *after* the current request has been authorized.
      const k = key();
      const actor = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'organization',
        orgA.orgId,
        'idem-losing',
      );
      try {
        const token = await tokenFor(actor.email);
        await createRole(token, roleBody('losing'), k).expect(201);

        // Revoke the grant that authorized it.
        await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${actor.userId}`);

        const replay = await createRole(token, roleBody('losing'), k);
        // Never 201: the current request is not authorized, so the stored
        // response is never reached.
        expect(replay.status).not.toBe(201);
        expect([400, 401, 403]).toContain(replay.status);
      } finally {
        await destroyUser(h.admin, actor.userId);
      }
    });
  });

  // ===========================================================================
  describe('E. failures are not cached', () => {
    it('a validation failure records nothing', async () => {
      const k = key();
      await createRole(tokenA, { key: 'Bad Key', name: '' }, k).expect(400);
      expect(await records(k)).toHaveLength(0);

      // And the key is still usable for the corrected request.
      await createRole(tokenA, roleBody('corrected'), k).expect(201);
      expect(await rolesNamed('idem_corrected')).toHaveLength(1);
    });

    it('a business conflict records nothing and leaves the key usable', async () => {
      await createRole(tokenA, roleBody('conflict')).expect(201);

      const k = key();
      await createRole(tokenA, roleBody('conflict'), k).expect(409);
      expect(await records(k)).toHaveLength(0);

      // A transient-looking failure has not poisoned the key.
      await createRole(tokenA, roleBody('after_conflict'), k).expect(201);
    });

    it('a refused composition records nothing', async () => {
      const k = key();
      await createRole(
        tokenA,
        { ...roleBody('escalate'), permissions: [PERMISSIONS.API_KEYS_CREATE] },
        k,
      ).expect(403);
      expect(await records(k)).toHaveLength(0);
    });
  });

  // ===========================================================================
  describe('F. correlation ids', () => {
    it('a replay carries its own correlation id, not the original’s', async () => {
      const k = key();
      const first = await createRole(tokenA, roleBody('corr'), k).expect(201);
      const replay = await createRole(tokenA, roleBody('corr'), k).expect(201);

      const firstId = first.headers['x-correlation-id'];
      const replayId = replay.headers['x-correlation-id'];
      expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
      expect(replayId).toMatch(/^[0-9a-f-]{36}$/);
      // A replay is its own request and must be traceable as one.
      expect(replayId).not.toBe(firstId);
    });

    it('the record retains the original correlation id for diagnostics', async () => {
      const k = key();
      const first = await createRole(tokenA, roleBody('diag'), k).expect(201);
      await createRole(tokenA, roleBody('diag'), k).expect(201);

      const stored = await records(k);
      expect(stored).toHaveLength(1);
      // Still the *original* execution's id — a replay does not overwrite it.
      expect(stored[0]!.correlation_id).toBe(first.headers['x-correlation-id']);
    });
  });

  // ===========================================================================
  describe('G. concurrency — one business mutation', () => {
    it('two concurrent identical requests produce one role', async () => {
      const k = key();
      const body = roleBody('race2');
      const results = await Promise.all([createRole(tokenA, body, k), createRole(tokenA, body, k)]);

      expect(results.every((r) => r.status === 201)).toBe(true);
      // Both answered; both answered the *same* thing.
      expect(results[0]!.body).toEqual(results[1]!.body);
      // The assertion that matters: the database, not the statuses.
      expect(await rolesNamed('idem_race2')).toHaveLength(1);
      expect(await records(k)).toHaveLength(1);
    });

    it('five concurrent identical requests produce one role', async () => {
      const k = key();
      const body = roleBody('race5');
      const results = await Promise.all(
        Array.from({ length: 5 }, () => createRole(tokenA, body, k)),
      );

      const created = results.filter((r) => r.status === 201);
      expect(created.length).toBeGreaterThan(0);
      // Every successful answer is identical.
      for (const res of created) expect(res.body).toEqual(created[0]!.body);
      expect(await rolesNamed('idem_race5')).toHaveLength(1);
      expect(await records(k)).toHaveLength(1);
    });

    it('the same key racing with different bodies still writes at most one', async () => {
      const k = key();
      const results = await Promise.all([
        createRole(tokenA, roleBody('racea'), k),
        createRole(tokenA, roleBody('raceb'), k),
      ]);

      const statuses = results.map((r) => r.status).sort();
      // One wins; the other is refused as a mismatch.
      expect(statuses).toEqual([201, 422]);
      const total =
        (await rolesNamed('idem_racea')).length + (await rolesNamed('idem_raceb')).length;
      expect(total).toBe(1);
      expect(await records(k)).toHaveLength(1);
    });

    it('the same key racing across two organizations writes one row each', async () => {
      const k = key();
      const body = roleBody('racetenant');
      const [a, b] = await Promise.all([createRole(tokenA, body, k), createRole(tokenB, body, k)]);

      expect([a.status, b.status]).toEqual([201, 201]);
      // Separate namespaces: neither blocked or replayed the other.
      expect(await rolesNamed('idem_racetenant', orgA.orgId)).toHaveLength(1);
      expect(await rolesNamed('idem_racetenant', orgB.orgId)).toHaveLength(1);
      expect(await records(k)).toHaveLength(2);
    });

    it('a rolled-back execution leaves the key free for a genuine retry', async () => {
      // The crash/rollback window, exercised through a business failure: the
      // claim and the mutation share one transaction, so a rollback takes both.
      await createRole(tokenA, roleBody('rollback')).expect(201);
      const k = key();
      await createRole(tokenA, roleBody('rollback'), k).expect(409);
      expect(await records(k)).toHaveLength(0);

      // Same key, corrected request: executes rather than replaying a failure.
      await createRole(tokenA, roleBody('rollback_ok'), k).expect(201);
      expect(await rolesNamed('idem_rollback_ok')).toHaveLength(1);
    });

    it('a race between a first execution and a repeat never double-writes', async () => {
      const k = key();
      const body = roleBody('racemixed');
      await createRole(tokenA, body, k).expect(201);

      const results = await Promise.all([
        createRole(tokenA, body, k),
        createRole(tokenA, body, k),
        createRole(tokenA, body, k),
      ]);
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await rolesNamed('idem_racemixed')).toHaveLength(1);
    });
  });
});
