/**
 * `automation:control` — owner-run, organisation-wide automation sending controls (Phase 8B PR
 * 8B-3a; PHASE-8B-3-HANDOVER-Rev2 §3.5, owner decision OD-8B3-5: "platform support CLI").
 *
 *   printf '%s\n' "$OPERATOR_PASSWORD" | npm run --silent automation:control --workspace @acc/api -- \
 *     pause --org <organization id> --operator <super-admin email> --password-stdin \
 *     --confirm-environment <APP_ENV> [--reason <text>]
 *
 *   (same for `resume` and `revoke`)
 *
 *   npm run --silent automation:control --workspace @acc/api -- status --org <organization id>
 *
 * Same safety order as `platform:support`: the command line, then `APP_ENV` (fail closed,
 * `production` refused), then the schema-owner connection string, then stdin. A state change is
 * made only by an active `alendei_super_admin` whose password is verified now and re-validated
 * inside the changing transaction. The change goes through the same internal definer as the
 * tenant API (`app_automation_apply_control`, FOR UPDATE on the organisation's control row), so it
 * is serialised against every in-flight send, and it is audited.
 */
import type { AuditAction } from '@acc/contracts';
import { createDatabase, createPool, type Database, type Transaction } from '@acc/db';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { CredentialService } from '../iam/credential.service';
import { ownerAuditWriter } from './bootstrap';
import { CommandLineError, readStdinLines } from './platform-support';

export type AutomationControlCommand = 'pause' | 'resume' | 'revoke' | 'status';

export interface AutomationControlCommandLine {
  readonly command: AutomationControlCommand;
  readonly orgId: string;
  readonly operator: string | null;
  readonly reason: string | null;
  readonly confirmEnvironment: string | null;
}

export const AUTOMATION_CONTROL_ACTOR_LABEL = 'automation_control_cli';
export const AUTOMATION_CONTROL_ALLOWED_ENVIRONMENTS = ['staging', 'test', 'development'] as const;
const OPERATOR_ROLE_KEY = 'alendei_super_admin';
const OPERATOR_NOT_ACCEPTED =
  "the operator was not accepted: an active platform administrator's address and current password are required";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIT_ACTION: Record<Exclude<AutomationControlCommand, 'status'>, string> = {
  pause: 'automation.paused',
  resume: 'automation.resumed',
  revoke: 'automation.revoked',
};

export class AutomationControlRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationControlRefusal';
  }
}

/** The fixed command surface; anything else is refused with the offending value withheld. */
export function parseAutomationControlCommandLine(
  argv: readonly string[],
): AutomationControlCommandLine {
  const [command, ...rest] = argv;
  if (command !== 'pause' && command !== 'resume' && command !== 'revoke' && command !== 'status') {
    throw new CommandLineError('the first argument must be pause, resume, revoke or status');
  }
  const changing = command !== 'status';
  const allowed = changing
    ? ['--org', '--operator', '--reason', '--confirm-environment']
    : ['--org'];
  const values = new Map<string, string>();
  let passwordStdin = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--password-stdin' && changing) {
      passwordStdin = true;
      continue;
    }
    if (!allowed.includes(flag)) throw new CommandLineError('unknown or misplaced argument');
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CommandLineError(`${flag} needs a value`);
    }
    if (values.has(flag)) throw new CommandLineError(`${flag} given twice`);
    values.set(flag, value);
    i++;
  }
  const orgId = values.get('--org');
  if (!orgId || !UUID.test(orgId)) throw new CommandLineError('--org must be an organization id');
  const reason = values.get('--reason') ?? null;
  if (reason !== null && (reason.length < 1 || reason.length > 200)) {
    throw new CommandLineError('--reason must be 1 to 200 characters');
  }
  if (changing) {
    if (!values.get('--operator')) throw new CommandLineError('--operator is required');
    if (!passwordStdin) throw new CommandLineError('--password-stdin is required');
    if (!values.get('--confirm-environment')) {
      throw new CommandLineError('--confirm-environment is required');
    }
  }
  return {
    command,
    orgId: orgId.toLowerCase(),
    operator: values.get('--operator') ?? null,
    reason,
    confirmEnvironment: values.get('--confirm-environment') ?? null,
  };
}

