/**
 * Shared harness for the Phase 1B.3 authentication and security suites.
 *
 * Builds a real Nest application against the real database and Redis, and
 * plants two unrelated tenants with real users, grants and passwords — because
 * everything under test (RLS, session state, rotation, grant resolution) lives
 * in PostgreSQL and cannot be demonstrated against a mock.
 */
import { PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS, type ScopeType } from '@acc/contracts';
import { createDatabase, createPool, schema, type Database } from '@acc/db';
import { INestApplication, type Type } from '@nestjs/common';
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

/**
 * Options for a harness instance.
 *
 * `controllers` registers additional controllers alongside the real
 * application. It exists so a globally-registered guard can be exercised over
 * real HTTP against routes the production surface does not yet have — the guard
 * itself, the authentication in front of it and the pipeline around it are all
 * the real ones; only the route it protects is the test's own.
 */
export interface HarnessOptions {
  readonly controllers?: readonly Type<unknown>[];
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [...(options.controllers ?? [])],
  }).compile();
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
      // Every unauthenticated-path bucket: sign-in, refresh and API-key
      // failures (Gate-B audit, Blocker 4). The per-principal general limiter is
      // not touched here; its own suite owns it.
      const keys = [
        ...(await redis.keys('*ratelimit:auth:*')),
        ...(await redis.keys('*ratelimit:refresh:*')),
        ...(await redis.keys('*ratelimit:apikey-fail:*')),
      ];
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

  // `org_admin` is a seeded system role, and migration `0004` makes a system
  // role's definition immutable outside a provisioning or platform-admin
  // transaction. The fixture therefore composes it exactly as
  // `TenantRoleProvisioner` does — declaring `app.provisioning`
  // transaction-locally — rather than the guard being relaxed for tests.
  const role = await admin.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.provisioning','on',true)`);

    const [created] = await tx
      .insert(schema.roles)
      .values({
        orgId: org!.id,
        key: TENANT_ROLE_KEYS.ORG_ADMIN,
        name: 'Organization Admin',
        isSystemRole: true,
        // TEST INFRASTRUCTURE ONLY (Phase 1C.6, decision §14.3). This is the
        // harness's stand-in role, not the seeded production `org_admin`
        // (which admits `organization` only, `TENANT_ROLE_DEFINITIONS`).
        // `createScopedUser` grants it at workspace and team scope for many
        // Gate B fixtures; since migration 0014 the database refuses a grant at
        // a scope its role does not admit, so the stand-in admits all three.
        // Its permissions are unchanged.
        allowedScopeTypes: ['organization', 'workspace', 'team'],
      })
      .returning({ id: schema.roles.id });

    // The org_admin role needs the permissions the tenancy read surface checks.
    for (const key of ['workspaces.read', 'users.read', 'organizations.read']) {
      const [permission] = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, key));
      if (permission) {
        await tx
          .insert(schema.rolePermissions)
          .values({ roleId: created!.id, permissionId: permission.id })
          .onConflictDoNothing();
      }
    }
    return created;
  });

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

/**
 * An additional active user in an existing tenant, holding one grant at the
 * given scope and nothing else.
 *
 * The narrowness is the point: a principal whose only grant is at workspace or
 * team level is the one whose resolved context actually pins those levels, and
 * therefore the only one against which an advisory workspace/team identifier
 * can be cross-checked.
 */
export async function createScopedUser(
  admin: Database,
  tenant: TenantFixture,
  credentials: { hash(p: string): Promise<string> },
  scopeType: Extract<ScopeType, 'organization' | 'workspace' | 'team'>,
  scopeId: string,
  label: string,
): Promise<{ userId: string; email: string }> {
  const email = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;
  const [user] = await admin
    .insert(schema.users)
    .values({
      email,
      status: 'active',
      passwordHash: await credentials.hash(PASSWORD),
      passwordUpdatedAt: new Date(),
    })
    .returning({ id: schema.users.id });

  await admin
    .insert(schema.userRoles)
    .values({ userId: user!.id, roleId: tenant.roleId, scopeType, scopeId });

  return { userId: user!.id, email };
}

