#!/usr/bin/env node
/**
 * Runs one command against a disposable copy of the test database
 * (TESTING.md §6q, "Isolation for mutation runs").
 *
 *   node scripts/with-db-clone.mjs -- npm run test:security --workspace @acc/api
 *
 * The template is the database named in DATABASE_ADMIN_URL. The script
 *   1. fingerprints the template (the exact row count of every table),
 *   2. creates `CREATE DATABASE <clone> TEMPLATE <template>`,
 *   3. runs the command with all four DATABASE_*_URL variables pointed at the
 *      clone, so nothing the command does — including rows a failing or
 *      interrupted test leaves behind — can reach the template,
 *   4. drops the clone `WITH (FORCE)` on every exit path and verifies it is gone,
 *   5. fingerprints the template again and fails if anything changed.
 *
 * It exits with the command's status, or 1 if the clone could not be removed or
 * the template changed. Test-only: it refuses a production APP_ENV.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const URL_VARIABLES = [
  'DATABASE_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_ADMIN_URL',
  'DATABASE_RELAY_URL',
];

function fail(message) {
  console.error(`with-db-clone: ${message}`);
  process.exit(1);
}

const separator = process.argv.indexOf('--');
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length === 0) fail('usage: node scripts/with-db-clone.mjs -- <command> [args...]');
if (process.env.APP_ENV === 'production') fail('refusing to run with APP_ENV=production');
for (const name of URL_VARIABLES) if (!process.env[name]) fail(`${name} is not set`);

const databaseOf = (url) => decodeURIComponent(new URL(url).pathname.slice(1));
const template = databaseOf(process.env.DATABASE_ADMIN_URL);
for (const name of URL_VARIABLES) {
  if (databaseOf(process.env[name]) !== template) {
    fail(`${name} names database "${databaseOf(process.env[name])}", not "${template}"`);
  }
}
const clone = `${template}_clone_${randomBytes(6).toString('hex')}`;
const quote = (identifier) => `"${identifier.replace(/"/g, '""')}"`;

function urlFor(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

async function withAdmin(database, work) {
  const client = new Client({ connectionString: urlFor(process.env.DATABASE_ADMIN_URL, database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Every table's exact row count, as one comparable string. */
function fingerprint(database) {
  return withAdmin(database, async (client) => {
    const { rows: tables } = await client.query(
      `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
    );
    const counts = [];
    for (const { name } of tables) {
      const { rows } = await client.query(`SELECT count(*)::text AS n FROM ${name}`);
      counts.push(`${name}=${rows[0].n}`);
    }
    return counts.join('\n');
  });
}

function run() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const name of URL_VARIABLES) env[name] = urlFor(process.env[name], clone);
    // Its own process group, so a signal — and the final reap — reaches every
    // descendant (`npx` → `sh` → `jest`), not only the direct child: nothing
    // may still be writing to the clone when it is dropped.
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env, detached: true });
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group has already exited.
      }
    };
    process.on('SIGINT', signalGroup);
    process.on('SIGTERM', signalGroup);
    child.on('error', (error) => {
      console.error(`with-db-clone: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', signalGroup);
      process.off('SIGTERM', signalGroup);
      signalGroup('SIGKILL');
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

const before = await fingerprint(template);
await withAdmin('postgres', (client) =>
  client.query(`CREATE DATABASE ${quote(clone)} TEMPLATE ${quote(template)}`),
);
console.error(`with-db-clone: created ${clone} from ${template}`);

let status = 1;
try {
  status = await run();
  // What the command left behind — absorbed by the clone, never the template.
  const left = await fingerprint(clone);
  const was = new Map(before.split('\n').map((line) => line.split('=')));
  const residue = left
    .split('\n')
    .map((line) => line.split('='))
    .filter(([table, n]) => was.get(table) !== n)
    .map(([table, n]) => `${table} ${was.get(table) ?? 0} -> ${n}`);
  console.error(
    residue.length === 0
      ? 'with-db-clone: the command left no rows behind in the clone'
      : `with-db-clone: rows the command left behind in the clone (discarded):\n  ${residue.join('\n  ')}`,
  );
} finally {
  await withAdmin('postgres', async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quote(clone)} WITH (FORCE)`);
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      clone,
    ]);
    if (rowCount !== 0) {
      console.error(`with-db-clone: ${clone} still exists after DROP`);
      status = 1;
    } else {
      console.error(`with-db-clone: dropped ${clone} and verified it is gone`);
    }
  });
}

const after = await fingerprint(template);
if (after !== before) {
  console.error(`with-db-clone: the template ${template} changed during the run`);
  status = 1;
} else {
  console.error(`with-db-clone: the template ${template} is unchanged (row-count fingerprint)`);
}
process.exit(status);
