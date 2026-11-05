/**
 * `platform:support` — owner-run Platform Support provisioning (ADR-015 Item 5
 * Amendment A-1, `RBAC.md` §5b.1). Entry point; the rules live in
 * `platform-support-provisioning.ts`.
 *
 *   printf '%s\n%s\n' "$OPERATOR_PASSWORD" "$NEW_PASSWORD" | npm run --silent platform:support \
 *     --workspace @acc/api -- create --operator <super-admin email> --email <new address> \
 *     --password-stdin --confirm-environment <APP_ENV>
 *
 *   printf '%s\n' "$OPERATOR_PASSWORD" | npm run --silent platform:support --workspace @acc/api -- \
 *     revoke --operator <super-admin email> --email <address> --password-stdin \
 *     --confirm-environment <APP_ENV>
 *
 *   npm run --silent platform:support --workspace @acc/api -- status --email <address>
 *
 * Order of checks, so that nothing is connected to or read before it is safe:
 * the command line, then `APP_ENV` (fail closed, `production` always refused),
 * then the schema-owner connection string, then stdin. Arguments name people
 * only; every secret arrives on piped stdin, one per line. Output names
 * identities, ids and counts — never a password, digest, token or session id.
 */
import { createDatabase, createPool } from '@acc/db';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import { CredentialService } from '../iam/credential.service';
import { SessionService } from '../iam/session.service';
import { UserLifecycleService } from '../iam/user-lifecycle.service';
import { ownerAuditWriter } from './bootstrap';
import {
  PlatformSupportRefusal,
  assertPlatformSupportEnvironment,
  createPlatformSupportUser,
  platformSupportStatus,
  revokePlatformSupportUser,
} from './platform-support-provisioning';

export type PlatformSupportCommand = 'create' | 'revoke' | 'status';

export interface ParsedCommandLine {
  readonly command: PlatformSupportCommand;
  readonly operator: string | null;
  readonly email: string;
  readonly confirmEnvironment: string | null;
}

const VALUE_FLAGS: Record<PlatformSupportCommand, readonly string[]> = {
  create: ['--operator', '--email', '--confirm-environment'],
  revoke: ['--operator', '--email', '--confirm-environment'],
  status: ['--email'],
};

/** stdin lines each command reads, in order. `status` reads none. */
export const STDIN_LINES: Record<PlatformSupportCommand, number> = {
  create: 2, // operator password, new user's password
  revoke: 1, // operator password
  status: 0,
};

/** The largest stdin accepted; two passwords of the maximum length fit easily. */
const STDIN_LIMIT_BYTES = 4096;

export class CommandLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandLineError';
  }
}

/**
 * Parses the fixed command surface. Anything else is refused, with the offending
 * value withheld — there is no flag through which a secret, a role, a scope or
 * SQL could be passed.
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const [command, ...rest] = argv;
  if (command !== 'create' && command !== 'revoke' && command !== 'status') {
    throw new CommandLineError('the first argument must be create, revoke or status');
  }
  const allowed = VALUE_FLAGS[command];
  const values = new Map<string, string>();
  let passwordStdin = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--password-stdin' && command !== 'status') {
      if (passwordStdin) throw new CommandLineError('--password-stdin given twice');
      passwordStdin = true;
    } else if (allowed.includes(arg) && rest[i + 1] !== undefined) {
      if (values.has(arg)) throw new CommandLineError(`${arg} given twice`);
      values.set(arg, rest[++i]!);
    } else {
      throw new CommandLineError(
        `unexpected argument ${arg.startsWith('--') ? arg : '(value withheld)'}`,
      );
    }
  }
  for (const flag of allowed) {
    if (!values.get(flag)?.trim()) throw new CommandLineError(`${flag} is required`);
  }
  if (command !== 'status' && !passwordStdin) {
    throw new CommandLineError('--password-stdin is required: passwords are read from stdin');
  }
  // Addresses lose surrounding whitespace here; they are validated (`isEmail`)
  // by the provisioning functions. `--confirm-environment` is compared byte for
  // byte with APP_ENV and is deliberately not trimmed.
  return {
    command,
    operator: values.get('--operator')?.trim() ?? null,
    email: values.get('--email')!.trim(),
    confirmEnvironment: values.get('--confirm-environment') ?? null,
  };
}

/**
 * Reads exactly `count` lines from a piped stdin. A terminal is refused (input
 * would be echoed and could land in scrollback); so are a missing or an extra
 * line, and input larger than the limit. One trailing line ending is removed
 * from each line (`printf '%s\n'`), and a `\r` before it.
 */
