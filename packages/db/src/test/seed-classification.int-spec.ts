/**
 * ADR-015 R-5: `seed.ts` writes each permission's classification and
 * allowed-scope set from `packages/contracts` — on insert and on every re-run —
 * so a drifted catalogue row is put back, not silently kept.
 *
 * The seed is run for real (`tsx src/cli/seed.ts`) against this database. It is
 * idempotent; the only rows it rewrites are the platform reference data, which
 * it rebuilds to the contracts' definitions.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';

import { connect, loadTestEnv, type Principals } from './harness';

const run = promisify(execFile);
const PACKAGE_ROOT = resolve(__dirname, '../..');

describe('seed.ts writes the classification and allowed scopes from packages/contracts', () => {
  let db: Principals;

  beforeAll(() => {
    loadTestEnv();
    db = connect();
  });

  afterAll(async () => {
    await db.close();
  });

  const row = async (key: string) =>
    (
      await db.admin.execute<{ classification: string; scopes: string }>(
        sql`SELECT classification, allowed_scope_types::text AS scopes FROM permissions WHERE key = ${key}`,
      )
    ).rows[0];

  it('a drifted classification and a drifted scope set are restored by a re-run', async () => {
    // Drift that every CHECK and guard admits: no role carries contacts.read,
    // and providers.read keeps its scope set.
    await db.admin.execute(
      sql`UPDATE permissions SET classification = 'tenancy_administration' WHERE key = 'providers.read'`,
    );
    await db.admin.execute(
      sql`UPDATE permissions SET allowed_scope_types = '{organization}' WHERE key = 'contacts.read'`,
    );
    expect(await row('providers.read')).toEqual({
      classification: 'tenancy_administration',
      scopes: '{platform,reseller,organization,workspace,team}',
    });
    expect(await row('contacts.read')).toEqual({
      classification: 'tenant_content',
      scopes: '{organization}',
    });

    const { stdout } = await run('npx', ['tsx', 'src/cli/seed.ts'], {
      cwd: PACKAGE_ROOT,
      env: process.env,
      timeout: 120_000,
    });
    expect(stdout).toContain('Permissions seeded: 46');
    expect(stdout).toContain('Platform role seeded: alendei_super_admin (38 permissions)');

    expect(await row('providers.read')).toEqual({
      classification: 'platform_catalogue',
      scopes: '{platform,reseller,organization,workspace,team}',
    });
    expect(await row('contacts.read')).toEqual({
      classification: 'tenant_content',
      scopes: '{organization,workspace}',
    });
  }, 150_000);
});
