/**
 * `npm run db:roles:reconcile` — the explicit, separately invoked command that
 * grants LOGIN and sets the passwords of acc_app, acc_auth, acc_relay and
 * acc_dispatch. Cluster-global: it affects every database on the server.
 *
 * Guards (see `planRoleReconcile`): explicit target confirmation
 * (`ACC_ROLE_RECONCILE_TARGET` = the database named by `DATABASE_ADMIN_URL`),
 * no clone/throwaway/reference database, no test context except an ephemeral
 * CI container, and every password variable present — there is no fallback.
 */
import { Pool } from 'pg';

import { loadCliEnv } from './_env';
import { planRoleReconcile, reconcileRoles } from './role-reconcile';

async function main(): Promise<void> {
  loadCliEnv();
  const plan = planRoleReconcile(process.env);

  const pool = new Pool({
    connectionString: process.env.DATABASE_ADMIN_URL,
    max: 1,
    application_name: 'acc-roles-reconcile',
  });
  try {
    await reconcileRoles(pool, plan.credentials);
    console.log(
      `Roles reconciled (cluster-wide, via ${plan.database}): ${plan.credentials.map((c) => c.role).join(', ')}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