export async function readStdinLines(
  stream: NodeJS.ReadableStream,
  count: number,
): Promise<string[]> {
  if ((stream as NodeJS.ReadStream).isTTY) {
    throw new CommandLineError('pipe the passwords on stdin; interactive entry is not supported');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > STDIN_LIMIT_BYTES) throw new CommandLineError('stdin is larger than expected');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const cleaned = lines.map((line) => line.replace(/\r$/, ''));
  if (text === '' || cleaned.length !== count) {
    throw new CommandLineError(`stdin must carry exactly ${count} line(s)`);
  }
  if (cleaned.some((line) => line === ''))
    throw new CommandLineError('stdin carries an empty line');
  return cleaned;
}

function credentialService(): CredentialService {
  return new CredentialService({
    auth: {
      argon2: {
        memoryCost: Number(process.env.AUTH_ARGON2_MEMORY_KIB ?? 19456),
        timeCost: Number(process.env.AUTH_ARGON2_TIME_COST ?? 2),
        parallelism: Number(process.env.AUTH_ARGON2_PARALLELISM ?? 1),
      },
    },
  } as never);
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
): Promise<string[]> {
  const parsed = parseCommandLine(argv);
  // Fail closed, before any connection or stdin read.
  const appEnv = assertPlatformSupportEnvironment(env.APP_ENV, parsed.confirmEnvironment, {
    requireConfirmation: parsed.command !== 'status',
  });
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (!adminUrl?.trim()) {
    throw new CommandLineError(
      'DATABASE_ADMIN_URL must be set — the command runs as the schema owner',
    );
  }
  const secrets =
    parsed.command === 'status' ? [] : await readStdinLines(stdin, STDIN_LINES[parsed.command]);

  const credentials = credentialService();
  const deps = {
    users: new UserLifecycleService(credentials),
    credentials,
    // `revokeAllForUser` reads no configuration.
    sessions: new SessionService({} as never),
    audit: ownerAuditWriter(),
  };
  const pool = createPool({
    connectionString: adminUrl,
    max: 1,
    applicationName: 'acc-platform-support',
  });
  const db = createDatabase(pool);
  try {
    if (parsed.command === 'create') {
      const r = await createPlatformSupportUser(db, deps, {
        appEnv,
        operatorEmail: parsed.operator!,
        operatorPassword: secrets[0]!,
        userEmail: parsed.email,
        password: secrets[1]!,
      });
      return [
        `Platform support user created: ${r.email}`,
        `  user ${r.userId}; grant ${r.grantId} (alendei_support at platform); correlation ${r.correlationId}`,
      ];
    }
    if (parsed.command === 'revoke') {
      const r = await revokePlatformSupportUser(db, deps, {
        appEnv,
        operatorEmail: parsed.operator!,
        operatorPassword: secrets[0]!,
        userEmail: parsed.email,
      });
      return [
        `Platform support access revoked: ${r.email}`,
        `  user ${r.userId} disabled; grant ${r.revokedGrantId} removed; sessions revoked ${r.sessionsRevoked}; password and MFA reference cleared; correlation ${r.correlationId}`,
      ];
    }
    const s = await platformSupportStatus(db, appEnv, parsed.email);
    return [
      `classification: ${s.classification}`,
      `user: ${s.userId ?? '-'}`,
      `status: ${s.status ?? '-'}`,
      `password set: ${s.hasPassword}; mfa enabled: ${s.mfaEnabled}; mfa secret reference: ${s.hasMfaSecretRef}`,
      `grants: ${s.grants.length === 0 ? 'none' : s.grants.map((g) => `${g.roleKey}@${g.scopeType}${g.scopeId ? `:${g.scopeId}` : ''}`).join(', ')}`,
      `sessions: live ${s.liveSessions}, unrevoked ${s.unrevokedSessions}; usable api keys: ${s.usableApiKeys}`,
      ...s.recentAudit.map((a) => `audit: ${a.createdAt} ${a.action} ${a.outcome}`),
    ];
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
  loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true, override: false });
  main(process.argv.slice(2), process.env, process.stdin)
    .then((lines) => {
      for (const line of lines) console.log(line);
    })
    .catch((error: unknown) => {
      console.error(describeFailure(error));
      process.exitCode = 1;
    });
}

/**
 * What the operator sees on failure. Refusal and command-line messages are
 * composed here and never carry a secret. Any other error is reduced to a fixed
 * text and a database error code: a driver error message can embed the
 * statement's parameters (a query builder's "Failed query … params: …"), which
 * may include a password digest, so it is never printed.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof PlatformSupportRefusal || error instanceof CommandLineError) {
    return error.message;
  }
  const code =
    (error as { cause?: { code?: unknown } } | null)?.cause?.code ??
    (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? `platform support failed: database error ${code}; nothing was committed`
    : 'platform support failed: unexpected error; nothing was committed';
}
