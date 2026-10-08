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
import { ScopeChainResolver } from '../src/auth/scope-chain-resolver.service';
import { AppConfigService } from '../src/config/app-config.service';
import { CredentialService } from '../src/iam/credential.service';
import { PROVIDER_CLOCK, type ProviderClock } from '../src/providers/provider-clock';
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
  /**
   * Replaces the provider health/circuit clock (Phase 2.3, `PROVIDER_CLOCK`)
   * with one the suite drives, so windows, cooldowns and leases are crossed
   * exactly, with no wall-clock sleeps. Nothing else is overridden.
   */
  readonly providerClock?: ProviderClock;
  /**
   * Parks every Argon2 verification at a gate the suite opens and closes
   * (ADR-015 R-1 evidence): `CredentialService.verify` — which `verifyDummy`
   * also goes through — waits at `gate.pass()` before the real verification.
   * Lets a suite hold sign-in and API-key authentication *inside* step V and
   * observe what is held meanwhile. Nothing else about the service changes.
   */
  readonly credentialGate?: ArrivalGate;
  /**
   * Parks every authorization ancestry read at a gate (ADR-015 R-12
   * evidence): `ScopeChainResolver.resolve` — which `AuthorizationService.assert`
   * calls inside the caller's tenant transaction — waits at `gate.pass()`, so a
   * suite can hold many requests inside their transactions at once.
   */
  readonly scopeChainGate?: ArrivalGate;
}

/**
 * A gate a suite closes to park callers and opens to release them, counting
 * every arrival (ADR-015 R-1 / R-12 evidence). Open by default, so a harness
 * built with one behaves normally until the suite closes it.
 */
export class ArrivalGate {
  private closed = false;
  private arrivals = 0;
  private parked: (() => void)[] = [];
  private watchers: { count: number; resolve: () => void }[] = [];

  get arrived(): number {
    return this.arrivals;
  }

  close(): void {
    this.closed = true;
    this.arrivals = 0;
  }

  open(): void {
    this.closed = false;
    const parked = this.parked;
    this.parked = [];
    parked.forEach((release) => release());
  }

  async pass(): Promise<void> {
    if (!this.closed) return;
    this.arrivals += 1;
    this.watchers = this.watchers.filter((w) => {
      if (this.arrivals < w.count) return true;
      w.resolve();
      return false;
    });
    await new Promise<void>((release) => this.parked.push(release));
  }

  /** Resolves once `count` callers are parked; rejects after `timeoutMs`. */
  untilArrived(count: number, timeoutMs = 10_000): Promise<void> {
    if (this.arrivals >= count) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`gate: ${this.arrivals} of ${count} arrived`)),
        timeoutMs,
      );
      this.watchers.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }
}

/** `CredentialService` whose verification waits at a gate first (test-only). */
class GatedCredentialService extends CredentialService {
  constructor(
    config: AppConfigService,
    private readonly gate: ArrivalGate,
  ) {
    super(config);
  }

  override async verify(digest: string, plaintext: string): Promise<boolean> {
    await this.gate.pass();
    return super.verify(digest, plaintext);
  }
}

/** `ScopeChainResolver` whose ancestry read waits at a gate first (test-only). */
class GatedScopeChainResolver extends ScopeChainResolver {
  constructor(private readonly gate: ArrivalGate) {
    super();
  }

  override async resolve(
    ...args: Parameters<ScopeChainResolver['resolve']>
  ): ReturnType<ScopeChainResolver['resolve']> {
    await this.gate.pass();
    return super.resolve(...args);
  }
}

/**
 * A provider clock the test moves by hand (Phase 2.3). Starts at the real time,
 * so persisted timestamps stay plausible, and only ever moves when told to.
 */
export class ManualProviderClock implements ProviderClock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [...(options.controllers ?? [])],
  });
  if (options.providerClock) {
    builder = builder.overrideProvider(PROVIDER_CLOCK).useValue(options.providerClock);
  }
  const { credentialGate, scopeChainGate } = options;
  if (credentialGate) {
    builder = builder.overrideProvider(CredentialService).useFactory({
      factory: (config: AppConfigService) => new GatedCredentialService(config, credentialGate),
      inject: [AppConfigService],
    });
  }
  if (scopeChainGate) {
    builder = builder
      .overrideProvider(ScopeChainResolver)
      .useFactory({ factory: () => new GatedScopeChainResolver(scopeChainGate) });
  }
  const moduleRef = await builder.compile();
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

/**
 * Gives a tenant a second active organization administrator — a holder of the
 * tenant's stand-in `org_admin` at organization scope — so a test that removes
 * the fixture user's own administrator grant (or disables it) does not trip
 * the last-organization-administrator rule (ADR-015 R-11, migration `0028`),
 * which is not what such a test is about. The rule is never relaxed for it.
 *
 * The identity never signs in (placeholder credential). Its grant goes with
 * the organization in `destroyTenant`; its user row is removed there too, by
 * the address this helper gives it.
 */
export async function addSpareAdmin(admin: Database, tenant: TenantFixture): Promise<string> {
  const [user] = await admin
    .insert(schema.users)
    .values({
      email: `spare-${tenant.slug}-${uuidv7().replace(/-/g, '').slice(-8)}@example.test`,
      status: 'active',
      passwordHash: 'not-a-login-credential',
    })
    .returning({ id: schema.users.id });
  await admin.insert(schema.userRoles).values({
    userId: user!.id,
    roleId: tenant.roleId,
    scopeType: 'organization',
    scopeId: tenant.orgId,
  });
  return user!.id;
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
  //
  // The organization is deleted rather than emptied grant by grant: its
  // organization-scope grants, roles and role permissions cascade with it,
  // which is the one exemption of the last-organization-administrator rule
  // (migration `0028`) — deleting the last `org_admin` grant of a live
  // organization is refused for the owner as for everyone else.
  await admin.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.provisioning','on',true)`);
    // Grants below organization scope hold their workspace or team (RESTRICT).
    await tx.execute(
      sql`DELETE FROM user_roles WHERE org_id = ${tenant.orgId} AND scope_type <> 'organization'`,
    );
    for (const table of ['ws_tickets', 'api_keys', 'idempotency_keys', 'teams', 'workspaces']) {
      await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${tenant.orgId}`);
    }
    await tx.execute(sql`DELETE FROM organizations WHERE id = ${tenant.orgId}`);
  });
  await admin.execute(sql`DELETE FROM users WHERE id = ${tenant.userId}`);
  await admin.execute(
    sql`DELETE FROM users WHERE email LIKE ${`spare-${tenant.slug}-%@example.test`}`,
  );
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
 * Removes provider health samples (Phase 2.3). `provider_health` is append-only
 * exactly as `audit_logs` is, so — like `purgeAudit` — teardown disables the
 * trigger as the owner, deletes, and re-enables it; a sample holds its
 * provider through a `RESTRICT` foreign key, so this runs before the provider
 * itself is deleted.
 */
export async function purgeProviderHealth(admin: Database, where = sql`true`): Promise<void> {
  await admin.execute(
    sql`ALTER TABLE provider_health DISABLE TRIGGER trg_provider_health_append_only`,
  );
  try {
    await admin.execute(sql`DELETE FROM provider_health WHERE ${where}`);
  } finally {
    await admin.execute(
      sql`ALTER TABLE provider_health ENABLE TRIGGER trg_provider_health_append_only`,
    );
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
