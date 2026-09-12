/**
 * Integration-test harness.
 *
 * Tests here deliberately talk to a real PostgreSQL instance: the guarantees
 * under test — Row-Level Security, the scope-integrity trigger, check
 * constraints — exist only in the database and cannot be demonstrated against a
 * mock (`TESTING.md` §1).
 *
 * Three connection principals mirror production exactly:
 *   `admin` the schema owner, used only to plant fixtures across tenants
 *   `app`   the RLS-enforced application role every business query uses
 *   `auth`  the identity-resolution role used before tenant context exists
 */
import { config as loadEnv } from 'dotenv';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import * as schema from '../schema';
import { tenantContextStatements, type TenantSession } from '../tenant-context';

export function loadTestEnv(): void {
  loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
  loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true, override: false });
}

export type Db = NodePgDatabase<typeof schema>;

export interface Principals {
  readonly adminPool: Pool;
  readonly appPool: Pool;
  readonly authPool: Pool;
  readonly admin: Db;
  readonly app: Db;
  readonly auth: Db;
  close(): Promise<void>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run integration tests`);
  return value;
}

export function connect(): Principals {
  loadTestEnv();
  const make = (url: string, name: string): Pool =>
    new Pool({ connectionString: url, max: 4, application_name: name });

  const adminPool = make(requireEnv('DATABASE_ADMIN_URL'), 'acc-test-admin');
  const appPool = make(requireEnv('DATABASE_URL'), 'acc-test-app');
  const authPool = make(requireEnv('DATABASE_AUTH_URL'), 'acc-test-auth');

  const wrap = (pool: Pool): Db => drizzle(pool, { schema, casing: 'snake_case' });

  return {
    adminPool,
    appPool,
    authPool,
    admin: wrap(adminPool),
    app: wrap(appPool),
    auth: wrap(authPool),
    async close() {
      await Promise.all([adminPool.end(), appPool.end(), authPool.end()]);
    },
  };
}

/**
 * Runs `work` as the application role with the given tenant context, exactly as
 * a request handler or worker would (`TENANCY.md` §5).
 */
export async function asTenant<T>(
  db: Db,
  session: TenantSession,
  work: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    for (const statement of tenantContextStatements(session)) {
      await tx.execute(statement);
    }
    return work(tx);
  });
}

/** Two fully-populated, unrelated tenants, planted with owner privileges. */
export interface TenantFixture {
  readonly resellerId: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly slug: string;
}

export async function createTenant(admin: Db, label: string): Promise<TenantFixture> {
  const slug = `${label}-${uuidv7().slice(0, 8)}`;

  const [reseller] = await admin
    .insert(schema.resellers)
    .values({ name: `Reseller ${slug}`, slug: `rs-${slug}` })
    .returning({ id: schema.resellers.id });
  const [org] = await admin
    .insert(schema.organizations)
    .values({ name: `Org ${slug}`, slug: `org-${slug}`, resellerId: reseller!.id })
    .returning({ id: schema.organizations.id });
  const [workspace] = await admin
    .insert(schema.workspaces)
    .values({ orgId: org!.id, name: 'Default', slug: 'default', isDefault: true })
    .returning({ id: schema.workspaces.id });
  const [team] = await admin
    .insert(schema.teams)
    .values({ orgId: org!.id, workspaceId: workspace!.id, name: 'Support' })
    .returning({ id: schema.teams.id });
  const [user] = await admin
    .insert(schema.users)
    .values({ email: `${slug}@example.test`, status: 'invited' })
    .returning({ id: schema.users.id });
  const [role] = await admin
    .insert(schema.roles)
    .values({ orgId: org!.id, key: 'org_admin', name: 'Organization Admin', isSystemRole: true })
    .returning({ id: schema.roles.id });

  await admin.insert(schema.userRoles).values({
    userId: user!.id,
    roleId: role!.id,
    scopeType: 'organization',
    scopeId: org!.id,
  });

  return {
    resellerId: reseller!.id,
    orgId: org!.id,
    workspaceId: workspace!.id,
    teamId: team!.id,
    userId: user!.id,
    roleId: role!.id,
    slug,
  };
}

/** Removes a fixture tenant and everything under it. */
export async function destroyTenant(admin: Db, tenant: TenantFixture): Promise<void> {
  await admin.execute(sql`DELETE FROM user_roles WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM role_permissions WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM roles WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM ws_tickets WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM api_keys WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM idempotency_keys WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM teams WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM workspaces WHERE org_id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM users WHERE id = ${tenant.userId}`);
  await admin.execute(sql`DELETE FROM organizations WHERE id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM resellers WHERE id = ${tenant.resellerId}`);
}
