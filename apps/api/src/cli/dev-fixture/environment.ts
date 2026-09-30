/**
 * The fixture's environment gate and inputs (Phase 1C.4a, D4 and D6).
 *
 * This module imports nothing that touches the database or the application, so
 * the gate is decided before any connection is opened or any Nest module is
 * loaded. There is no override, confirmation prompt, force flag or bypass: an
 * `APP_ENV` other than `development` or `test` — including a missing one — ends
 * the process.
 */
import { EnvSecretsAdapter } from '../../secrets/env-secrets.adapter';

export const FIXTURE_ENVIRONMENTS = ['development', 'test'] as const;

/** The reference (never the value) the fixture users' password is resolved from. */
export const FIXTURE_PASSWORD_REF_VARIABLE = 'ACC_FIXTURE_USER_PASSWORD_REF';
/** The operator is the bootstrap platform administrator; its password is resolved the same way. */
export const OPERATOR_EMAIL_VARIABLE = 'AUTH_BOOTSTRAP_EMAIL';
export const OPERATOR_PASSWORD_REF_VARIABLE = 'AUTH_BOOTSTRAP_PASSWORD_REF';

export class FixtureRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureRefusal';
  }
}

/**
 * Refuses every environment but `development` and `test`. `NODE_ENV=production`
 * is refused as well, so a production build pointed at a mislabelled
 * environment cannot run it either.
 */
export function assertFixtureEnvironment(env: NodeJS.ProcessEnv): 'development' | 'test' {
  const appEnv = env.APP_ENV;
  if (appEnv !== 'development' && appEnv !== 'test') {
    throw new FixtureRefusal(
      `refusing to run with APP_ENV=${appEnv === undefined ? '<unset>' : JSON.stringify(appEnv)}: ` +
        'the development fixture runs only when APP_ENV is "development" or "test", and has no override',
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new FixtureRefusal('refusing to run with NODE_ENV=production');
  }
  return appEnv;
}

export interface FixtureInputs {
  readonly appEnv: 'development' | 'test';
  readonly adminUrl: string;
  readonly operatorEmail: string;
  readonly operatorPassword: string;
  readonly userPassword: string;
  /** The name of the reference variable, reported in the manifest; never its value. */
  readonly userPasswordReference: string;
}

function required(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new FixtureRefusal(`${name} must be set — ${why}`);
  }
  return value;
}

/**
 * Resolves every input the fixture needs, or refuses. Passwords arrive only
 * through `SecretsPort` references; there is no default, no generated value and
 * no plaintext variable read directly. Error messages name variables and
 * references, never a resolved value.
 */
export async function resolveFixtureInputs(env: NodeJS.ProcessEnv): Promise<FixtureInputs> {
  const appEnv = assertFixtureEnvironment(env);

  const backend = env.SECRETS_BACKEND ?? 'env';
  if (backend !== 'env') {
    throw new FixtureRefusal(
      `SECRETS_BACKEND="${backend}" has no adapter; the fixture resolves references with the "env" backend only`,
    );
  }

  const adminUrl = required(
    env,
    'DATABASE_ADMIN_URL',
    'the fixture reads and reconciles as the schema owner',
  );
  const operatorEmail = required(
    env,
    OPERATOR_EMAIL_VARIABLE,
    'the fixture operates as the bootstrap platform administrator',
  ).toLowerCase();
  const operatorRef = required(
    env,
    OPERATOR_PASSWORD_REF_VARIABLE,
    'the operator password is resolved through SecretsPort',
  );
  const userRef = required(
    env,
    FIXTURE_PASSWORD_REF_VARIABLE,
    'fixture users get their password from a SecretsPort reference; there is no default',
  );

  // The adapter's own rules apply unchanged: `env:` references only, a set
  // variable, at least 32 characters.
  const secrets = new EnvSecretsAdapter();
  const operatorPassword = await secrets.resolve(operatorRef);
  const userPassword = await secrets.resolve(userRef);
  if (userPassword === operatorPassword) {
    throw new FixtureRefusal(
      `${FIXTURE_PASSWORD_REF_VARIABLE} resolves to the platform administrator's password; ` +
        'a fixture user must never share the platform credential',
    );
  }

  return {
    appEnv,
    adminUrl,
    operatorEmail,
    operatorPassword,
    userPassword,
    userPasswordReference: FIXTURE_PASSWORD_REF_VARIABLE,
  };
}
