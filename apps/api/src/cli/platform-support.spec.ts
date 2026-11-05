import { Readable } from 'node:stream';

import {
  CommandLineError,
  describeFailure,
  main,
  parseCommandLine,
  readSecretLines,
} from './platform-support';
import {
  PLATFORM_SUPPORT_ALLOWED_ENVIRONMENTS,
  PlatformSupportRefusal,
  assertPlatformSupportEnvironment,
} from './platform-support-provisioning';

/**
 * `platform:support` command surface (ADR-015 Item 5 Amendment A-1): the fixed
 * parser, the piped-stdin reader, the fail-closed `APP_ENV` check and the order
 * in which they run. Database behaviour is in
 * `test/platform-support-provisioning.sec-spec.ts`.
 */
const SECRET = 'a-secret-that-must-never-be-echoed';

const create = (extra: string[] = []) => [
  'create',
  '--operator',
  'op@example.test',
  '--email',
  'support@example.test',
  '--password-stdin',
  '--confirm-environment',
  'staging',
  ...extra,
];

/** A stdin that fails the test if anything reads it. */
function untouchableStdin(): NodeJS.ReadableStream & { reads: number } {
  const stream = new Readable({
    read() {
      stream.reads += 1;
      this.push(null);
    },
  }) as Readable & { reads: number };
  stream.reads = 0;
  return stream;
}

const piped = (text: string) => Readable.from([Buffer.from(text)]);

