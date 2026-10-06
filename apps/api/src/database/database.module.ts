import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  assertRlsBoundPrincipal,
  createDatabase,
  createPool,
  guardPool,
  type Database,
} from '@acc/db';
import type { Pool } from 'pg';

import { AppConfigService } from '../config/app-config.service';
import { APP_DB, APP_POOL, AUTH_DB, AUTH_POOL } from './database.tokens';
import { TenantDatabase } from './tenant-database.service';

/**
 * Two connection pools, matching the two database principals
 * (`packages/db/migrations` establishes both):
 *
 *   `acc_app`  every tenant-scoped business query, always inside a transaction
 *              that has set its tenant context; Row-Level Security applies.
 *   `acc_auth` identity resolution only — credential verification happens before
 *              any tenant context exists, so it cannot be RLS-filtered by org and
 *              is instead confined by table grants to the identity tables.
 *
 * The schema-owner connection is deliberately absent: the running API has no
 * principal that can bypass RLS.
 *
 * Both pools carry the nested-acquisition guard (ADR-015 R-1, `guardPool`): a
 * context holding a connection may not take a second from the same pool, and
 * may take an `acc_auth` connection under an `acc_app` one but never the
 * reverse. A violation fails at acquisition instead of deadlocking the pool.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Pool =>
        guardPool(
          createPool({
            connectionString: config.database.appUrl,
            max: config.database.poolMax,
            idleTimeoutMillis: config.database.idleTimeoutMs,
            statementTimeoutMillis: config.database.statementTimeoutMs,
            ssl: config.database.ssl,
            applicationName: `${config.serviceName}-app`,
          }),
          'app',
        ),
    },
    {
      provide: APP_DB,
      inject: [APP_POOL],
      useFactory: (pool: Pool): Database => createDatabase(pool),
    },
    {
      provide: AUTH_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Pool =>
        guardPool(
          createPool({
            connectionString: config.database.authUrl,
            // Identity resolution runs on every authenticated request (session
            // and API-key checks) as well as on sign-in, so this pool is on the
            // request path, not a side channel. It is sized separately so it
            // cannot starve the application pool; its connections are never
            // held across password hashing (ADR-015 R-1).
            max: Math.max(2, Math.floor(config.database.poolMax / 2)),
            idleTimeoutMillis: config.database.idleTimeoutMs,
            statementTimeoutMillis: config.database.statementTimeoutMs,
            ssl: config.database.ssl,
            applicationName: `${config.serviceName}-auth`,
          }),
          'auth',
        ),
    },
    {
      provide: AUTH_DB,
      inject: [AUTH_POOL],
      useFactory: (pool: Pool): Database => createDatabase(pool),
    },
    TenantDatabase,
  ],
  exports: [APP_POOL, APP_DB, AUTH_POOL, AUTH_DB, TenantDatabase],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @Inject(APP_POOL) private readonly appPool: Pool,
    @Inject(AUTH_POOL) private readonly authPool: Pool,
  ) {}

  /**
   * Refuses to serve with a pool whose principal RLS would not bind (Gate-B
   * audit, Blocker 2): a superuser, a `BYPASSRLS` role, an owner (or member of
   * the owner) of any `public` table, or a member of any other role. The check
   * reads the catalog as the pool's own principal, so it reports what the
   * connection string actually logs in as, not what configuration claims.
   */
  async onModuleInit(): Promise<void> {
    const app = await assertRlsBoundPrincipal(this.appPool, 'application (acc_app)');
    const auth = await assertRlsBoundPrincipal(this.authPool, 'identity (acc_auth)');
    this.logger.log(`Database principals verified RLS-bound: ${app.role}, ${auth.role}`);
  }

  /** Drains both pools so in-flight statements finish before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.appPool.end(), this.authPool.end()]);
    this.logger.log('Database pools closed');
  }
}