/** Fail closed: APP_ENV exactly as given, never production; state changes confirm it byte for byte. */
export function assertAutomationControlEnvironment(
  appEnv: string | undefined,
  confirm: string | null,
  requireConfirmation: boolean,
): string {
  if (appEnv === undefined || appEnv.trim() === '') {
    throw new AutomationControlRefusal('APP_ENV is not set');
  }
  if (appEnv === 'production') {
    throw new AutomationControlRefusal(
      'APP_ENV is production; this command is not authorised there',
    );
  }
  if (!(AUTOMATION_CONTROL_ALLOWED_ENVIRONMENTS as readonly string[]).includes(appEnv)) {
    throw new AutomationControlRefusal(
      `APP_ENV must be one of ${AUTOMATION_CONTROL_ALLOWED_ENVIRONMENTS.join(', ')}`,
    );
  }
  if (requireConfirmation && confirm !== appEnv) {
    throw new AutomationControlRefusal('--confirm-environment must equal APP_ENV exactly');
  }
  return appEnv;
}

interface OperatorRow {
  readonly id: string;
  readonly status: string;
  readonly passwordHash: string | null;
  readonly superAdmin: boolean;
}

async function loadOperator(q: Database | Transaction, email: string, lock: boolean) {
  const result = await q.execute(sql`
    SELECT u.id, u.status::text AS status, u.password_hash AS "passwordHash",
           EXISTS (
             SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND ur.scope_type = 'platform' AND ur.scope_id IS NULL
                AND r.org_id IS NULL AND r.key = ${OPERATOR_ROLE_KEY}
           ) AS "superAdmin"
      FROM users u
     WHERE lower(u.email) = lower(${email})
     ${lock ? sql`FOR SHARE` : sql``}`);
  return (result.rows[0] as OperatorRow | undefined) ?? null;
}

export interface AutomationControlDeps {
  readonly credentials: Pick<CredentialService, 'verify' | 'verifyDummy'>;
  readonly audit: ReturnType<typeof ownerAuditWriter>;
}

export interface AutomationControlState {
  readonly orgId: string;
  readonly sendingPaused: boolean;
  readonly revokedBefore: string | null;
  readonly revokedCount: number | null;
}

/** Reads the organisation's control row (absent: never paused, never revoked). */
export async function automationControlStatus(
  db: Database,
  orgId: string,
): Promise<AutomationControlState> {
  const org = await db.execute(sql`SELECT 1 FROM organizations WHERE id = ${orgId}`);
  if (org.rows.length === 0) throw new AutomationControlRefusal('no such organization');
  const { rows } = await db.execute<{ sending_paused: boolean; revoked_before: Date | null }>(
    sql`SELECT sending_paused, revoked_before FROM automation_controls WHERE org_id = ${orgId}`,
  );
  return {
    orgId,
    sendingPaused: rows[0]?.sending_paused ?? false,
    revokedBefore: rows[0]?.revoked_before ? new Date(rows[0].revoked_before).toISOString() : null,
    revokedCount: null,
  };
}