describe('platform:support command line (N-16, N-20)', () => {
  it('parses the three commands and nothing else', () => {
    expect(parseCommandLine(create())).toEqual({
      command: 'create',
      operator: 'op@example.test',
      email: 'support@example.test',
      confirmEnvironment: 'staging',
    });
    expect(
      parseCommandLine([
        'revoke',
        '--email',
        'support@example.test',
        '--operator',
        'op@example.test',
        '--password-stdin',
        '--confirm-environment',
        'test',
      ]).command,
    ).toBe('revoke');
    expect(parseCommandLine(['status', '--email', 'x@example.test'])).toEqual({
      command: 'status',
      operator: null,
      email: 'x@example.test',
      confirmEnvironment: null,
    });
    for (const bad of [[], ['grant'], ['reactivate'], ['sql'], ['--email', 'x@example.test']]) {
      expect(() => parseCommandLine(bad)).toThrow(
        /first argument must be create, revoke or status/,
      );
    }
  });

  it('refuses any role, scope, SQL, force or password flag, withholding the value', () => {
    for (const flag of [
      '--role',
      '--scope',
      '--scope-id',
      '--sql',
      '--force',
      '--yes',
      '--password',
      '--permission',
    ]) {
      const attempt = () => parseCommandLine(create([flag, SECRET]));
      expect(attempt).toThrow(CommandLineError);
      expect(attempt).toThrow(new RegExp(`unexpected argument ${flag}`));
      try {
        attempt();
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
    }
    // A stray positional value is never echoed.
    expect(() => parseCommandLine(create([SECRET]))).toThrow(
      /unexpected argument \(value withheld\)/,
    );
  });

  it('requires every flag of the command, once, and --password-stdin for state changes', () => {
    expect(() => parseCommandLine(create().filter((a) => a !== '--password-stdin'))).toThrow(
      /--password-stdin is required/,
    );
    expect(() =>
      parseCommandLine(['create', '--operator', 'op@example.test', '--password-stdin']),
    ).toThrow(/--email is required/);
    expect(() => parseCommandLine(create(['--email', 'other@example.test']))).toThrow(
      /--email given twice/,
    );
    expect(() => parseCommandLine(create(['--password-stdin']))).toThrow(
      /--password-stdin given twice/,
    );
    expect(() =>
      parseCommandLine(['status', '--email', 'x@example.test', '--password-stdin']),
    ).toThrow(/unexpected argument --password-stdin/);
    expect(() =>
      parseCommandLine(['status', '--email', 'x@example.test', '--operator', 'op@example.test']),
    ).toThrow(/unexpected argument --operator/);
  });
});

describe('platform:support stdin (N-16)', () => {
  it('reads exactly the expected lines from a pipe', async () => {
    await expect(readSecretLines(piped('one-password\ntwo-password\n'), 2)).resolves.toEqual([
      'one-password',
      'two-password',
    ]);
    await expect(readSecretLines(piped('one-password\r\n'), 1)).resolves.toEqual(['one-password']);
    await expect(readSecretLines(piped('no-newline'), 1)).resolves.toEqual(['no-newline']);
  });

  it('refuses a terminal, a wrong line count, an empty line and oversized input', async () => {
    const tty = Object.assign(piped('x\n'), { isTTY: true });
    await expect(readSecretLines(tty, 1)).rejects.toThrow(/interactive entry is not supported/);
    await expect(readSecretLines(piped(''), 1)).rejects.toThrow(/exactly 1 line/);
    await expect(readSecretLines(piped('a\nb\nc\n'), 2)).rejects.toThrow(/exactly 2 line/);
    await expect(readSecretLines(piped('only-one\n'), 2)).rejects.toThrow(/exactly 2 line/);
    await expect(readSecretLines(piped('\nsecond\n'), 2)).rejects.toThrow(/empty line/);
    await expect(readSecretLines(piped(`${'x'.repeat(5000)}\n`), 1)).rejects.toThrow(
      /larger than expected/,
    );
  });
});

describe('platform:support environment — APP_ENV, fail closed (N-13, N-14)', () => {
  const check = (appEnv: string | undefined, confirm: string | null, requireConfirmation = true) =>
    assertPlatformSupportEnvironment(appEnv, confirm, { requireConfirmation });

  it('admits staging, test and development when confirmed exactly', () => {
    expect([...PLATFORM_SUPPORT_ALLOWED_ENVIRONMENTS]).toEqual(['staging', 'test', 'development']);
    for (const env of PLATFORM_SUPPORT_ALLOWED_ENVIRONMENTS) expect(check(env, env)).toBe(env);
    expect(check('staging', null, false)).toBe('staging');
  });

  it('refuses a missing, empty or unknown APP_ENV', () => {
    for (const env of [undefined, '', '   ', 'prod', 'Production', 'STAGING', 'qa', 'staging ']) {
      expect(() => check(env, env ?? null)).toThrow(PlatformSupportRefusal);
    }
  });

  it('refuses production unconditionally — with or without confirmation, for every command', () => {
    for (const confirm of ['production', null, 'staging']) {
      for (const requireConfirmation of [true, false]) {
        expect(() => check('production', confirm, requireConfirmation)).toThrow(
          /APP_ENV is production; platform support provisioning is prohibited/,
        );
      }
    }
  });

  it('requires --confirm-environment to equal APP_ENV byte for byte', () => {
    expect(() => check('staging', 'test')).toThrow(/must equal APP_ENV exactly/);
    expect(() => check('staging', 'Staging')).toThrow(/must equal APP_ENV exactly/);
    expect(() => check('staging', null)).toThrow(/must equal APP_ENV exactly/);
  });
});

describe('platform:support check order: nothing is connected to or read before it is safe', () => {
  const unreachable = 'postgres://nobody@127.0.0.1:1/never';

  it('refuses on APP_ENV before reading stdin or looking at the connection string', async () => {
    for (const env of [
      {},
      { APP_ENV: '' },
      { APP_ENV: 'production', DATABASE_ADMIN_URL: unreachable },
      { APP_ENV: 'unknown', DATABASE_ADMIN_URL: unreachable },
      // NODE_ENV is not consulted: QA runs NODE_ENV=production with APP_ENV=staging.
      { NODE_ENV: 'development', APP_ENV: 'production', DATABASE_ADMIN_URL: unreachable },
    ]) {
      const stdin = untouchableStdin();
      await expect(main(create(), env as NodeJS.ProcessEnv, stdin)).rejects.toBeInstanceOf(
        PlatformSupportRefusal,
      );
      expect(stdin.reads).toBe(0);
    }
    const stdin = untouchableStdin();
    await expect(
      main(create(), { APP_ENV: 'test', DATABASE_ADMIN_URL: unreachable }, stdin),
    ).rejects.toThrow(/--confirm-environment must equal APP_ENV/);
    expect(stdin.reads).toBe(0);
  });

  it('refuses a missing schema-owner connection string before reading stdin', async () => {
    const stdin = untouchableStdin();
    await expect(main(create(), { APP_ENV: 'staging' }, stdin)).rejects.toThrow(
      /DATABASE_ADMIN_URL must be set/,
    );
    expect(stdin.reads).toBe(0);
  });

  it('refuses a malformed command line before anything else', async () => {
    const stdin = untouchableStdin();
    await expect(main(['grant', '--role', 'x'], { APP_ENV: 'staging' }, stdin)).rejects.toThrow(
      CommandLineError,
    );
    expect(stdin.reads).toBe(0);
  });
});

describe('platform:support failure output never carries statement parameters (N-18)', () => {
  it('reduces a driver error to a fixed text and its SQLSTATE', () => {
    const digest = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g';
    const driverError = Object.assign(
      new Error(
        `Failed query: update "users" set "password_hash" = $1\nparams: ${digest},${SECRET}`,
      ),
      { cause: { code: '23514', message: 'violates check constraint' } },
    );
    const text = describeFailure(driverError);
    expect(text).toBe('platform support failed: database error 23514; nothing was committed');
    expect(text).not.toContain(digest);
    expect(text).not.toContain(SECRET);
    expect(describeFailure(new Error(`boom ${SECRET}`))).toBe(
      'platform support failed: unexpected error; nothing was committed',
    );
    expect(
      describeFailure(
        new PlatformSupportRefusal('self_revocation', 'an operator cannot revoke themself'),
      ),
    ).toBe('platform support refused: an operator cannot revoke themself');
  });
});
