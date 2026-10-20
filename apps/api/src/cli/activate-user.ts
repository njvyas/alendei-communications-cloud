/**
 * `npm run user:activate --workspace @acc/api -- --operator <email>
 *   --organization <id|slug> --email <email> --password-stdin`
 *
 * Entry point for `user-activation.ts` (see there for the rules). Arguments name
 * people and an organization only; the password is read from stdin, so it never
 * appears in argv, the environment or a process listing. Output names the user
 * and organization, never the password; any refusal exits 1.
 */
import { createDatabase, createPool } from '@acc/db';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import { CredentialService } from '../iam/credential.service';
import { UserLifecycleService } from '../iam/user-lifecycle.service';
import { ownerAuditWriter } from './bootstrap';
import { activateInvitedUser } from './user-activation';

const FLAGS = ['--operator', '--organization', '--email'] as const;

export function parseArguments(argv: readonly string[]): Record<(typeof FLAGS)[number], string> {
  const values: Partial<Record<(typeof FLAGS)[number], string>> = {};
  let passwordStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--password-stdin') {
      passwordStdin = true;
    } else if ((FLAGS as readonly string[]).includes(arg) && argv[i + 1] !== undefined) {
      values[arg as (typeof FLAGS)[number]] = argv[++i]!;
    } else {
      // Refuses anything else, including an attempt to pass a password as an argument.
      throw new Error(`unexpected argument ${arg.startsWith('--') ? arg : '(value withheld)'}`);
    }
  }
  if (!passwordStdin)
    throw new Error('--password-stdin is required: the password is read from stdin');
  for (const flag of FLAGS) {
    if (!values[flag]?.trim()) throw new Error(`${flag} is required`);
  }
  return values as Record<(typeof FLAGS)[number], string>;
}

/** Reads stdin to its end and removes one trailing line ending (as `printf '%s\n'` adds). */
export async function readPassword(stream: NodeJS.ReadableStream): Promise<string> {
  if ((stream as NodeJS.ReadStream).isTTY) {
    throw new Error('pipe the password on stdin; interactive entry is not supported');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
  loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true, override: false });

  const args = parseArguments(process.argv.slice(2));
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl?.trim())
    throw new Error('DATABASE_ADMIN_URL must be set — activation runs as the schema owner');
  const password = await readPassword(process.stdin);

  const credentials = new CredentialService({
    auth: {
      argon2: {
        memoryCost: Number(process.env.AUTH_ARGON2_MEMORY_KIB ?? 19456),
        timeCost: Number(process.env.AUTH_ARGON2_TIME_COST ?? 2),
        parallelism: Number(process.env.AUTH_ARGON2_PARALLELISM ?? 1),
      },
    },
  } as never);
  const pool = createPool({
    connectionString: adminUrl,
    max: 1,
    applicationName: 'acc-user-activation',
  });
  try {
    const result = await activateInvitedUser(
      createDatabase(pool),
      { users: new UserLifecycleService(credentials), audit: ownerAuditWriter() },
      {
        operatorEmail: args['--operator'],
        organization: args['--organization'],
        userEmail: args['--email'],
        password,
      },
    );
    console.log(`User activated: ${result.email} (organization ${result.orgSlug})`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'user activation failed');
    process.exitCode = 1;
  });
}
