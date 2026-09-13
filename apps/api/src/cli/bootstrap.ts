/**
 * Owner-run platform bootstrap (ADR-003 D-1, `RBAC.md` §5b).
 *
 *   npm run bootstrap --workspace @acc/api
 *
 * `fn_validate_user_role_scope` refuses a platform-role grant unless the actor
 * already holds platform admin. With no user seeded, the first grant is
 * otherwise impossible — deliberately so. This CLI is the one sanctioned way
 * past that, and every property below exists to keep it narrow:
 *
 *   - It is never reachable over HTTP. There is no endpoint, no route, and no
 *     "first run setup" mode in the API.
 *   - It runs as the schema owner and elevates with a transaction-local
 *     `app.is_platform_admin`, exactly as `seed.ts` already does to seed platform
 *     roles. `fn_validate_user_role_scope` is not modified or weakened; no
 *     application principal can set that variable.
 *   - It is idempotent: a second run against a bootstrapped database makes no
 *     changes and creates no duplicate principal.
 *   - It never installs a default password. The password is resolved through
 *     `SecretsPort` from a configured reference, and a missing reference aborts.
 *   - Running against production requires explicit confirmation.
 *   - It audits itself through the Phase 1B.1 `AuditWriter`, inside the same
 *     transaction as the mutations it describes.
 */
import { createDatabase, createPool, schema, type Transaction } from '@acc/db';
import { AUDIT_ACTIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { config as loadEnv } from 'dotenv';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { uuidv7 } from 'uuidv7';

import { AuditWriter } from '../audit/audit-writer.service';
import { CredentialService } from '../iam/credential.service';
import { UserLifecycleService } from '../iam/user-lifecycle.service';
import { EnvSecretsAdapter } from '../secrets/env-secrets.adapter';

function loadCliEnv(): void {
  loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
  loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true, override: false });
}

function requireEnv(name: string, why: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} must be set — ${why}`);
  }
  return value;
}

/**
 * `AuditWriter` reaches the database through `TenantDatabase`, whose pools are
 * the RLS-constrained application principals. Bootstrap runs as the owner, so it
 * supplies this shim instead — and deliberately throws on both non-transactional
 * paths, which proves at runtime that bootstrap always passes its own
 * transaction and never lets an audit row commit apart from the mutation it
 * describes. The writer, redactor and column enumeration are the committed ones;
 * this is not a second audit path.
 */
function ownerAuditWriter(): AuditWriter {
  const refuse = (): never => {
    throw new Error('bootstrap: audit must be written inside the bootstrap transaction');
  };
  return new AuditWriter({
    get auth(): never {
      return refuse();
    },
    withRequestTenant: refuse,
  } as never);
}

async function confirmProduction(appEnv: string): Promise<void> {
  if (appEnv !== 'production') return;
  if (process.env.BOOTSTRAP_CONFIRM === 'i-understand-this-creates-a-platform-admin') return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\nAbout to create a PLATFORM ADMINISTRATOR in a production environment.\n` +
        `This principal can reach every tenant's data.\n` +
        `Type "create platform admin" to proceed: `,
    );
    if (answer.trim() !== 'create platform admin') {
      throw new Error('bootstrap: aborted at the production confirmation prompt');
    }
  } finally {
    rl.close();
  }
}

interface BootstrapOutcome {
  readonly created: boolean;
  readonly userId: string;
  readonly email: string;
}