/** Authenticates the operator, then applies and audits the control in one transaction. */
export async function applyAutomationControl(
  db: Database,
  deps: AutomationControlDeps,
  request: {
    readonly command: Exclude<AutomationControlCommand, 'status'>;
    readonly orgId: string;
    readonly operatorEmail: string;
    readonly operatorPassword: string;
    readonly reason: string | null;
  },
): Promise<AutomationControlState> {
  const row = await loadOperator(db, request.operatorEmail, false);
  const verified = row?.passwordHash
    ? await deps.credentials.verify(row.passwordHash, request.operatorPassword)
    : await deps.credentials.verifyDummy(request.operatorPassword);
  if (!row || !verified || !row.passwordHash || row.status !== 'active' || !row.superAdmin) {
    throw new AutomationControlRefusal(OPERATOR_NOT_ACCEPTED);
  }
  const operator = { id: row.id, passwordHash: row.passwordHash };
  const correlationId = randomUUID();
  return db.transaction(async (tx) => {
    const again = await loadOperator(tx, request.operatorEmail, true);
    if (
      !again ||
      again.id !== operator.id ||
      again.status !== 'active' ||
      !again.superAdmin ||
      again.passwordHash !== operator.passwordHash
    ) {
      throw new AutomationControlRefusal(
        'the operator is no longer an active platform administrator with that credential',
      );
    }
    const org = await tx.execute(sql`SELECT 1 FROM organizations WHERE id = ${request.orgId}`);
    if (org.rows.length === 0) throw new AutomationControlRefusal('no such organization');
    await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'on', true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${operator.id}, true)`);
    const { rows } = await tx.execute<{
      sending_paused: boolean;
      revoked_before: Date | null;
      revoked_count: number;
    }>(
      sql`SELECT * FROM app_automation_apply_control(${request.orgId}::uuid, ${request.command}, ${operator.id}::uuid, ${AUTOMATION_CONTROL_ACTOR_LABEL}, ${request.reason})`,
    );
    const applied = rows[0]!;
    await deps.audit.record(
      {
        scopeType: 'organization',
        scopeId: request.orgId,
        actorType: 'user',
        actorUserId: operator.id,
        actorApiKeyId: null,
        actorLabel: AUTOMATION_CONTROL_ACTOR_LABEL,
        action: AUDIT_ACTION[request.command] as AuditAction,
        resourceType: 'Organization',
        resourceId: request.orgId,
        outcome: 'success',
        before: null,
        after: { sendingPaused: applied.sending_paused },
        metadata: {
          via: 'automation-control-cli',
          reason: request.reason,
          ...(request.command === 'revoke'
            ? { revokedCapabilities: Number(applied.revoked_count) }
            : {}),
        },
        correlationId,
      },
      tx,
    );
    return {
      orgId: request.orgId,
      sendingPaused: applied.sending_paused,
      revokedBefore: applied.revoked_before ? new Date(applied.revoked_before).toISOString() : null,
      revokedCount: request.command === 'revoke' ? Number(applied.revoked_count) : null,
    };
  });
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
  const parsed = parseAutomationControlCommandLine(argv);
  assertAutomationControlEnvironment(
    env.APP_ENV,
    parsed.confirmEnvironment,
    parsed.command !== 'status',
  );
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (!adminUrl?.trim()) {
    throw new CommandLineError(
      'DATABASE_ADMIN_URL must be set — the command runs as the schema owner',
    );
  }
  const secrets = parsed.command === 'status' ? [] : await readStdinLines(stdin, 1);
  const pool = createPool({
    connectionString: adminUrl,
    max: 1,
    applicationName: 'acc-automation-control',
  });
  const db = createDatabase(pool);
  try {
    const state =
      parsed.command === 'status'
        ? await automationControlStatus(db, parsed.orgId)
        : await applyAutomationControl(
            db,
            { credentials: credentialService(), audit: ownerAuditWriter() },
            {
              command: parsed.command,
              orgId: parsed.orgId,
              operatorEmail: parsed.operator!,
              operatorPassword: secrets[0]!,
              reason: parsed.reason,
            },
          );
    return [
      `organization ${state.orgId}: sending ${state.sendingPaused ? 'PAUSED' : 'active'}`,
      `revoked before: ${state.revokedBefore ?? '-'}${state.revokedCount === null ? '' : `; capabilities revoked now: ${state.revokedCount}`}`,
    ];
  } finally {
    await pool.end();
  }
}

/** Refusal and command-line messages only; any other error is reduced to its SQLSTATE. */
export function describeAutomationControlFailure(error: unknown): string {
  if (error instanceof AutomationControlRefusal || error instanceof CommandLineError) {
    return error.message;
  }
  const code =
    (error as { cause?: { code?: unknown } } | null)?.cause?.code ??
    (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? `automation control failed: database error ${code}; nothing was committed`
    : 'automation control failed: unexpected error; nothing was committed';
}

if (require.main === module) {
  loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
  loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true, override: false });
  main(process.argv.slice(2), process.env, process.stdin)
    .then((lines) => {
      for (const line of lines) console.log(line);
    })
    .catch((error: unknown) => {
      console.error(describeAutomationControlFailure(error));
      process.exitCode = 1;
    });
}
