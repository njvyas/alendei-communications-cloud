/**
 * Phase 2.6 support — the provider-console fixture.
 *
 *   npm run fixture:dev --workspace @acc/api        (first: the Phase 1C.4a fixture)
 *   npm run fixture:providers --workspace @acc/api
 *
 * Development and test only, under the same environment gate and inputs as
 * `fixture:dev` (`TESTING.md` §6r, §6v). Idempotent: a second run against a
 * complete fixture changes nothing. Never reachable over HTTP: no module of the
 * application imports it. stdout carries only the JSON manifest (ids and
 * emails, never a credential); progress goes to stderr.
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

  const { runProviderFixture } = await import('./provider-fixture/run');
  const manifest = await runProviderFixture(process.env, (line) =>
    process.stderr.write(`provider fixture: ${line}\n`),
  );
  process.stderr.write(
    manifest.outcome === 'created'
      ? 'provider fixture: created or completed\n'
      : 'provider fixture: already complete — no changes made\n',
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Messages name variables, references and natural keys — never a resolved secret.
    process.stderr.write(
      `Provider fixture refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
