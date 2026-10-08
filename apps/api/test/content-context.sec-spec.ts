/**
 * The seventh tenant-context claim through the production path (ADR-015 R-7,
 * ADR-014 §17.1).
 *
 * `TenantDatabase.withRequestTenant` writes `app.current_api_key_id` on every
 * transaction: the authenticated key's id for an API-key principal, the empty
 * string for a session principal — never skipped, so a value left on a pooled
 * connection cannot reach the next principal. Part A observes it over real
 * HTTP (real `AuthGuard`, real principals); Part B drives the service itself
 * on a single pooled connection to prove nothing leaks between transactions.
 * The Model B matrix itself is `packages/db/src/test/content-rls.int-spec.ts`.
 */
import { randomBytes } from 'node:crypto';
import type { AuthPrincipal } from '@acc/contracts';
import { createDatabase, createPool, schema, SESSION_VARS, type Database } from '@acc/db';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { RequestContext } from '../src/common/context/request-context';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { ContentContextProbeController } from './content-context-probe.controller';

const url = (p: string) => `/${PREFIX}${p}`;

interface Observed {
  claims: Record<string, string | null>;
  contentContextValid: boolean;
}

describe('the seventh claim, app.current_api_key_id, through TenantDatabase', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let keyA: { id: string; credential: string };

  const issueKey = async (tenant: TenantFixture) => {
    const credentials = h.app.get(CredentialService);
    const secret = `secret-${uuidv7()}`;
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const [row] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        name: `key-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: tenant.userId,
        scopes: ['workspaces.read'],
      })
      .returning({ id: schema.apiKeys.id });
    return { id: row!.id, credential: `${prefix}.${secret}` };
  };

  const observe = async (bearer: string): Promise<Observed> => {
    const res = await request(h.app.getHttpServer())
      .get(url('/test-content-context'))
      .set('authorization', `Bearer ${bearer}`)
      .expect(200);
    return res.body as Observed;
  };

  const tokenFor = async (email: string): Promise<string> => {
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  };

  beforeAll(async () => {
    h = await startHarness({ controllers: [ContentContextProbeController] });
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'cc7-a', credentials);
    orgB = await createTenant(h.admin, 'cc7-b', credentials);
    keyA = await issueKey(orgA);
  }, 60_000);

  afterAll(async () => {
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  afterEach(async () => {
    await h.clearRateLimits();
    await purgeAudit(h.admin, sql`true`);
  });

  // ---------------------------------------------------------------------------
  describe('A. over real HTTP — the principal AuthGuard builds', () => {
    it('a session principal: all seven claims written, app.current_api_key_id empty, the content context valid through its org grant', async () => {
      const seen = await observe(await tokenFor(orgA.email));
      expect(Object.keys(seen.claims).sort()).toEqual(Object.values(SESSION_VARS).sort());
      expect(seen.claims).toEqual({
        [SESSION_VARS.ORG_ID]: orgA.orgId,
        [SESSION_VARS.WORKSPACE_ID]: '',
        [SESSION_VARS.RESELLER_ID]: '',
        [SESSION_VARS.USER_ID]: orgA.userId,
        [SESSION_VARS.IS_PLATFORM_ADMIN]: 'off',
        [SESSION_VARS.PROVISIONING]: 'off',
        [SESSION_VARS.API_KEY_ID]: '',
      });
      expect(seen.contentContextValid).toBe(true);
    });

    it('an API-key principal: app.current_api_key_id is the authenticated key, no user claim, the content context valid through the key arm', async () => {
      const seen = await observe(keyA.credential);
      expect(seen.claims).toEqual({
        [SESSION_VARS.ORG_ID]: orgA.orgId,
        [SESSION_VARS.WORKSPACE_ID]: '',
        [SESSION_VARS.RESELLER_ID]: '',
        [SESSION_VARS.USER_ID]: '',
        [SESSION_VARS.IS_PLATFORM_ADMIN]: 'off',
        [SESSION_VARS.PROVISIONING]: 'off',
        [SESSION_VARS.API_KEY_ID]: keyA.id,
      });
      expect(seen.contentContextValid).toBe(true);
    });

    it('a key revoked after issue is refused at authentication, and its id never reaches a tenant transaction', async () => {
      const key = await issueKey(orgB);
      expect((await observe(key.credential)).claims[SESSION_VARS.API_KEY_ID]).toBe(key.id);
      await h.admin.execute(
        sql`UPDATE api_keys SET revoked_at = now(), revoked_reason = 'test' WHERE id = ${key.id}`,
      );
      await request(h.app.getHttpServer())
        .get(url('/test-content-context'))
        .set('authorization', `Bearer ${key.credential}`)
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('B. the service on one pooled connection — nothing leaks between transactions', () => {
    let pool: Pool;
    let authPool: Pool;
    let service: TenantDatabase;

    beforeAll(() => {
      pool = createPool({
        connectionString: process.env.DATABASE_URL!,
        max: 1,
        applicationName: 'acc-test-content-context',
      });
      authPool = createPool({ connectionString: process.env.DATABASE_AUTH_URL!, max: 1 });
      service = new TenantDatabase(createDatabase(pool) as Database, createDatabase(authPool));
    });

    afterAll(async () => {
      await pool.end();
      await authPool.end();
    });

    const sessionPrincipal = (t: TenantFixture): AuthPrincipal => ({
      actorType: 'user',
      userId: t.userId,
      apiKeyId: null,
      sessionId: null,
      tenant: { orgId: t.orgId, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      roles: [],
      permissions: [],
    });

    const keyPrincipal = (t: TenantFixture, apiKeyId: string): AuthPrincipal => ({
      actorType: 'api_key',
      userId: null,
      apiKeyId,
      sessionId: null,
      tenant: { orgId: t.orgId, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      roles: [],
      permissions: [],
    });

    /** The claim and backend pid one `withRequestTenant` transaction sees. */
    const within = (principal: AuthPrincipal) =>
      RequestContext.run(
        {
          correlationId: uuidv7(),
          requestId: uuidv7(),
          causationId: null,
          traceId: null,
          principal,
          ip: null,
          userAgent: null,
        },
        () =>
          service.withRequestTenant(async (tx) => {
            const { rows } = await tx.execute<{ key: string | null; pid: number; valid: boolean }>(
              sql`SELECT current_setting('app.current_api_key_id', true) AS key,
                         pg_backend_pid() AS pid, app_content_context_valid() AS valid`,
            );
            return rows[0]!;
          }),
      );

    it('an API-key transaction then a session transaction on the same connection: the key id does not carry over', async () => {
      const first = await within(keyPrincipal(orgA, keyA.id));
      const second = await within(sessionPrincipal(orgB));
      expect(second.pid).toBe(first.pid);
      expect(first).toMatchObject({ key: keyA.id, valid: true });
      expect(second).toMatchObject({ key: '', valid: true });
    });

    it('a connection poisoned with a session-level key id is overwritten for a session principal of another organization', async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET app.current_api_key_id = '${keyA.id}'`);
      } finally {
        client.release();
      }
      // The claim is written empty for the session principal — not inherited
      // as A's key from the connection.
      const seen = await within(sessionPrincipal(orgB));
      expect(seen.key).toBe('');
      // Prove the poison is still there on the connection outside the transaction.
      const { rows } = await pool.query<{ v: string }>(
        `SELECT current_setting('app.current_api_key_id', true) AS v`,
      );
      expect(rows[0]!.v).toBe(keyA.id);
      await pool.query('RESET app.current_api_key_id');
    });

    it('a poisoned key id cannot validate a principal that has none: an A-context transaction without an A grant or key is denied', async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET app.current_api_key_id = '${keyA.id}'`);
      } finally {
        client.release();
      }
      // orgB's user selecting A (no grant there): only an inherited key id
      // could make this valid.
      const seen = await within({
        ...sessionPrincipal(orgB),
        tenant: { orgId: orgA.orgId, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      });
      expect(seen).toMatchObject({ key: '', valid: false });
      await pool.query('RESET app.current_api_key_id');
    });
  });
});