export async function runBootstrap(
  tx: Transaction,
  params: {
    email: string;
    password: string;
    credentials: CredentialService;
    users: UserLifecycleService;
    audit: AuditWriter;
  },
): Promise<BootstrapOutcome> {
  const { email, password, users, audit } = params;

  // Elevate for this transaction only. `SET LOCAL` semantics mean it is gone at
  // commit or rollback, and it is what lets fn_validate_user_role_scope accept
  // the very first platform grant without being modified.
  await tx.execute(sql`select set_config('app.is_platform_admin', 'on', true)`);

  const [role] = await tx
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(
      and(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN), isNull(schema.roles.orgId)),
    );
  if (!role) {
    throw new Error(
      'bootstrap: the alendei_super_admin platform role is missing — run `npm run db:seed` first',
    );
  }

  // Idempotence is decided on the grant, not on the user: an existing platform
  // admin means the platform is already bootstrapped, whoever they are.
  const existingAdmins = await tx
    .select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .where(and(eq(schema.userRoles.roleId, role.id), eq(schema.userRoles.scopeType, 'platform')));

  if (existingAdmins.length > 0) {
    const [existing] = await tx
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, existingAdmins[0]!.userId));
    return { created: false, userId: existing!.id, email: existing!.email };
  }

  const existingUser = await users.findByEmail(tx, email);
  const invited = existingUser ?? (await users.invite(tx, email));
  const activated = await users.activate(tx, invited.id, password);

  await tx.insert(schema.userRoles).values({
    userId: activated.id,
    roleId: role.id,
    scopeType: 'platform',
    scopeId: null,
  });

  const correlationId = uuidv7();
  const actor = {
    actorType: 'system' as const,
    actorUserId: null,
    actorApiKeyId: null,
    actorLabel: 'platform_bootstrap',
  };

  // Both rows join this transaction: if either audit insert fails, the platform
  // administrator is not created.
  await audit.record(
    {
      ...actor,
      scopeType: 'platform',
      scopeId: null,
      action: AUDIT_ACTIONS.USER_INVITED,
      resourceType: 'user',
      resourceId: activated.id,
      outcome: 'success',
      before: null,
      after: { email: activated.email, status: activated.status },
      metadata: { via: 'bootstrap-cli' },
      correlationId,
    },
    tx,
  );

  await audit.record(
    {
      ...actor,
      scopeType: 'platform',
      scopeId: null,
      action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
      resourceType: 'user_role',
      resourceId: activated.id,
      outcome: 'success',
      before: null,
      after: { roleKey: PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN, scopeType: 'platform' },
      metadata: { via: 'bootstrap-cli' },
      correlationId,
    },
    tx,
  );

  return { created: true, userId: activated.id, email: activated.email };
}

async function main(): Promise<void> {
  loadCliEnv();
  const appEnv = process.env.APP_ENV ?? 'development';

  const email = requireEnv('AUTH_BOOTSTRAP_EMAIL', 'the first platform administrator needs one');
  const passwordRef = requireEnv(
    'AUTH_BOOTSTRAP_PASSWORD_REF',
    'the bootstrap password is resolved through SecretsPort, never read as plaintext config',
  );
  const adminUrl = requireEnv('DATABASE_ADMIN_URL', 'bootstrap runs as the schema owner');

  await confirmProduction(appEnv);

  const secrets = new EnvSecretsAdapter();
  const password = await secrets.resolve(passwordRef);

  const config = {
    auth: {
      argon2: {
        memoryCost: Number(process.env.AUTH_ARGON2_MEMORY_KIB ?? 19456),
        timeCost: Number(process.env.AUTH_ARGON2_TIME_COST ?? 2),
        parallelism: Number(process.env.AUTH_ARGON2_PARALLELISM ?? 1),
      },
    },
  };
  const credentials = new CredentialService(config as never);
  const users = new UserLifecycleService(credentials);
  const audit = ownerAuditWriter();

  const pool = createPool({ connectionString: adminUrl, max: 1, applicationName: 'acc-bootstrap' });
  const db = createDatabase(pool);
  try {
    const outcome = await db.transaction((tx) =>
      runBootstrap(tx, { email, password, credentials, users, audit }),
    );
    console.log(
      outcome.created
        ? `Platform administrator created: ${outcome.email}`
        : `Already bootstrapped — platform administrator ${outcome.email} exists; no changes made.`,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // The message only ever names a configuration key or a secret *reference*,
    // never a resolved secret value.
    console.error('Bootstrap failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
