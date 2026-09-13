/**
 * Shared harness for the Phase 1B.3 authentication and security suites.
 *
 * Builds a real Nest application against the real database and Redis, and
 * plants two unrelated tenants with real users, grants and passwords — because
 * everything under test (RLS, session state, rotation, grant resolution) lives
 * in PostgreSQL and cannot be demonstrated against a mock.
 */
import { PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { createDatabase, createPool, schema, type Database } from '@acc/db';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, isNull, sql } from 'drizzle-orm';
import cookieParser from 'cookie-parser';
import { uuidv7 } from 'uuidv7';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { validationPipe } from '../src/common/http/validation.pipe';
import { AccessTokenService } from '../src/auth/jwt.service';
import { REDIS_CLIENT } from '../src/redis/redis.module';

export const PASSWORD = 'a-sufficiently-long-test-passphrase';
export const PREFIX = 'api/v1';

export interface TenantFixture {
  readonly resellerId: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly email: string;
  readonly roleId: string;
  readonly slug: string;
}

export interface Harness {
  readonly app: INestApplication;
  readonly admin: Database;
  readonly jwt: AccessTokenService;
  /**
   * Clears the authentication rate-limit buckets.
   *
   * The suite drives many logins from one address, which the limiter correctly
   * throttles — so tests that are not *about* rate limiting reset the window
   * first. This clears counters only; the limiter itself is never disabled, and
   * the dedicated rate-limiting tests deliberately do not call it.
   */
  clearRateLimits(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.use(cookieParser());
  app.useGlobalPipes(validationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix(PREFIX, { exclude: ['metrics', 'health', 'health/live', 'health/ready'] });
  await app.init();

  const pool = createPool({
    connectionString: process.env.DATABASE_ADMIN_URL!,
    max: 4,
    applicationName: 'acc-test-auth',
  });
  const admin = createDatabase(pool);

  const redis = app.get(REDIS_CLIENT) as {
    keys(p: string): Promise<string[]>;
    del(...k: string[]): Promise<number>;
  };

  return {
    app,
    admin,
    jwt: app.get(AccessTokenService),
    async clearRateLimits() {
      const keys = await redis.keys('*ratelimit:auth:*');
      if (keys.length > 0) await redis.del(...keys);
    },
    async close() {
      await pool.end();
      await app.close();
    },
  };
}

/** A tenant with an active user holding `org_admin` at organization scope. */
export async function createTenant(
  admin: Database,
  label: string,
  credentials: { hash(p: string): Promise<string> },
): Promise<TenantFixture> {
  const slug = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}`;
  const digest = await credentials.hash(PASSWORD);

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

  const email = `${slug}@example.test`;
  const [user] = await admin
    .insert(schema.users)
    .values({ email, status: 'active', passwordHash: digest, passwordUpdatedAt: new Date() })
    .returning({ id: schema.users.id });

  const [role] = await admin
    .insert(schema.roles)
    .values({
      orgId: org!.id,
      key: TENANT_ROLE_KEYS.ORG_ADMIN,
      name: 'Organization Admin',
      isSystemRole: true,
    })
    .returning({ id: schema.roles.id });

  // The org_admin role needs the permissions the tenancy read surface checks.
  for (const key of ['workspaces.read', 'users.read', 'organizations.read']) {
    const [permission] = await admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, key));
    if (permission) {
      await admin
        .insert(schema.rolePermissions)
        .values({ roleId: role!.id, permissionId: permission.id })
        .onConflictDoNothing();
    }
  }

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
    email,
    roleId: role!.id,
    slug,
  };
}

/** Grants an existing user an additional org_admin role in another tenant. */
export async function grantInto(
  admin: Database,
  userId: string,
  tenant: TenantFixture,
): Promise<void> {
  await admin.execute(sql`select set_config('app.is_platform_admin','on',true)`);
  await admin.insert(schema.userRoles).values({
    userId,
    roleId: tenant.roleId,
    scopeType: 'organization',
    scopeId: tenant.orgId,
  });
}

export async function destroyTenant(admin: Database, tenant: TenantFixture): Promise<void> {
  await admin.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`);
  await admin.execute(
    sql`DELETE FROM audit_logs WHERE org_id = ${tenant.orgId} OR actor_user_id = ${tenant.userId} OR reseller_id = ${tenant.resellerId}`,
  );
  await admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);

  await admin.execute(sql`DELETE FROM sessions WHERE user_id = ${tenant.userId}`);
  for (const table of [
    'user_roles',
    'role_permissions',
    'roles',
    'ws_tickets',
    'api_keys',
    'idempotency_keys',
    'teams',
    'workspaces',
  ]) {
    await admin.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${tenant.orgId}`);
  }
  await admin.execute(sql`DELETE FROM users WHERE id = ${tenant.userId}`);
  await admin.execute(sql`DELETE FROM organizations WHERE id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM resellers WHERE id = ${tenant.resellerId}`);
}

/** Purges audit rows written by a test, as the owner. */
export async function purgeAudit(admin: Database, where = sql`true`): Promise<void> {
  await admin.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`);
  try {
    await admin.execute(sql`DELETE FROM audit_logs WHERE ${where}`);
  } finally {
    await admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
  }
}

export const PLATFORM_ROLE = PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN;
export { and, eq, isNull };