/** Removes a user created by `createScopedUser`, with its dependent rows. */
export async function destroyUser(admin: Database, userId: string): Promise<void> {
  await purgeAudit(admin, sql`actor_user_id = ${userId}`);
  await admin.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
  await admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${userId}`);
  await admin.execute(sql`DELETE FROM users WHERE id = ${userId}`);
}

export async function destroyTenant(admin: Database, tenant: TenantFixture): Promise<void> {
  await admin.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`);
  await admin.execute(
    sql`DELETE FROM audit_logs WHERE org_id = ${tenant.orgId} OR actor_user_id = ${tenant.userId} OR reseller_id = ${tenant.resellerId}`,
  );
  await admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);

  await admin.execute(sql`DELETE FROM sessions WHERE user_id = ${tenant.userId}`);
  // System roles and their permission sets are protected by migration `0004`,
  // so teardown declares the same transaction-local provisioning flag the
  // fixture created them under. One transaction, because `SET LOCAL` does not
  // survive a statement on a pooled connection.
  await admin.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.provisioning','on',true)`);
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
      await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${tenant.orgId}`);
    }
  });
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

/**
 * Plants an active identity holding `alendei_super_admin` at platform scope, for
 * tests that run `acc_app` under a platform-admin tenant context.
 *
 * Since migration `0010` the database honours `app.is_platform_admin` for an
 * RLS-bound principal only while `app.current_user_id` actually holds that
 * grant, so a bare `{ isPlatformAdmin: true }` session is — correctly — no
 * longer enough. Planted by the owner under the same transaction-local flag
 * `seed.ts` uses; the credential column is a placeholder because the identity
 * never signs in.
 */
export async function plantPlatformIdentity(admin: Database, label: string): Promise<string> {
  const email = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;
  return admin.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
    const [role] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
          isNull(schema.roles.orgId),
        ),
      );
    const [user] = await tx
      .insert(schema.users)
      .values({ email, status: 'active', passwordHash: 'not-a-login-credential' })
      .returning({ id: schema.users.id });
    await tx
      .insert(schema.userRoles)
      .values({ userId: user!.id, roleId: role!.id, scopeType: 'platform' });
    return user!.id;
  });
}

/**
 * Plants an active identity holding `reseller_admin` at `reseller` scope on
 * `resellerId` — the grant migration `0010` requires before
 * `app.current_reseller_id` is honoured for an RLS-bound principal.
 */
export async function plantResellerIdentity(
  admin: Database,
  resellerId: string,
  label: string,
): Promise<string> {
  const email = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;
  return admin.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
    const [role] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(eq(schema.roles.key, PLATFORM_ROLE_KEYS.RESELLER_ADMIN), isNull(schema.roles.orgId)),
      );
    const [user] = await tx
      .insert(schema.users)
      .values({ email, status: 'active', passwordHash: 'not-a-login-credential' })
      .returning({ id: schema.users.id });
    await tx
      .insert(schema.userRoles)
      .values({ userId: user!.id, roleId: role!.id, scopeType: 'reseller', scopeId: resellerId });
    return user!.id;
  });
}

/**
 * Removes identities planted by the two helpers above. The liveness trigger is
 * disabled for the statement — the same owner capability `purgeAudit` uses —
 * because a planted platform administrator may be the only one in the database.
 */
export async function removeIdentities(admin: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await purgeAudit(
    admin,
    sql`actor_user_id IN (${sql.join(
      userIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  await admin.transaction(async (tx) => {
    await tx.execute(
      sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
    );
    try {
      for (const id of userIds) {
        await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
        await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
        await tx.execute(sql`DELETE FROM users WHERE id = ${id}`);
      }
    } finally {
      await tx.execute(
        sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
    }
  });
}

export const PLATFORM_ROLE = PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN;
export { and, eq, isNull };
