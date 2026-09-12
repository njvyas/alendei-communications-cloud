import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, createPool, type Database } from '@acc/db';
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
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Pool =>
        createPool({
          connectionString: config.database.appUrl,
          max: config.database.poolMax,
          idleTimeoutMillis: config.database.idleTimeoutMs,
          statementTimeoutMillis: config.database.statementTimeoutMs,
          ssl: config.database.ssl,
          applicationName: `${config.serviceName}-app`,
        }),
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
        createPool({
          connectionString: config.database.authUrl,
          // Identity resolution is a small fraction of traffic and must never
          // starve the application pool.
          max: Math.max(2, Math.floor(config.database.poolMax / 2)),
          idleTimeoutMillis: config.database.idleTimeoutMs,
          statementTimeoutMillis: config.database.statementTimeoutMs,
          ssl: config.database.ssl,
          applicationName: `${config.serviceName}-auth`,
        }),
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
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @Inject(APP_POOL) private readonly appPool: Pool,
    @Inject(AUTH_POOL) private readonly authPool: Pool,
  ) {}

  /** Drains both pools so in-flight statements finish before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.appPool.end(), this.authPool.end()]);
    this.logger.log('Database pools closed');
  }
}
