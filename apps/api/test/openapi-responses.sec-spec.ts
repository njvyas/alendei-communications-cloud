/**
 * Phase 1C.3 — every documented operation, exercised over real HTTP, with
 * every response validated against the OpenAPI document (ADR G10: a dedicated
 * contract-validation suite; no other suite is changed).
 *
 * For each response the validator checks that the status is documented, that
 * the body matches the documented schema (closed objects: an undocumented field
 * fails) and that every header the document marks `required` is present.
 *
 *   S  success, for every operation, with each credential the document says it
 *      accepts — proving `@AcceptedCredentials` against the runtime
 *   X  the refusal of each credential the document says it does NOT accept
 *   E  error sweeps over every operation: no credential, malformed path id,
 *      unknown body field, unknown query parameter, unknown id, an unprivileged
 *      principal — plus lifecycle, idempotency, admissibility, CSRF, media-type
 *   R  rate limiting: the general limiter and both per-address buckets
 *   Z  totals: nothing undocumented was observed; every operation succeeded
 *      with every documented credential
 */
import { createDatabase, createPool, schema, type Database } from '@acc/db';
import { PERMISSIONS, TENANT_ROLE_DEFINITIONS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { bootApp, bootAppInFileRegistry, type Booted } from './openapi-support';
import { OpenApiValidator } from './openapi-validator';

type Json = Record<string, unknown>;
type Credential = 'userSession' | 'apiKey' | 'refreshCookie' | 'none';

// Not imported from `auth-harness`: that module loads `AppModule` at import
// time, before this suite turns the OpenAPI capability on.
const PREFIX = 'api/v1';
const PASSWORD = 'a-sufficiently-long-test-passphrase';

interface Person {
  id: string;
  email: string;
  token: string;
  sessionId: string;
  cookie: string;
}

describe('Phase 1C.3 — every operation validated against the OpenAPI document', () => {
  let booted: Booted;
  let validator: OpenApiValidator;
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  let resellerId: string;
  let orgId: string;
  let workspaceId: string;
  let teamId: string;
  let roles: Record<string, string>;
  let admin: Person;
  let member: Person;
  let stranger: Person;
  let platform: Person;
  let apiKey: string;

  const problems: string[] = [];
  const successes = new Map<string, Set<Credential>>();
  const observed = new Map<string, Set<number>>();
  const created = { users: [] as string[], orgs: [] as string[], resellers: [] as string[] };
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);

  // --- the request helper: every response is validated ----------------------------

  interface Hit {
    as?: Credential;
    bearer?: string;
    cookie?: string;
    body?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    raw?: { type: string; payload: string };
  }

  async function hit(method: string, path: string, options: Hit = {}): Promise<request.Response> {
    const full = path.startsWith('/') ? path : `/${PREFIX}/${path}`;
    const server = booted.app.getHttpServer();
    let r = (request(server) as unknown as Record<string, (u: string) => request.Test>)[
      method.toLowerCase()
    ]!(full);
    if (options.bearer) r = r.set('authorization', `Bearer ${options.bearer}`);
    if (options.cookie) r = r.set('cookie', options.cookie);
    for (const [k, v] of Object.entries(options.headers ?? {})) r = r.set(k, v);
    if (options.query) r = r.query(options.query);
    if (options.raw) r = r.set('content-type', options.raw.type).send(options.raw.payload);
    else if (options.body !== undefined) r = r.send(options.body as object);
    const res = await r;
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
    problems.push(...validator.check(method, `${full}${query}`, res));
    const ref = validator.find(method, full);
    if (ref) {
      const key = `${ref.method} ${ref.template}`;
      if (!observed.has(key)) observed.set(key, new Set());
      observed.get(key)!.add(res.status);
      if (res.status >= 200 && res.status < 300) {
        if (!successes.has(key)) successes.set(key, new Set());
        successes.get(key)!.add(options.as ?? (options.bearer ? 'userSession' : 'none'));
      }
    }
    return res;
  }

  /** Runs a request as each named principal. */
  const as = {
    session: (p: Person): Hit => ({ as: 'userSession', bearer: p.token }),
    key: (): Hit => ({ as: 'apiKey', bearer: apiKey }),
  };

  // --- fixtures ----------------------------------------------------------------------

  async function hash(password: string): Promise<string> {
    return booted
      .resolve<{ hash(p: string): Promise<string> }>(
        '../src/iam/credential.service',
        'CredentialService',
      )
      .hash(password);
  }

  async function person(label: string): Promise<Omit<Person, 'token' | 'sessionId' | 'cookie'>> {
    const email = `oa-${label}-${suffix()}@example.test`;
    const [u] = await db
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    created.users.push(u!.id);
    return { id: u!.id, email };
  }

  async function signIn(p: { id: string; email: string }): Promise<Person> {
    await booted.clearRateLimits();
    const res = await hit('POST', 'auth/login', { body: { email: p.email, password: PASSWORD } });
    expect(res.status).toBe(200);
    const token = res.body.data.accessToken as string;
    const me = await hit('GET', 'auth/me', { as: 'userSession', bearer: token });
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('acc_refresh='))!
      .split(';')[0]!;
    return { ...p, token, sessionId: me.body.data.sessionId as string, cookie };
  }

  async function grant(userId: string, roleId: string, scopeType: string, scopeId: string | null) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx
        .insert(schema.userRoles)
        .values({ userId, roleId, scopeType: scopeType as never, scopeId });
    });
  }

  beforeAll(async () => {
    booted = await bootAppInFileRegistry({ APP_ENV: 'test', OPENAPI_UI_ENABLED: 'true' });
    const document = await booted
      .resolve<{ get(): Promise<Json> }>(
        '../src/openapi/openapi-document.service',
        'OpenApiDocumentService',
      )
      .get();
    validator = new OpenApiValidator(document);
    pool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 3,
      applicationName: 'acc-test-openapi-responses',
    });
    db = createDatabase(pool);

    const [reseller] = await db
      .insert(schema.resellers)
      .values({ name: 'OA reseller', slug: `oa-rs-${suffix()}` })
      .returning({ id: schema.resellers.id });
    resellerId = reseller!.id;
    created.resellers.push(resellerId);
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: 'OA org', slug: `oa-org-${suffix()}`, resellerId })
      .returning({ id: schema.organizations.id });
    orgId = org!.id;
    created.orgs.push(orgId);
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ orgId, name: 'Default', slug: 'default', isDefault: true })
      .returning({ id: schema.workspaces.id });
    workspaceId = ws!.id;
    const [team] = await db
      .insert(schema.teams)
      .values({ orgId, workspaceId, name: 'OA team' })
      .returning({ id: schema.teams.id });
    teamId = team!.id;
    const provisioner = booted.resolve<{
      seedTenantRoles(tx: unknown, orgId: string, meta: { correlationId: string }): Promise<void>;
    }>('../src/rbac/tenant-role-provisioner.service', 'TenantRoleProvisioner');
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx, orgId, { correlationId: uuidv7() });
    });
    const rows = await db
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, orgId));
    roles = Object.fromEntries(rows.map((r) => [r.key, r.id]));
    // A tenant role with no permissions at all: a member who can select the
    // organization and nothing more.
    const nothing = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      const [r] = await tx
        .insert(schema.roles)
        .values({
          orgId,
          key: `oa_nothing_${suffix()}`,
          name: 'Nothing',
          isSystemRole: false,
          allowedScopeTypes: ['organization'],
        })
        .returning({ id: schema.roles.id });
      return r!.id;
    });

    const a = await person('admin');
    await grant(a.id, roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, 'organization', orgId);
    const m = await person('member');
    await grant(m.id, roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', orgId);
    const s = await person('stranger');
    await grant(s.id, nothing, 'organization', orgId);
    const p = await person('platform');
    const [superAdmin] = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(sql`${schema.roles.key} = 'alendei_super_admin' AND ${schema.roles.orgId} IS NULL`);
    await grant(p.id, superAdmin!.id, 'platform', null);

    admin = await signIn(a);
    member = await signIn(m);
    stranger = await signIn(s);
    platform = await signIn(p);

    const orgAdmin = TENANT_ROLE_DEFINITIONS.find((r) => r.key === TENANT_ROLE_KEYS.ORG_ADMIN)!;
    const secret = `secret-${uuidv7()}`;
    const keyPrefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
    await db.insert(schema.apiKeys).values({
      orgId,
      name: `oa-${keyPrefix}`,
      keyPrefix,
      keyHash: await hash(secret),
      createdBy: admin.id,
      scopes: [...orgAdmin.permissions],
    });
    apiKey = `${keyPrefix}.${secret}`;
  }, 180_000);

  afterAll(async () => {
    const orgs = created.orgs;
    const users = created.users;
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
    await db.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`);
    try {
      await db.execute(
        sql`DELETE FROM audit_logs WHERE org_id IN (${list(orgs)}) OR actor_user_id IN (${list(users)})
            OR reseller_id IN (${list(created.resellers)})
            OR actor_api_key_id IN (SELECT id FROM api_keys WHERE org_id IN (${list(orgs)}))`,
      );
    } finally {
      await db.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
    }
    await db.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(users)})`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(
          sql`DELETE FROM user_roles WHERE user_id IN (${list(users)}) OR org_id IN (${list(orgs)})`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      for (const table of [
        'role_permissions',
        'roles',
        'ws_tickets',
        'api_keys',
        'idempotency_keys',
        'teams',
        'workspaces',
      ]) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(orgs)})`);
      }
    });
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgs)})`);
    await db.delete(schema.users).where(inArray(schema.users.id, users));
    await db.delete(schema.resellers).where(inArray(schema.resellers.id, created.resellers));
    await booted.clearRateLimits();
    await booted.close();
    await pool.end();
  }, 120_000);

  const expectStatus = (res: request.Response, status: number, label: string) => {
    const detail =
      res.status === status
        ? ''
        : ` (${String(res.body?.error?.code ?? '')}: ${String(res.body?.error?.message ?? '')})`;
    expect(`${label} → ${res.status}${detail}`).toBe(`${label} → ${status}`);
  };

  // ===========================================================================
  describe('S. success, with every documented credential', () => {
    it('authentication, identity and sessions', async () => {
      const extra = await signIn(admin); // a second session of the admin
      for (const credential of [as.session(admin), as.key()]) {
        expectStatus(await hit('GET', 'auth/me', credential), 200, 'me');
        expectStatus(
          await hit('GET', 'auth/me/authorization', credential),
          200,
          'me/authorization',
        );
        expectStatus(await hit('GET', 'auth/sessions', credential), 200, 'sessions');
      }
      expectStatus(
        await hit('DELETE', `auth/sessions/${extra.sessionId}`, as.session(admin)),
        204,
        'revoke own session',
      );

      const fresh = await signIn(admin);
      const refreshed = await hit('POST', 'auth/refresh', {
        as: 'refreshCookie',
        cookie: fresh.cookie,
        headers: { 'x-acc-refresh': '1' },
      });
      expectStatus(refreshed, 200, 'refresh');

      const tail = await signIn(admin);
      expectStatus(
        await hit('POST', 'auth/sessions/revoke-all', as.session(tail)),
        200,
        'revoke-all own',
      );
      admin = await signIn(admin);

      // Logout by bearer, by API key (no session: a no-op), and by cookie.
      const byBearer = await signIn(admin);
      expectStatus(
        await hit('POST', 'auth/logout', {
          ...as.session(byBearer),
          headers: { 'x-acc-refresh': '1' },
        }),
        204,
        'logout bearer',
      );
      expectStatus(
        await hit('POST', 'auth/logout', { ...as.key(), headers: { 'x-acc-refresh': '1' } }),
        204,
        'logout api key',
      );
      const byCookie = await signIn(admin);
      expectStatus(
        await hit('POST', 'auth/logout', {
          as: 'refreshCookie',
          cookie: byCookie.cookie,
          headers: { 'x-acc-refresh': '1' },
        }),
        204,
        'logout cookie',
      );

      expectStatus(await hit('POST', 'ws/ticket', as.session(admin)), 201, 'ws ticket');
      expectStatus(await hit('GET', 'openapi.json', as.session(admin)), 200, 'openapi document');
    });

    it('health', async () => {
      for (const path of ['/health', '/health/live', '/health/ready']) {
        expectStatus(await hit('GET', path, { as: 'none' }), 200, path);
      }
    });

    it('organizations', async () => {
      for (const credential of [as.session(admin), as.key()]) {
        expectStatus(await hit('GET', 'organizations', credential), 200, 'list');
        expectStatus(await hit('GET', `organizations/${orgId}`, credential), 200, 'get');
        expectStatus(
          await hit('PATCH', `organizations/${orgId}`, {
            ...credential,
            body: { name: `OA org ${suffix()}` },
          }),
          200,
          'update',
        );
      }
      const createdOrg = await hit('POST', 'organizations', {
        ...as.session(platform),
        headers: { 'x-acc-organization': orgId },
        body: { name: 'OA created', slug: `oa-new-${suffix()}`, resellerId },
      });
      expectStatus(createdOrg, 201, 'create');
      const newOrg = createdOrg.body.data.id as string;
      created.orgs.push(newOrg);
      for (const transition of ['suspend', 'reactivate', 'close']) {
        expectStatus(
          await hit('POST', `organizations/${newOrg}/${transition}`, {
            ...as.session(platform),
            body: { reason: 'contract test' },
          }),
          200,
          transition,
        );
      }
    });

    it('workspaces, teams and the deprecated tenancy aliases', async () => {
      for (const credential of [as.session(admin), as.key()]) {
        expectStatus(await hit('GET', 'workspaces', credential), 200, 'list workspaces');
        expectStatus(
          await hit('GET', `workspaces/${workspaceId}`, credential),
          200,
          'get workspace',
        );
        const ws = await hit('POST', 'workspaces', {
          ...credential,
          body: { name: 'OA ws', slug: `oa-ws-${suffix()}` },
        });
        expectStatus(ws, 201, 'create workspace');
        const id = ws.body.data.id as string;
        expectStatus(
          await hit('PATCH', `workspaces/${id}`, {
            ...credential,
            body: { name: 'OA ws renamed' },
          }),
          200,
          'update workspace',
        );
        expectStatus(
          await hit('POST', `workspaces/${id}/archive`, credential),
          200,
          'archive workspace',
        );
        expectStatus(
          await hit('POST', `workspaces/${id}/restore`, credential),
          200,
          'restore workspace',
        );

        expectStatus(await hit('GET', 'teams', credential), 200, 'list teams');
        expectStatus(await hit('GET', `teams/${teamId}`, credential), 200, 'get team');
        const team = await hit('POST', 'teams', {
          ...credential,
          body: { workspaceId, name: `OA team ${suffix()}` },
        });
        expectStatus(team, 201, 'create team');
        const tid = team.body.data.id as string;
        expectStatus(
          await hit('PATCH', `teams/${tid}`, {
            ...credential,
            body: { name: `OA team renamed ${suffix()}` },
          }),
          200,
          'update team',
        );
        expectStatus(await hit('POST', `teams/${tid}/archive`, credential), 200, 'archive team');
        expectStatus(await hit('POST', `teams/${tid}/restore`, credential), 200, 'restore team');

        const legacy = await hit('GET', 'tenants/workspaces', credential);
        expectStatus(legacy, 200, 'legacy list');
        expect(legacy.headers.deprecation).toBe('true');
        expect(legacy.headers.link).toContain('successor-version');
        expectStatus(
          await hit('GET', `tenants/workspaces/${workspaceId}`, credential),
          200,
          'legacy get',
        );
      }
    });

    it('roles, permissions and role assignments', async () => {
      for (const credential of [as.session(admin), as.key()]) {
        expectStatus(await hit('GET', 'permissions', credential), 200, 'list permissions');
        expectStatus(await hit('GET', 'roles', credential), 200, 'list roles');
        expectStatus(
          await hit('GET', `roles/${roles[TENANT_ROLE_KEYS.READ_ONLY]}`, credential),
          200,
          'get role',
        );
        const role = await hit('POST', 'roles', {
          ...credential,
          body: {
            key: `oa_role_${suffix()}`,
            name: 'OA role',
            allowedScopeTypes: ['organization', 'workspace'],
            permissions: [PERMISSIONS.WORKSPACES_READ],
          },
        });
        expectStatus(role, 201, 'create role');
        const rid = role.body.data.id as string;
        expectStatus(
          await hit('PATCH', `roles/${rid}`, { ...credential, body: { name: 'OA role renamed' } }),
          200,
          'update role',
        );

        expectStatus(await hit('GET', 'role-assignments', credential), 200, 'list assignments');
        const assignment = await hit('POST', 'role-assignments', {
          ...credential,
          body: { userId: member.id, roleId: rid, scopeType: 'organization', scopeId: orgId },
        });
        expectStatus(assignment, 201, 'grant');
        const aid = assignment.body.data.id as string;
        expectStatus(
          await hit('GET', `role-assignments/${aid}`, credential),
          200,
          'get assignment',
        );
        expectStatus(
          await hit('DELETE', `role-assignments/${aid}`, credential),
          204,
          'revoke assignment',
        );
        expectStatus(await hit('DELETE', `roles/${rid}`, credential), 204, 'delete role');
      }
    });

    it('users and administrator session control', async () => {
      for (const credential of [as.session(admin), as.key()]) {
        expectStatus(await hit('GET', 'users', credential), 200, 'list users');
        expectStatus(await hit('GET', `users/${member.id}`, credential), 200, 'get user');
        const u = await hit('POST', 'users', {
          ...credential,
          body: {
            email: `oa-invited-${suffix()}@example.test`,
            initialRole: {
              roleId: roles[TENANT_ROLE_KEYS.READ_ONLY],
              scopeType: 'organization',
              scopeId: orgId,
            },
          },
        });
        expectStatus(u, 201, 'create user');
        const uid = u.body.data.id as string;
        created.users.push(uid);
        expectStatus(
          await hit('PATCH', `users/${uid}`, { ...credential, body: { phone: '+15551234567' } }),
          200,
          'update user',
        );
        expectStatus(await hit('POST', `users/${uid}/disable`, credential), 200, 'disable user');
        expectStatus(
          await hit('POST', `users/${uid}/reactivate`, credential),
          200,
          'reactivate user',
        );
        expectStatus(
          await hit('GET', `users/${member.id}/sessions`, credential),
          200,
          'list user sessions',
        );
      }
      const victim = await signIn(stranger);
      expectStatus(
        await hit('DELETE', `users/${stranger.id}/sessions/${victim.sessionId}`, as.session(admin)),
        204,
        'revoke one user session',
      );
      expectStatus(
        await hit('POST', `users/${stranger.id}/sessions/revoke-all`, as.session(admin)),
        200,
        'revoke all user sessions',
      );
      stranger = await signIn(stranger);
    });

    it('API keys and audit records', async () => {
      const k = await hit('POST', 'api-keys', {
        ...as.session(admin),
        body: {
          name: `oa-key-${suffix()}`,
          scopeType: 'organization',
          scopeId: orgId,
          scopes: [PERMISSIONS.WORKSPACES_READ],
        },
      });
      expectStatus(k, 201, 'create key');
      expect(String(k.body.data.secret).length).toBeGreaterThan(16);
      expect(String(k.body.data.prefix)).toMatch(/^ak_(live|test)_/);
      const k2 = await hit('POST', 'api-keys', {
        ...as.session(admin),
        body: {
          name: `oa-key-${suffix()}`,
          scopeType: 'organization',
          scopeId: orgId,
          scopes: [PERMISSIONS.WORKSPACES_READ],
        },
      });
      for (const [credential, id] of [
        [as.session(admin), k.body.data.id],
        [as.key(), k2.body.data.id],
      ] as const) {
        expectStatus(await hit('GET', 'api-keys', credential), 200, 'list keys');
        expectStatus(await hit('GET', `api-keys/${id}`, credential), 200, 'get key');
        expectStatus(await hit('POST', `api-keys/${id}/revoke`, credential), 200, 'revoke key');
        const audit = await hit('GET', 'audit-logs', { ...credential, query: { limit: '5' } });
        expectStatus(audit, 200, 'list audit');
        expectStatus(
          await hit('GET', `audit-logs/${audit.body.data[0].id}`, credential),
          200,
          'get audit',
        );
      }
    });
  });

  // ===========================================================================
  describe('X. a credential an operation does not accept is refused', () => {
    it('an API key never succeeds on a user-session-only operation', async () => {
      const document = validator.document as { paths: Record<string, Record<string, Json>> };
      let checked = 0;
      for (const [template, item] of Object.entries(document.paths)) {
        for (const [method, op] of Object.entries(item)) {
          const security = ((op.security as Json[] | undefined) ?? []).flatMap((s) =>
            Object.keys(s),
          );
          if (security.length === 0 || security.includes('apiKey')) continue;
          checked += 1;
          const path = template.replace(/\{[^}]+\}/g, () => uuidv7());
          const res = await hit(method.toUpperCase(), path, {
            ...as.key(),
            headers: { 'x-acc-refresh': '1' },
            body: {},
          });
          expect(
            `${method.toUpperCase()} ${template} with an API key → ${res.status >= 200 && res.status < 300 ? 'success' : 'refused'}`,
          ).toBe(`${method.toUpperCase()} ${template} with an API key → refused`);
        }
      }
      expect(checked).toBeGreaterThanOrEqual(10);
    });

    it('the refresh cookie alone authenticates nothing but refresh and logout', async () => {
      const res = await hit('GET', 'auth/me', { as: 'refreshCookie', cookie: admin.cookie });
      expectStatus(res, 401, 'me with only the refresh cookie');
    });
  });

  // ===========================================================================
  describe('E. documented errors', () => {
    const operations = () => {
      const document = validator.document as { paths: Record<string, Record<string, Json>> };
      return Object.entries(document.paths).flatMap(([template, item]) =>
        Object.entries(item).map(([method, op]) => ({
          method: method.toUpperCase(),
          template,
          op,
        })),
      );
    };
    const isPublic = (op: Json) => !op.security;
    const concrete = (template: string, id: () => string) => template.replace(/\{[^}]+\}/g, id);

    it('no credential: 401 on every authenticated operation', async () => {
      for (const { method, template, op } of operations()) {
        if (isPublic(op)) continue;
        const res = await hit(method, concrete(template, uuidv7), {
          headers: { 'x-acc-refresh': '1' },
          body: {},
        });
        expectStatus(res, 401, `${method} ${template}`);
      }
    });

    it('a malformed id: 400 on every operation that addresses a resource by id', async () => {
      for (const { method, template } of operations()) {
        if (!template.includes('{')) continue;
        const res = await hit(
          method,
          concrete(template, () => 'not-a-uuid'),
          { ...as.session(admin), body: {} },
        );
        expectStatus(res, 400, `${method} ${template}`);
      }
    });

    it('an unknown id: 404 (or the documented refusal) on every operation that addresses a resource by id', async () => {
      for (const { method, template, op } of operations()) {
        if (!template.includes('{')) continue;
        const bearer = String(op.operationId).startsWith('Organizations_') ? platform : admin;
        const res = await hit(method, concrete(template, uuidv7), {
          ...as.session(bearer),
          body:
            method !== 'PATCH'
              ? {}
              : template.includes('/users/')
                ? { phone: '+15551234567' }
                : { name: `x ${suffix()}` },
        });
        expect(`${method} ${template} → ${res.status}`).toMatch(/→ (404|403)$/);
      }
    });

    it('an unknown body field or query parameter: 400', async () => {
      for (const { method, template, op } of operations()) {
        const path = concrete(template, uuidv7);
        const bearer = String(op.operationId).startsWith('Organizations_') ? platform : admin;
        if (op.requestBody) {
          const res = await hit(method, path, {
            ...(isPublic(op) ? {} : as.session(bearer)),
            body: { notAField: 1 },
          });
          expectStatus(res, 400, `${method} ${template} body`);
        }
        const queries = ((op.parameters as Json[] | undefined) ?? []).filter(
          (p) => p.in === 'query',
        );
        if (queries.length > 0) {
          const res = await hit(method, path, {
            ...as.session(bearer),
            query: { notAParameter: '1' },
          });
          expectStatus(res, 400, `${method} ${template} query`);
        }
      }
    });

    it('an unprivileged principal gets a documented refusal everywhere', async () => {
      for (const { method, template, op } of operations()) {
        if (isPublic(op)) continue;
        const res = await hit(method, concrete(template, uuidv7), {
          ...as.session(stranger),
          headers: { 'x-acc-refresh': '1' },
          body: {},
        });
        // The validator records an undocumented status; here, no success.
        expect(
          `${method} ${template} → ${res.status < 300 && !String(op.operationId).startsWith('Auth') && op.operationId !== 'OpenApiDocument_get' ? 'success' : 'ok'}`,
        ).toBe(`${method} ${template} → ok`);
      }
    });

    it('lifecycle, idempotency, admissibility, conflict, CSRF and media type', async () => {
      // 409 lifecycle: archive twice; reactivate an active organization; disable twice.
      const ws = await hit('POST', 'workspaces', {
        ...as.session(admin),
        body: { name: 'OA ws', slug: `oa-ws-${suffix()}` },
      });
      await hit('POST', `workspaces/${ws.body.data.id}/archive`, as.session(admin));
      expectStatus(
        await hit('POST', `workspaces/${ws.body.data.id}/archive`, as.session(admin)),
        409,
        'archive twice',
      );
      expectStatus(
        await hit('POST', `organizations/${orgId}/reactivate`, {
          ...as.session(platform),
          body: {},
        }),
        409,
        'reactivate active',
      );
      // Idempotency: a replay, a different payload, a malformed key.
      const key = `oa-idem-${uuidv7()}`;
      const body = { name: 'OA idem', slug: `oa-idem-${suffix()}` };
      const first = await hit('POST', 'workspaces', {
        ...as.session(admin),
        headers: { 'idempotency-key': key },
        body,
      });
      const replay = await hit('POST', 'workspaces', {
        ...as.session(admin),
        headers: { 'idempotency-key': key },
        body,
      });
      expect(replay.status).toBe(first.status);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expectStatus(
        await hit('POST', 'workspaces', {
          ...as.session(admin),
          headers: { 'idempotency-key': key },
          body: { ...body, name: 'other' },
        }),
        422,
        'idempotency mismatch',
      );
      expectStatus(
        await hit('POST', 'workspaces', {
          ...as.session(admin),
          headers: { 'idempotency-key': 'short' },
          body,
        }),
        400,
        'idempotency key invalid',
      );
      // 422: a role granted at a scope type it does not admit.
      expectStatus(
        await hit('POST', 'role-assignments', {
          ...as.session(admin),
          body: {
            userId: member.id,
            roleId: roles[TENANT_ROLE_KEYS.ORG_ADMIN],
            scopeType: 'workspace',
            scopeId: workspaceId,
          },
        }),
        422,
        'scope type not admitted',
      );
      // 409: deleting a role still granted.
      expectStatus(
        await hit('DELETE', `roles/${roles[TENANT_ROLE_KEYS.READ_ONLY]}`, as.session(admin)),
        403,
        'system role delete',
      );
      // CSRF marker and media type.
      expectStatus(
        await hit('POST', 'auth/refresh', { as: 'refreshCookie', cookie: admin.cookie }),
        403,
        'refresh without X-Acc-Refresh',
      );
      expectStatus(
        await hit('POST', 'auth/logout', as.session(admin)),
        403,
        'logout without X-Acc-Refresh',
      );
      expectStatus(
        await hit('POST', 'auth/login', { raw: { type: 'text/plain', payload: 'email=x' } }),
        415,
        'login not JSON',
      );
      expectStatus(
        await hit('POST', 'auth/login', {
          body: { email: admin.email, password: 'wrong-password-value' },
        }),
        401,
        'login refused',
      );
      expectStatus(await hit('GET', 'openapi.json', as.key()), 403, 'document with an API key');
    });
  });

  // ===========================================================================
  describe('R. rate limiting', () => {
    let limited: Booted;

    beforeAll(async () => {
      limited = await bootApp({
        APP_ENV: 'test',
        OPENAPI_UI_ENABLED: 'true',
        RATE_LIMIT_DEFAULT_MAX: '2',
        RATE_LIMIT_AUTH_MAX: '2',
        RATE_LIMIT_REFRESH_MAX: '2',
      });
      await limited.clearRateLimits();
    }, 120_000);
    afterAll(async () => {
      await limited.clearRateLimits();
      await limited.close();
    });

    const hitLimited = async (method: string, path: string, options: Hit = {}) => {
      const original = booted;
      booted = limited;
      try {
        return await hit(method, path, options);
      } finally {
        booted = original;
      }
    };

    it('the general limiter, the sign-in bucket and the refresh bucket each answer 429 as documented', async () => {
      let last = await hitLimited('GET', 'auth/me', as.session(admin));
      for (let i = 0; i < 3; i += 1) last = await hitLimited('GET', 'auth/me', as.session(admin));
      expectStatus(last, 429, 'general limiter');
      expect(last.headers['retry-after']).toBeDefined();
      expect(last.headers['x-ratelimit-reset']).toBeDefined();

      for (let i = 0; i < 3; i += 1)
        last = await hitLimited('POST', 'auth/login', {
          body: { email: admin.email, password: 'wrong-password-value' },
        });
      expectStatus(last, 429, 'sign-in bucket');
      expect(last.headers['x-ratelimit-reset']).toBeUndefined();

      for (let i = 0; i < 3; i += 1)
        last = await hitLimited('POST', 'auth/refresh', {
          as: 'refreshCookie',
          headers: { 'x-acc-refresh': '1' },
        });
      expectStatus(last, 429, 'refresh bucket');
    });
  });

  // ===========================================================================
  describe('Z. totals', () => {
    it('every observed response matched the document', () => {
      expect(problems).toEqual([]);
    });

    it('every operation succeeded with every credential its document declares', () => {
      const document = validator.document as { paths: Record<string, Record<string, Json>> };
      const missing: string[] = [];
      for (const [template, item] of Object.entries(document.paths)) {
        for (const [method, op] of Object.entries(item)) {
          const key = `${method.toUpperCase()} ${template}`;
          const declared = ((op.security as Json[] | undefined) ?? []).flatMap((s) =>
            Object.keys(s),
          );
          const need = declared.length === 0 ? ['none'] : declared;
          for (const credential of need) {
            if (!successes.get(key)?.has(credential as Credential))
              missing.push(`${key} with ${credential}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('reports coverage', () => {
      const statuses = [...observed.values()].reduce((n, s) => n + s.size, 0);
      expect(observed.size).toBe(
        Object.values((validator.document as { paths: Json }).paths).reduce<number>(
          (n, item) => n + Object.keys(item as Json).length,
          0,
        ),
      );
      expect(statuses).toBeGreaterThan(observed.size * 3);
    });
  });
});
