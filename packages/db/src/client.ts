import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';
import { tenantContextStatements, type TenantSession } from './tenant-context';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
  readonly ssl?: boolean;
  readonly applicationName?: string;
}

export function createPool(options: PoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? 'acc',
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    ...(options.statementTimeoutMillis
      ? { statement_timeout: options.statementTimeoutMillis }
      : {}),
  };
  return new Pool(config);
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema, casing: 'snake_case' });
}

/**
 * Run `work` inside one transaction with tenant context established
 * (`TENANCY.md` §5 steps 4-7).
 *
 * This is the only sanctioned shape for tenant-scoped database access, for HTTP
 * handlers and background workers alike. Because the context is written with
 * `SET LOCAL`, it is discarded when the transaction ends — on commit *and* on
 * rollback — so a pooled connection can never carry one tenant's context into
 * another tenant's work, including down an error path.
 */
export async function withTenantTransaction<T>(
  db: Database,
  session: TenantSession,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    for (const statement of tenantContextStatements(session)) {
      await tx.execute(statement);
    }
    return work(tx);
  });
}
