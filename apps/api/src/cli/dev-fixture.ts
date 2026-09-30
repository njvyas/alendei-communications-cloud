/**
 * Phase 1C.4a — deterministic development/test fixture and bootstrap command.
 *
 *   npm run fixture:dev --workspace @acc/api
 *
 * Development and test only (`APP_ENV=development` or `test`; anything else,
 * including an unset value, is refused with no override). Idempotent: a second
 * run against a complete fixture changes nothing. See `TESTING.md` §6r for the
 * topology, the inputs, the two owner-level exceptions and the reset procedure.
 *
 * Like the bootstrap CLI, this is an operator tool, never reachable over HTTP:
 * no module of the application imports it. stdout carries only the JSON
 * manifest (ids and emails, never a credential); progress goes to stderr.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import { assertFixtureEnvironment } from './dev-fixture/environment';

function loadCliEnv(): void {
  loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
  loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true, override: false });
}

async function main(): Promise<void> {
  loadCliEnv();
  // Decided before the fixture module — and through it the database client and
  // the application — is even loaded.
  assertFixtureEnvironment(process.env);

  const { runDevFixture } = await import('./dev-fixture/run');
  const manifest = await runDevFixture(process.env, (line) =>
    process.stderr.write(`fixture: ${line}\n`),
  );
  process.stderr.write(
    manifest.outcome === 'created'
      ? 'fixture: created or completed\n'
      : 'fixture: already complete — no changes made\n',
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Messages name variables, references and natural keys — never a resolved secret.
    process.stderr.write(
      `Fixture refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
