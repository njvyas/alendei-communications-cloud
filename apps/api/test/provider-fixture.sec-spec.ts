/**
 * Phase 2.6 support — the provider-console fixture (`TESTING.md` §6v).
 *
 * An opt-in extension of the Phase 1C.4a fixture for the provider console and
 * its browser tests (Gate D.6). It is itself a security test asset, so this
 * suite proves what it builds, how, and that it grants nothing more:
 *
 *   A  refused before anything is written: environment gate; no fixture:dev
 *   B  providers: exactly the topology, through the real API, audited as the operator
 *   C  fixture platform roles: exact permissions, never providers.manage
 *   D  platform personas: one platform grant each, no administrator, no tenant reach
 *   E  the personas over HTTP: read-only, test_send-only and denied behave as designed
 *   F  idempotence, and the Phase 1C.4a fixture left exactly as it was
 *   G  conflicting state refused, never corrected
 *   H  the owner write set and import closure are pinned
 *
 * Like the 1C.4a suite, it refuses to start when a platform administrator
 * already exists and removes everything it created; mutation runs use
 * `scripts/with-db-clone.mjs` only.
 */
import { AUDIT_ACTIONS, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import request from 'supertest';

import {
  FIXTURE_USER_AGENT,
  ORGANIZATIONS,
  RESELLERS,
  USER_REFS,
  USERS,
} from '../src/cli/dev-fixture/topology';
import { runDevFixture } from '../src/cli/dev-fixture/run';
import { runProviderFixture, type ProviderFixtureManifest } from '../src/cli/provider-fixture/run';
import {
  PERSONA_REFS,
  PERSONAS,
  PLATFORM_ROLES,
  PROVIDER_FIXTURE_ACTOR_LABEL,
  PROVIDER_FIXTURE_USER_AGENT,
  PROVIDER_REFS,
  PROVIDERS,
  ROLE_REFS,
  personaRoleKey,
  type PersonaRef,
} from '../src/cli/provider-fixture/topology';
import {
  PREFIX,
  purgeAudit,
  purgeProviderHealth,
  startHarness,
  type Harness,
} from './auth-harness';

jest.setTimeout(180_000);

const API_ROOT = resolve(__dirname, '..');
const SUITE_USER_AGENT = 'acc-provider-fixture-suite';
const OPERATOR = 'provider-fixture-operator@example.test';
const OPERATOR_PASSWORD = `op-${randomBytes(24).toString('hex')}`;
const USER_PASSWORD = `fx-${randomBytes(24).toString('hex')}`;

function fixtureEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'test',
    NODE_ENV: 'test',
    SECRETS_BACKEND: 'env',
    AUTH_BOOTSTRAP_EMAIL: OPERATOR,
    AUTH_BOOTSTRAP_PASSWORD_REF: 'env:ACC_PROVIDER_FIXTURE_SUITE_OPERATOR_PASSWORD',
    ACC_FIXTURE_USER_PASSWORD_REF: 'env:ACC_PROVIDER_FIXTURE_SUITE_USER_PASSWORD',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourcesOf(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const FIXTURE_SOURCES = [
  resolve(API_ROOT, 'src/cli/provider-fixture.ts'),
  ...sourcesOf(resolve(API_ROOT, 'src/cli/provider-fixture')),
];

describe('Phase 2.6 support — the provider-console fixture', () => {
  let h: Harness;
  let manifest: ProviderFixtureManifest;
  const tokens: Partial<Record<PersonaRef | 'operator', string>> = {};

  const url = (p: string) => `/${PREFIX}${p}`;
  const q = async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await h.admin.execute(query)).rows as T[];
  const list = (values: readonly string[]) =>
    values.length
      ? sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        )
      : sql`NULL`;

  /** Every table's full content, hashed: the strongest "nothing changed" there is. */
  async function databaseHash(): Promise<string> {
    const tables = await q<{ name: string }>(
      sql`SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
    );
    const parts: string[] = [];
    for (const { name } of tables) {
      const [row] = await q<{ h: string }>(
        sql.raw(
          `SELECT '${name}:' || count(*) || ':' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS h FROM ${name} t`,
        ),
      );
      parts.push(row!.h);
    }
    return parts.join('|');
  }

  async function login(email: string, password: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .set('user-agent', SUITE_USER_AGENT)
      .send({ email, password })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const call = (method: 'get' | 'post' | 'put', who: keyof typeof tokens, path: string) =>
    request(h.app.getHttpServer())
      [method](url(path))
      .set('user-agent', SUITE_USER_AGENT)
      .set('authorization', `Bearer ${tokens[who]}`);

  async function expectRefusedUnchanged(env: NodeJS.ProcessEnv, message: RegExp): Promise<void> {
    const before = await databaseHash();
    await expect(runProviderFixture(env)).rejects.toThrow(message);
    expect(await databaseHash()).toBe(before);
  }

  /** Removes everything both fixtures (and this suite) created, by natural key. */
  async function removeAll(): Promise<void> {
    const providerIds = (
      await q<{ id: string }>(
        sql`SELECT id FROM providers WHERE lower(name) IN (${list(
          PROVIDER_REFS.map((r) => PROVIDERS[r].name.toLowerCase()),
        )})`,
      )
    ).map((r) => r.id);
    const orgIds = (
      await q<{ id: string }>(
        sql`SELECT id FROM organizations WHERE slug IN (${list(Object.values(ORGANIZATIONS).map((o) => o.slug))})
              OR reseller_id IN (SELECT id FROM resellers WHERE slug = ${RESELLERS.B.slug})`,
      )
    ).map((r) => r.id);
    const emails = [
      OPERATOR,
      ...USER_REFS.map((r) => USERS[r].email),
      ...PERSONA_REFS.map((r) => PERSONAS[r].email),
    ];
    const userIds = (
      await q<{ id: string }>(
        sql`SELECT id FROM users WHERE lower(email) IN (${list(emails.map((e) => e.toLowerCase()))})`,
      )
    ).map((r) => r.id);
    const roleIds = (
      await q<{ id: string }>(
        sql`SELECT id FROM roles WHERE org_id IS NULL AND key IN (${list(
          ROLE_REFS.map((r) => PLATFORM_ROLES[r].key),
        )})`,
      )
    ).map((r) => r.id);
    if (providerIds.length) {
      await purgeProviderHealth(h.admin, sql`provider_id IN (${list(providerIds)})`);
      await h.admin.execute(
        sql`DELETE FROM provider_capabilities WHERE provider_id IN (${list(providerIds)})`,
      );
      await h.admin.execute(sql`DELETE FROM providers WHERE id IN (${list(providerIds)})`);
    }
    await purgeAudit(
      h.admin,
      sql`org_id IN (${list(orgIds)}) OR actor_user_id IN (${list(userIds)})
          OR resource_id IN (${list([...userIds, ...roleIds, ...providerIds])})
          OR reseller_id IN (SELECT id FROM resellers WHERE slug = ${RESELLERS.B.slug})
          OR actor_label = ${PROVIDER_FIXTURE_ACTOR_LABEL}
          OR user_agent IN (${FIXTURE_USER_AGENT}, ${PROVIDER_FIXTURE_USER_AGENT}, ${SUITE_USER_AGENT})`,
    );
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      await tx.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(userIds)})`);
      await tx.execute(
        sql`DELETE FROM user_roles WHERE (user_id IN (${list(userIds)}) OR org_id IN (${list(orgIds)})) AND NOT (scope_type = 'organization' AND org_id IN (${list(orgIds)}))`,
      );
      await tx.execute(sql`DELETE FROM role_permissions WHERE role_id IN (${list(roleIds)})`);
      await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(roleIds)})`);
      for (const table of ['ws_tickets', 'api_keys', 'idempotency_keys', 'teams', 'workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(orgIds)})`);
      }
      // The organizations go inside this provisioning transaction: their
      // organization-scope grants, roles and role permissions cascade with them,
      // the one exemption of the last-organization-administrator rule (0028).
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgIds)})`);
      await tx.execute(
        sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      await tx.execute(sql`DELETE FROM users WHERE id IN (${list(userIds)})`);
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgIds)})`);
      await tx.execute(sql`DELETE FROM resellers WHERE slug = ${RESELLERS.B.slug}`);
    });
  }

  let hashBeforeDevFixture: string;
  let devFixtureHash: string;

  beforeAll(async () => {
    process.env.ACC_PROVIDER_FIXTURE_SUITE_OPERATOR_PASSWORD = OPERATOR_PASSWORD;
    process.env.ACC_PROVIDER_FIXTURE_SUITE_USER_PASSWORD = USER_PASSWORD;
    h = await startHarness();
    const admins = await q(
      sql`SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE r.org_id IS NULL AND r.key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN}`,
    );
    const existing = await q(
      sql`SELECT 1 FROM users WHERE lower(email) IN (${list(PERSONA_REFS.map((r) => PERSONAS[r].email))})
          UNION ALL SELECT 1 FROM roles WHERE org_id IS NULL AND key IN (${list(ROLE_REFS.map((r) => PLATFORM_ROLES[r].key))})`,
    );
    if (admins.length > 0 || existing.length > 0) {
      throw new Error(
        'provider-fixture suite: this database already holds a platform administrator or fixture objects; ' +
          'run it on a fresh or cloned test database (scripts/with-db-clone.mjs)',
      );
    }
    hashBeforeDevFixture = await databaseHash();
  });

  afterAll(async () => {
    try {
      if (h) await removeAll();
    } finally {
      if (h) await h.close();
      delete process.env.ACC_PROVIDER_FIXTURE_SUITE_OPERATOR_PASSWORD;
      delete process.env.ACC_PROVIDER_FIXTURE_SUITE_USER_PASSWORD;
    }
  });

  // ===========================================================================
  describe('A. refused before anything is written', () => {
    it('refuses outside development/test, before reading or writing anything', async () => {
      await expectRefusedUnchanged(fixtureEnv({ APP_ENV: 'production' }), /APP_ENV/);
      await expectRefusedUnchanged(fixtureEnv({ APP_ENV: undefined }), /APP_ENV/);
    });

    it('refuses without the Phase 1C.4a fixture: no platform administrator, nothing written', async () => {
      expect(await databaseHash()).toBe(hashBeforeDevFixture);
      await expectRefusedUnchanged(fixtureEnv(), /run fixture:dev first/);
    });

    it('then builds on top of fixture:dev', async () => {
      expect((await runDevFixture(fixtureEnv())).outcome).toBe('created');
      devFixtureHash = await databaseHash();
      manifest = await runProviderFixture(fixtureEnv());
      expect(manifest.outcome).toBe('created');
      tokens.operator = await login(OPERATOR, OPERATOR_PASSWORD);
      for (const ref of PERSONA_REFS) tokens[ref] = await login(PERSONAS[ref].email, USER_PASSWORD);
    });
  });

  // ===========================================================================
  describe('B. providers — exactly the topology, through the real API', () => {
    it('holds the three providers with their channel, status, simulator adapter and capabilities', async () => {
      const rows = await q<{
        name: string;
        channel: string;
        status: string;
        adapter: string;
        caps: unknown;
      }>(
        sql`SELECT p.name, c.code::text AS channel, p.status::text AS status, p.adapter_key AS adapter,
                   coalesce((SELECT json_object_agg(capability_key, value) FROM provider_capabilities WHERE provider_id = p.id), '{}'::json) AS caps
              FROM providers p JOIN channels c ON c.id = p.channel_id
             WHERE p.id IN (${list(PROVIDER_REFS.map((r) => manifest.providers[r].id))}) ORDER BY p.name`,
      );
      expect(rows).toEqual([
        {
          name: 'ACC Fixture Email',
          channel: 'email',
          status: 'disabled',
          adapter: 'simulator',
          caps: {},
        },
        {
          name: 'ACC Fixture SMS Primary',
          channel: 'sms',
          status: 'active',
          adapter: 'simulator',
          caps: { max_segments: 10 },
        },
        {
          name: 'ACC Fixture SMS Secondary',
          channel: 'sms',
          status: 'draining',
          adapter: 'simulator',
          caps: {},
        },
      ]);
    });

    it('every provider change is the operator’s own audited API call, never an owner write', async () => {
      const rows = await q<{ action: string; actor: string; ua: string; scope: string }>(
        sql`SELECT action, actor_user_id::text AS actor, user_agent AS ua, scope_type::text AS scope
              FROM audit_logs WHERE resource_id IN (${list(PROVIDER_REFS.map((r) => manifest.providers[r].id))})
             ORDER BY action`,
      );
      expect(rows.map((r) => r.action).sort()).toEqual(
        [
          AUDIT_ACTIONS.PROVIDER_CREATED,
          AUDIT_ACTIONS.PROVIDER_CREATED,
          AUDIT_ACTIONS.PROVIDER_CREATED,
          AUDIT_ACTIONS.PROVIDER_ENABLED,
          AUDIT_ACTIONS.PROVIDER_ENABLED,
          AUDIT_ACTIONS.PROVIDER_DRAINED,
          AUDIT_ACTIONS.PROVIDER_CAPABILITIES_REPLACED,
        ].sort(),
      );
      for (const r of rows) {
        expect(r.actor).toBe(manifest.platformAdministrator.id);
        expect(r.ua).toBe(PROVIDER_FIXTURE_USER_AGENT);
        expect(r.scope).toBe('platform');
      }
    });
  });

  // ===========================================================================
  describe('C. fixture platform roles', () => {
    it('two fixture-owned platform roles with exactly their permissions — none can manage providers', async () => {
      const rows = await q<{ key: string; system: boolean; scopes: string[]; perms: string[] }>(
        sql`SELECT r.key, r.is_system_role AS system, r.allowed_scope_types::text[] AS scopes,
                   array(SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                          WHERE rp.role_id = r.id ORDER BY p.key) AS perms
              FROM roles r WHERE r.org_id IS NULL AND r.key LIKE 'acc_fixture_%' ORDER BY r.key`,
      );
      expect(rows).toEqual([
        {
          key: 'acc_fixture_providers_reader',
          system: false,
          scopes: ['platform'],
          perms: ['providers.read'],
        },
        {
          key: 'acc_fixture_providers_tester',
          system: false,
          scopes: ['platform'],
          perms: ['providers.read', 'providers.test_send'],
        },
      ]);
      for (const r of rows) expect(r.perms).not.toContain(PERMISSIONS.PROVIDERS_MANAGE);
    });

    it('each is recorded as role.created at platform by the fixture, with its permissions', async () => {
      const rows = await q<{
        after: { key: string; permissions: string[] };
        label: string;
        scope: string;
      }>(
        sql`SELECT after, actor_label AS label, scope_type::text AS scope FROM audit_logs
             WHERE action = ${AUDIT_ACTIONS.ROLE_CREATED} AND resource_id IN (${list(ROLE_REFS.map((r) => manifest.roles[r].id))})`,
      );
      expect(rows.map((r) => [r.after.key, r.after.permissions, r.label, r.scope]).sort()).toEqual(
        ROLE_REFS.map((r) => [
          PLATFORM_ROLES[r].key,
          [...PLATFORM_ROLES[r].permissions],
          PROVIDER_FIXTURE_ACTOR_LABEL,
          'platform',
        ]).sort(),
      );
    });
  });

  // ===========================================================================
  describe('D. platform personas', () => {
    it('each persona is active with a credential and holds exactly one platform grant of its role', async () => {
      const rows = await q<{ email: string; status: string; cred: boolean; grants: string[] }>(
        sql`SELECT lower(u.email) AS email, u.status::text AS status, u.password_hash IS NOT NULL AS cred,
                   array(SELECT r.key || '@' || ur.scope_type || ':' || coalesce(ur.scope_id::text, '')
                           FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS grants
              FROM users u WHERE lower(u.email) IN (${list(PERSONA_REFS.map((r) => PERSONAS[r].email))})
             ORDER BY 1`,
      );
      expect(rows).toEqual(
        PERSONA_REFS.map((r) => ({
          email: PERSONAS[r].email,
          status: 'active',
          cred: true,
          grants: [`${personaRoleKey(r)}@platform:`],
        })).sort((a, b) => a.email.localeCompare(b.email)),
      );
    });

    it('no persona is a platform administrator: the operator stays the only alendei_super_admin', async () => {
      const admins = await q<{ email: string }>(
        sql`SELECT lower(u.email) AS email FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
             WHERE r.org_id IS NULL AND r.key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN}`,
      );
      expect(admins.map((a) => a.email)).toEqual([OPERATOR]);
    });

    it('each persona’s creation and grant are audited at platform by the fixture (user.invited, user_role.granted)', async () => {
      const rows = await q<{ action: string; resource: string; label: string }>(
        sql`SELECT action, resource_id::text AS resource, actor_label AS label FROM audit_logs
             WHERE resource_id IN (${list(PERSONA_REFS.map((r) => manifest.personas[r].id))})
               AND action IN (${AUDIT_ACTIONS.USER_INVITED}, ${AUDIT_ACTIONS.USER_ROLE_GRANTED})`,
      );
      for (const ref of PERSONA_REFS) {
        expect(
          rows
            .filter((r) => r.resource === manifest.personas[ref].id)
            .map((r) => `${r.action}/${r.label}`)
            .sort(),
        ).toEqual(
          [
            `${AUDIT_ACTIONS.USER_INVITED}/${PROVIDER_FIXTURE_ACTOR_LABEL}`,
            `${AUDIT_ACTIONS.USER_ROLE_GRANTED}/${PROVIDER_FIXTURE_ACTOR_LABEL}`,
          ].sort(),
        );
      }
    });
  });

  // ===========================================================================
  describe('E. the personas over HTTP', () => {
    const id = (ref: 'smsPrimary' | 'smsSecondary' | 'email') => manifest.providers[ref].id;

    it('the read-only persona reads the catalogue and health, and every write, test-send and probe is 403', async () => {
      const listed = await call('get', 'providersReader', '/providers?limit=100').expect(200);
      const names = (listed.body.data as { name: string }[]).map((p) => p.name);
      for (const ref of PROVIDER_REFS) expect(names).toContain(PROVIDERS[ref].name);
      await call('get', 'providersReader', `/providers/${id('smsPrimary')}/health`).expect(200);
      await call('post', 'providersReader', `/providers/${id('email')}/enable`).expect(403);
      await call('post', 'providersReader', `/providers/${id('smsPrimary')}/test-send`)
        .send({ behavior: 'SUCCESS' })
        .expect(403);
      await call('post', 'providersReader', `/providers/${id('smsPrimary')}/health-check`)
        .send({ behavior: 'HEALTHY' })
        .expect(403);
      await call('get', 'providersReader', '/provider-circuit-policy').expect(403);
    });

    it('the test_send-only persona reads and test-sends, and cannot administer or probe', async () => {
      await call('get', 'providersTester', '/providers?limit=100').expect(200);
      const sent = await call('post', 'providersTester', `/providers/${id('smsPrimary')}/test-send`)
        .send({ behavior: 'SUCCESS' })
        .expect(200);
      expect(sent.body.data.outcome).toBe('accepted');
      await call('post', 'providersTester', `/providers/${id('email')}/enable`).expect(403);
      await call('post', 'providersTester', `/providers/${id('smsPrimary')}/health-check`)
        .send({ behavior: 'HEALTHY' })
        .expect(403);
      await call('get', 'providersTester', '/provider-circuit-policy').expect(403);
    });

    it('the denied persona (alendei_support, no providers.*) is refused the whole catalogue', async () => {
      await call('get', 'platformSupport', '/channels').expect(403);
      await call('get', 'platformSupport', '/providers').expect(403);
      await call('get', 'platformSupport', `/providers/${id('smsPrimary')}`).expect(403);
    });

    it('the platform administrator administers: the circuit policy reads, and an illegal transition is refused (409)', async () => {
      await call('get', 'operator', '/provider-circuit-policy').expect(200);
      await call('post', 'operator', `/providers/${id('smsPrimary')}/enable`).expect(409);
    });
  });

  // ===========================================================================
  describe('F. idempotence and the Phase 1C.4a fixture', () => {
    it('a second run is a no-op: outcome unchanged, every table byte-identical', async () => {
      const before = await databaseHash();
      const again = await runProviderFixture(fixtureEnv());
      expect(again.outcome).toBe('unchanged');
      expect(again.providers).toEqual(manifest.providers);
      expect(again.personas).toEqual(manifest.personas);
      expect(await databaseHash()).toBe(before);
    });

    it('the Phase 1C.4a fixture is untouched: fixture:dev is still a no-op', async () => {
      expect(devFixtureHash).not.toBe(hashBeforeDevFixture);
      const before = await databaseHash();
      expect((await runDevFixture(fixtureEnv())).outcome).toBe('unchanged');
      expect(await databaseHash()).toBe(before);
    });
  });

  // ===========================================================================
  describe('G. conflicting state is refused, never corrected', () => {
    async function refusedWhile(
      change: ReturnType<typeof sql>,
      undo: ReturnType<typeof sql>,
      message: RegExp,
    ): Promise<void> {
      await h.admin.execute(change);
      try {
        await expectRefusedUnchanged(fixtureEnv(), message);
      } finally {
        await h.admin.execute(undo);
      }
    }

    it('a fixture provider in another status is refused, not moved', async () => {
      await refusedWhile(
        sql`UPDATE providers SET status = 'active' WHERE id = ${manifest.providers.email.id}`,
        sql`UPDATE providers SET status = 'disabled' WHERE id = ${manifest.providers.email.id}`,
        /ACC Fixture Email" is active, not disabled/,
      );
    });

    it('a fixture provider past its target on the lifecycle path is refused, not moved back', async () => {
      await refusedWhile(
        sql`UPDATE providers SET status = 'draining' WHERE id = ${manifest.providers.smsPrimary.id}`,
        sql`UPDATE providers SET status = 'active' WHERE id = ${manifest.providers.smsPrimary.id}`,
        /ACC Fixture SMS Primary" is draining, not active/,
      );
    });

    it('a fixture role carrying an extra permission is refused, not trimmed', async () => {
      await refusedWhile(
        sql`INSERT INTO role_permissions (role_id, permission_id)
            SELECT ${manifest.roles.reader.id}, id FROM permissions WHERE key = ${PERMISSIONS.PROVIDERS_MANAGE}`,
        sql`DELETE FROM role_permissions WHERE role_id = ${manifest.roles.reader.id}
              AND permission_id = (SELECT id FROM permissions WHERE key = ${PERMISSIONS.PROVIDERS_MANAGE})`,
        /acc_fixture_providers_reader differs/,
      );
    });

    it('a persona holding an extra grant is refused, not revoked', async () => {
      const [support] = await q<{ id: string }>(
        sql`SELECT id FROM roles WHERE org_id IS NULL AND key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT}`,
      );
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.execute(
          sql`INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
              VALUES (${manifest.personas.providersReader.id}, ${support!.id}, 'platform', NULL)`,
        );
      });
      try {
        await expectRefusedUnchanged(fixtureEnv(), /providers-reader@.* holds different grants/);
      } finally {
        await h.admin.execute(
          sql`DELETE FROM user_roles WHERE user_id = ${manifest.personas.providersReader.id} AND role_id = ${support!.id}`,
        );
      }
    });

    it('after every refusal the fixture is intact: a run is again a no-op', async () => {
      expect((await runProviderFixture(fixtureEnv())).outcome).toBe('unchanged');
    });
  });

  // ===========================================================================
  describe('H. the owner write set and import closure are pinned', () => {
    it('owner writes: exactly roles, role_permissions and user_roles; lifecycle invite and activate once each; no other elevation', () => {
      const rawWrites: string[] = [];
      const lifecycleCalls: string[] = [];
      for (const file of FIXTURE_SOURCES) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(
          /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY)\s+([a-z_]+)/gi,
        )) {
          rawWrites.push(
            `${relative(API_ROOT, file)} ${m[1]!.toUpperCase().replace(/\s+/g, ' ')} ${m[2]}`,
          );
        }
        for (const m of text.matchAll(/\.(invite|activate|disable|reactivate|reinstate)\(/g)) {
          lifecycleCalls.push(`${relative(API_ROOT, file)} ${m[1]}`);
        }
        expect(text).not.toMatch(/\b(tx|db|work|admin)\.(insert|update|delete)\(/);
        expect(text).not.toMatch(/DISABLE\s+TRIGGER/i);
        expect(text).not.toMatch(
          /\b(ALTER|CREATE|DROP)\s+(TABLE|ROLE|POLICY|TRIGGER|FUNCTION)\b|\b(GRANT|REVOKE)\s+\w+\s+ON\b/,
        );
        for (const m of text.matchAll(/set_config\('([a-z_.]+)'/g))
          expect(`${relative(API_ROOT, file)} ${m[1]}`).toBe(
            'src/cli/provider-fixture/owner-operations.ts app.is_platform_admin',
          );
      }
      expect(rawWrites.sort()).toEqual([
        'src/cli/provider-fixture/owner-operations.ts INSERT INTO role_permissions',
        'src/cli/provider-fixture/owner-operations.ts INSERT INTO roles',
        'src/cli/provider-fixture/owner-operations.ts INSERT INTO user_roles',
      ]);
      expect(lifecycleCalls.sort()).toEqual([
        'src/cli/provider-fixture/owner-operations.ts activate',
        'src/cli/provider-fixture/owner-operations.ts invite',
      ]);
    });

    it('the import closure is pinned, and no application module imports the fixture', () => {
      const imports = new Set<string>();
      for (const file of FIXTURE_SOURCES) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(?:from\s+|import\()'([^']+)'/g)) {
          const spec = m[1]!;
          imports.add(
            spec.startsWith('.') ? relative(API_ROOT, resolve(dirname(file), spec)) : spec,
          );
        }
      }
      expect([...imports].sort()).toEqual([
        '@acc/contracts',
        '@acc/db',
        'dotenv',
        'drizzle-orm',
        'node:crypto',
        'node:net',
        'node:path',
        'src/app.factory',
        'src/audit/audit-writer.service',
        'src/cli/bootstrap',
        'src/cli/dev-fixture/environment',
        'src/cli/dev-fixture/topology',
        'src/cli/provider-fixture/api-client',
        'src/cli/provider-fixture/inspect',
        'src/cli/provider-fixture/owner-operations',
        'src/cli/provider-fixture/run',
        'src/cli/provider-fixture/topology',
        'src/config/app-config.service',
        'src/iam/credential.service',
        'src/iam/user-lifecycle.service',
        'uuidv7',
      ]);
      const importers = sourcesOf(resolve(API_ROOT, 'src'))
        .filter((f) => !f.includes(join('src', 'cli')))
        .filter((f) => !f.endsWith('.spec.ts'))
        .filter((f) =>
          /(from\s+|import\()'[^']*cli\/provider-fixture/.test(readFileSync(f, 'utf8')),
        );
      expect(importers).toEqual([]);
    });
  });
});
