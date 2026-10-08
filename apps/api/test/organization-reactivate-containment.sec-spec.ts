/**
 * `POST /organizations/:id/reactivate` — refusal and transaction boundary
 * (Gate C M02/M03 coverage-boundary audit).
 *
 * Suspend and close were proven contained under M03 directly; reactivate shares
 * `OrganizationAdministrationService.transition`, but its organization-
 * administrator caller never reaches that transaction, so this suite proves the
 * route on its own terms:
 *
 *   A. the organization administrator of the suspended organization is refused
 *      by status enforcement (`address()` → `organizationInactiveError`, or the
 *      guard before it) — before `transition` opens a transaction;
 *   B. the only non-authorized principal status enforcement lets through — a
 *      platform-grant holder without `platform.tenants.manage`
 *      (`alendei_support`) — is refused by the lifecycle check inside it;
 *   C. the authorized reactivation runs `begin → update organizations → audit
 *      → commit` in one `TenantDatabase.withTenant` transaction.
 *
 * Every case reads the whole database before and after the request, not only
 * the status code.
 */
import { AUDIT_ACTIONS, ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

describe('organization reactivate — refusal and transaction boundary', () => {
  let h: Harness;
  let credentials: CredentialService;
  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  let resellerId: string;
  let suspended: { orgId: string; admin: { userId: string; email: string } };
  let support: { userId: string; email: string };
  let platform: { userId: string; email: string };

  async function createUser(label: string) {
    const email = `${label}-${suffix()}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    createdUsers.push(u!.id);
    return { userId: u!.id, email };
  }

  async function grant(
    userId: string,
    roleId: string,
    scopeType: 'platform' | 'organization',
    scopeId: string | null,
  ) {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({ userId, roleId, scopeType, scopeId });
    });
  }

  async function platformRole(key: string) {
    const [r] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return r!.id;
  }

  /** A suspended organization with provisioned roles and an organization administrator. */
  async function plantSuspendedOrg() {
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({
        name: 'O react',
        slug: `o-react-${suffix()}`,
        resellerId,
        status: 'suspended',
        statusReason: 'fixture',
      })
      .returning({ id: schema.organizations.id });
    const orgId = org!.id;
    createdOrgs.push(orgId);
    await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: 'Default', slug: 'default', isDefault: true });
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await h.app
        .get(TenantRoleProvisioner)
        .seedTenantRoles(tx as unknown as Transaction, orgId, { correlationId: uuidv7() });
    });
    const [adminRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.key, TENANT_ROLE_KEYS.ORG_ADMIN)));
    const admin = await createUser('react-org-admin');
    await grant(admin.userId, adminRole!.id, 'organization', orgId);
    return { orgId, admin };
  }

  async function login(email: string) {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const reactivate = (token: string, orgId: string) =>
    request(h.app.getHttpServer())
      .post(url(`/organizations/${orgId}/reactivate`))
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'reactivate-proof' });

  /**
   * A content digest of every table. `sessions.last_used_at` and the
   * `updated_at` its trigger bumps are excluded: the authentication guard
   * touches them on every request, before any handler runs, and they are not
   * part of the route's mutation.
   */
  async function digest(): Promise<Record<string, string>> {
    const { rows: tables } = await h.admin.execute<{ name: string; table: string }>(
      sql`select format('%I.%I', schemaname, tablename) as name, tablename as table
          from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by 1`,
    );
    const out: Record<string, string> = {};
    for (const { name, table } of tables) {
      const row =
        table === 'sessions'
          ? sql.raw(`(to_jsonb(x) - 'last_used_at' - 'updated_at')::text`)
          : sql.raw(`x::text`);
      const { rows } = await h.admin.execute<{ d: string }>(
        sql`select count(*) || ':' || coalesce(md5(string_agg(${row}, E'\n' order by ${row})), '') as d
            from ${sql.raw(name)} x`,
      );
      out[name] = rows[0]!.d;
    }
    return out;
  }

  const changedTables = (before: Record<string, string>, after: Record<string, string>) =>
    Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);

  const orgRow = async (id: string) =>
    (
      await h.admin
        .select({
          status: schema.organizations.status,
          statusReason: schema.organizations.statusReason,
          statusChangedAt: schema.organizations.statusChangedAt,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, id))
    )[0]!;

  const auditRows = async (orgId: string, action: string) =>
    (
      await h.admin.execute<{ actor_user_id: string; outcome: string }>(
        sql`select actor_user_id, outcome from audit_logs where org_id = ${orgId} and action = ${action}`,
      )
    ).rows;

  /** Every statement the application's pool clients send while `work` runs. */
  async function traced(work: () => Promise<unknown>) {
    const entries: { client: object; text: string; values: unknown[] }[] = [];
    const original = Client.prototype.query;
    Client.prototype.query = function (this: object, ...args: unknown[]) {
      const first = args[0] as string | { text?: string; values?: unknown[] } | undefined;
      const text = typeof first === 'string' ? first : (first?.text ?? '');
      const values =
        (typeof first === 'object' ? first?.values : undefined) ??
        (Array.isArray(args[1]) ? (args[1] as unknown[]) : []);
      entries.push({ client: this, text, values });
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    try {
      await work();
    } finally {
      Client.prototype.query = original;
    }
    return entries;
  }

  /** The statements of the transaction that updated organization `orgId`, or `null`. */
  function lifecycleTransaction(entries: Awaited<ReturnType<typeof traced>>, orgId: string) {
    const write = entries.findIndex(
      (e) => /^update "organizations"/i.test(e.text.trim()) && e.values.includes(orgId),
    );
    if (write < 0) return null;
    const own = entries
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.client === entries[write]!.client);
    const at = own.findIndex((e) => e.i === write);
    const begin = own.slice(0, at).findLast((e) => /^\s*begin\b/i.test(e.text))!;
    const end = own.slice(at + 1).find((e) => /^\s*(commit|rollback)\b/i.test(e.text))!;
    return own.filter((e) => e.i >= begin.i && e.i <= end.i).map((e) => e.text.trim());
  }

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    const [r] = await h.admin
      .insert(schema.resellers)
      .values({ name: 'R react', slug: `rs-react-${suffix()}` })
      .returning({ id: schema.resellers.id });
    resellerId = r!.id;
    suspended = await plantSuspendedOrg();
    support = await createUser('react-support');
    await grant(
      support.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    platform = await createUser('react-platform');
    await grant(
      platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
  }, 120_000);

  afterAll(async () => {
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
    await purgeAudit(
      h.admin,
      sql`org_id IN (${list(createdOrgs)}) OR actor_user_id IN (${list(createdUsers)}) OR reseller_id = ${resellerId}`,
    );
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(
          sql`DELETE FROM user_roles WHERE (user_id IN (${list(createdUsers)}) OR org_id IN (${list(createdOrgs)})) AND NOT (scope_type = 'organization' AND org_id IN (${list(createdOrgs)}))`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      for (const table of ['workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(createdOrgs)})`);
      }
      // The organizations go inside this provisioning transaction: their
      // organization-scope grants, roles and role permissions cascade with them,
      // the one exemption of the last-organization-administrator rule (0028).
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${list(createdOrgs)})`);
    });
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.execute(sql`DELETE FROM organizations WHERE id IN (${list(createdOrgs)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.delete(schema.resellers).where(eq(schema.resellers.id, resellerId));
    await h.close();
  }, 120_000);

  it('A. the suspended organization’s administrator is refused by status enforcement; nothing changes', async () => {
    const token = await login(suspended.admin.email);
    const stateBefore = await orgRow(suspended.orgId);
    const before = await digest();
    let res: request.Response | undefined;
    const trace = await traced(async () => {
      res = await reactivate(token, suspended.orgId);
    });
    const after = await digest();

    expect(res!.status).toBe(403);
    expect(res!.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);
    // Refused before `transition` opened its transaction: no lifecycle UPDATE
    // was ever sent.
    expect(lifecycleTransaction(trace, suspended.orgId)).toBeNull();
    expect(await orgRow(suspended.orgId)).toEqual(stateBefore);
    expect(await auditRows(suspended.orgId, AUDIT_ACTIONS.ORGANIZATION_REACTIVATED)).toEqual([]);
    expect(changedTables(before, after)).toEqual([]);
  });

  it('B. a platform principal without platform.tenants.manage is refused inside the transaction; only its denial record remains', async () => {
    const token = await login(support.email);
    const stateBefore = await orgRow(suspended.orgId);
    const before = await digest();
    let res: request.Response | undefined;
    const trace = await traced(async () => {
      res = await reactivate(token, suspended.orgId);
    });
    const after = await digest();

    expect(res!.status).toBe(403);
    expect(res!.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    expect(lifecycleTransaction(trace, suspended.orgId)).toBeNull();
    expect(await orgRow(suspended.orgId)).toEqual(stateBefore);
    expect(await auditRows(suspended.orgId, AUDIT_ACTIONS.ORGANIZATION_REACTIVATED)).toEqual([]);
    // The one permitted change is the committed `authorization.denied` row.
    expect(changedTables(before, after)).toEqual(['public.audit_logs']);
    const denied = (
      await h.admin.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_logs
            where action = ${AUDIT_ACTIONS.AUTHORIZATION_DENIED} and actor_user_id = ${support.userId}`,
      )
    ).rows[0]!.n;
    expect(denied).toBe(1);
  });

  it('C. the authorized reactivation commits in one withTenant transaction, after its check', async () => {
    const token = await login(platform.email);
    let res: request.Response | undefined;
    const trace = await traced(async () => {
      res = await reactivate(token, suspended.orgId);
    });

    expect(res!.status).toBe(200);
    const tx = lifecycleTransaction(trace, suspended.orgId)!;
    expect(tx).not.toBeNull();
    // begin → tenant context → … → the lifecycle UPDATE → its audit row → commit.
    expect(tx[0]).toMatch(/^begin/i);
    expect(tx.some((t) => t.includes('set_config'))).toBe(true);
    const update = tx.findIndex((t) => /^update "organizations"/i.test(t));
    const audit = tx.findIndex((t) => /^insert into "audit_logs"/i.test(t));
    expect(audit).toBeGreaterThan(update);
    expect(tx.at(-1)).toMatch(/^commit/i);
    // The declared permission was checked, so the pre-commit coverage check
    // returns before probing the transaction.
    expect(tx.some((t) => t.includes('pg_current_xact_id_if_assigned'))).toBe(false);

    expect(await orgRow(suspended.orgId)).toMatchObject({
      status: 'active',
      statusReason: 'reactivate-proof',
    });
    const reactivated = await auditRows(suspended.orgId, AUDIT_ACTIONS.ORGANIZATION_REACTIVATED);
    expect(reactivated).toEqual([{ actor_user_id: platform.userId, outcome: 'success' }]);
  });
});
