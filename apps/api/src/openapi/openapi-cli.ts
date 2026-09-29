/**
 * The OpenAPI generator and drift check (Phase 1C.3 ADR, "Snapshot and CI").
 *
 *   node dist/openapi/openapi-cli.js write   regenerate apps/api/openapi/openapi.v1.json
 *   node dist/openapi/openapi-cli.js check   generate into a temporary file, compare
 *                                            with the committed snapshot, exit 1 on any
 *                                            difference (never writes the snapshot)
 *
 * Runs on `tsc` output, because Nest and the Swagger scanner need decorator
 * metadata (which `tsx`/esbuild does not emit). The module graph is built in
 * Nest's preview mode — no provider is instantiated, so nothing connects to a
 * database, Redis or Kafka — under a fixed configuration, so the document never
 * depends on the machine it is generated on. `write` refuses to run in CI.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SNAPSHOT = resolve(__dirname, '../../openapi/openapi.v1.json');
const RELATIVE_SNAPSHOT = 'apps/api/openapi/openapi.v1.json';

/** Placeholders only: preview mode opens no connection, and nothing is read from them. */
const FIXED_ENV: Readonly<Record<string, string>> = {
  APP_ENV: 'test',
  OPENAPI_UI_ENABLED: 'true',
  API_GLOBAL_PREFIX: 'api/v1',
  DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:1/openapi',
  DATABASE_AUTH_URL: 'postgres://openapi:openapi@127.0.0.1:1/openapi',
  REDIS_URL: 'redis://127.0.0.1:1',
  KAFKA_BROKERS: '127.0.0.1:1',
  SECRETS_BACKEND: 'env',
  AUTH_JWT_SECRET_REF: 'env:ACC_OPENAPI_GENERATOR_UNUSED',
  LOG_LEVEL: 'error',
  LOG_PRETTY: 'false',
  OTEL_ENABLED: 'false',
};

async function generate(): Promise<string> {
  Object.assign(process.env, FIXED_ENV);
  /* eslint-disable @typescript-eslint/no-require-imports -- loaded after FIXED_ENV is in place */
  const { NestFactory } = require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } = require('../app.module') as typeof import('../app.module');
  const { UNPREFIXED_ROUTES } = require('../app.factory') as typeof import('../app.factory');
  const { buildOpenApiDocument } =
    require('./openapi-document') as typeof import('./openapi-document');
  const { serializeOpenApiDocument } =
    require('./openapi-normalize') as typeof import('./openapi-normalize');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix(FIXED_ENV.API_GLOBAL_PREFIX!, { exclude: [...UNPREFIXED_ROUTES] });
  try {
    return serializeOpenApiDocument(await buildOpenApiDocument(app));
  } finally {
    await app.close();
  }
}

async function main(mode: string | undefined): Promise<number> {
  if (mode === 'write') {
    if (process.env.CI) {
      process.stderr.write('openapi write refuses to run in CI; use `check`.\n');
      return 1;
    }
    writeFileSync(SNAPSHOT, await generate());
    process.stdout.write(`wrote ${RELATIVE_SNAPSHOT}\n`);
    return 0;
  }
  if (mode === 'check') {
    const temp = mkdtempSync(join(tmpdir(), 'acc-openapi-'));
    try {
      const fresh = join(temp, 'openapi.v1.json');
      writeFileSync(fresh, await generate());
      const generated = readFileSync(fresh, 'utf8');
      let committed: string;
      try {
        committed = readFileSync(SNAPSHOT, 'utf8');
      } catch {
        process.stderr.write(`${RELATIVE_SNAPSHOT} is missing.\n`);
        return 1;
      }
      if (generated !== committed) {
        process.stderr.write(
          `${RELATIVE_SNAPSHOT} differs from the generated document. Regenerate it with ` +
            '`npm run openapi:generate`, review the diff, and commit it.\n',
        );
        process.stderr.write(firstDifference(committed, generated));
        return 1;
      }
      process.stdout.write(`${RELATIVE_SNAPSHOT} matches the generated document.\n`);
      return 0;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  process.stderr.write('usage: openapi-cli.js <write|check>\n');
  return 2;
}

function firstDifference(committed: string, generated: string): string {
  const a = committed.split('\n');
  const b = generated.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `first difference at line ${i + 1}:\n  committed: ${a[i] ?? '<end>'}\n  generated: ${b[i] ?? '<end>'}\n`;
    }
  }
  return '';
}

void main(process.argv[2]).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
