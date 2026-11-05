/**
 * Owner-run Platform Support provisioning (ADR-015 Item 5 Amendment A-1,
 * `RBAC.md` §5b.1). The logic behind `platform:support create | revoke | status`.
 *
 * Item 5 keeps platform-role grants off the API. This is the one sanctioned way
 * to create — and later remove — an `alendei_support` principal, and it is kept
 * as narrow as `bootstrap`:
 *
 *   - Never reachable over HTTP; no controller or Nest module imports it. It runs
 *     on the host as the schema owner, like `bootstrap` and `user:activate`.
 *   - It grants exactly one thing: `alendei_support` at `platform` scope. The role
 *     key is the constant below; nothing here takes a role, scope or SQL input.
 *   - Every state change is made by an operator who is an active
 *     `alendei_super_admin` and who has just presented their own password; the
 *     operator is re-validated inside the transaction that makes the change.
 *   - `create` and `revoke` are each one transaction, audit rows included, so a
 *     failure anywhere leaves nothing behind. Refusals by a known operator are
 *     recorded as `denied` rows in a transaction of their own.
 *   - Passwords are parameters of these functions only: never stored in plain
 *     text, logged, echoed or written to an audit image.
 *
 * **Known limitation (accepted in A-1).** As the schema owner the session
 * bypasses RLS, so `fn_validate_user_role_scope` accepts the platform grant on
 * the owner's authority: the database does not independently verify that the
 * operator is a super administrator. That check is this module's — before the
 * transaction (`authenticateOperator`) and again inside it (`revalidate`).
 */
import { AUDIT_ACTIONS, PLATFORM_ROLE_KEYS, type AuditAction } from '@acc/contracts';
import { type Database, type Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { AuditWriter } from '../audit/audit-writer.service';
import type { CredentialService } from '../iam/credential.service';
import type { SessionService } from '../iam/session.service';
import type { UserLifecycleService } from '../iam/user-lifecycle.service';
import { passwordProblem } from './user-activation';

export const PLATFORM_SUPPORT_ACTOR_LABEL = 'platform_support_cli';
export const PLATFORM_SUPPORT_SESSION_REVOCATION_REASON = 'platform_support_revoked';

/** The only role this module can grant or revoke. Not configurable, by design. */
const SUPPORT_ROLE_KEY = PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT;
const OPERATOR_ROLE_KEY = PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN;

/**
 * The environments the command may run in (A-1 decision 12). `production` is
 * absent and is refused unconditionally; anything else, or nothing, is refused.
 */
export const PLATFORM_SUPPORT_ALLOWED_ENVIRONMENTS = ['staging', 'test', 'development'] as const;

export type RefusalCode =
  | 'environment'
  | 'operator_unknown'
  | 'operator_not_eligible'
  | 'operator_authentication_failed'
  | 'operator_changed'
  | 'password_rule'
  | 'password_reuse'
  | 'duplicate_identity'
  | 'target_not_found'
  | 'target_not_platform_support'
  | 'self_revocation'
  | 'usable_api_key'
  | 'postcondition';

export class PlatformSupportRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly reason: string,
  ) {
    super(`platform support refused: ${reason}`);
    this.name = 'PlatformSupportRefusal';
  }
}

/**
 * Fail-closed environment check (A-1 decision 12). Reads `APP_ENV` exactly as
 * given — never the schema default, never `NODE_ENV`. `confirm` is required for
 * the state-changing commands and must equal `APP_ENV` byte for byte; it can
 * never admit `production`.
 */
export function assertPlatformSupportEnvironment(
  appEnv: string | undefined,
  confirm: string | undefined | null,
  options: { readonly requireConfirmation: boolean },
): string {
  if (appEnv === undefined || appEnv.trim() === '') {
    throw new PlatformSupportRefusal('environment', 'APP_ENV is not set');
  }
  if (appEnv === 'production') {
    throw new PlatformSupportRefusal(
      'environment',
      'APP_ENV is production; platform support provisioning is prohibited there',
    );
  }
  if (!(PLATFORM_SUPPORT_ALLOWED_ENVIRONMENTS as readonly string[]).includes(appEnv)) {
    throw new PlatformSupportRefusal(
      'environment',
      `APP_ENV must be one of ${PLATFORM_SUPPORT_ALLOWED_ENVIRONMENTS.join(', ')}`,
    );
  }
  if (options.requireConfirmation && confirm !== appEnv) {
    throw new PlatformSupportRefusal(
      'environment',
      '--confirm-environment must equal APP_ENV exactly',
    );
  }
  return appEnv;
}

/**
 * Optional checkpoints, for the concurrency and fault-injection tests only. The
 * command passes none. A checkpoint that throws aborts the operation exactly as
 * a database failure at that point would.
 */
export type PlatformSupportCheckpoint =
  | 'before-transaction'
  | 'create:after-invite'
  | 'create:after-grant'
  | 'create:after-activate'
  | 'create:after-audit'
  | 'revoke:after-grant-delete'
  | 'revoke:after-sessions'
  | 'revoke:after-credentials'
  | 'revoke:after-audit';

export interface PlatformSupportDeps {
  readonly users: UserLifecycleService;
  readonly credentials: CredentialService;
  readonly sessions: SessionService;
  readonly audit: AuditWriter;
  readonly checkpoint?: (point: PlatformSupportCheckpoint) => Promise<void>;
}

export interface CreateRequest {
  readonly appEnv: string | undefined;
  readonly operatorEmail: string;
  readonly operatorPassword: string;
  readonly userEmail: string;
  readonly password: string;
}

export interface CreateResult {
  readonly userId: string;
  readonly email: string;
  readonly grantId: string;
  readonly correlationId: string;
}

export interface RevokeRequest {
  readonly appEnv: string | undefined;
  readonly operatorEmail: string;
  readonly operatorPassword: string;
  readonly userEmail: string;
}

export interface RevokeResult {
  readonly userId: string;
  readonly email: string;
  readonly revokedGrantId: string;
  readonly sessionsRevoked: number;
  readonly correlationId: string;
}

export type IdentityClass = 'not_found' | 'platform_support_active' | 'revoked' | 'other';

export interface StatusResult {
  readonly classification: IdentityClass;
  readonly userId: string | null;
  readonly status: string | null;
  readonly hasPassword: boolean;
  readonly mfaEnabled: boolean;
  readonly hasMfaSecretRef: boolean;
  readonly grants: readonly { roleKey: string; scopeType: string; scopeId: string | null }[];
  readonly liveSessions: number;
  readonly unrevokedSessions: number;
  readonly usableApiKeys: number;
  readonly recentAudit: readonly { action: string; outcome: string; createdAt: string }[];
}

// --- operator ------------------------------------------------------------------------------

interface OperatorRow {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly passwordHash: string | null;
  readonly superAdmin: boolean;
}

async function loadOperator(q: Database | Transaction, email: string, lock: boolean) {
  const result = await q.execute(sql`
    SELECT u.id, u.email, u.status::text AS status, u.password_hash AS "passwordHash",
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

interface Operator {
  readonly id: string;
  readonly passwordHash: string;
}

/**
 * Who is acting, and whether they proved it. Set as soon as an operator
 * identity is found, so a refusal after that point is attributable.
 */
interface RunContext {
  readonly command: 'create' | 'revoke';
  readonly correlationId: string;
  readonly targetEmail: string;
  operatorId?: string;
  operatorAuthenticated: boolean;
  targetUserId?: string;
}

/**
 * Fresh authentication: an active `alendei_super_admin` at platform scope whose
 * stored digest matches the password presented now. One attempt per run.
 */
async function authenticateOperator(
  db: Database,
  deps: PlatformSupportDeps,
  ctx: RunContext,
  email: string,
  password: string,
): Promise<Operator> {
  const row = await loadOperator(db, email, false);
  if (!row) {
    // Spend the same verification cost, so an unknown address is not cheaper.
    await deps.credentials.verifyDummy(password);
    throw new PlatformSupportRefusal(
      'operator_unknown',
      'the operator must be an active platform administrator',
    );
  }
  ctx.operatorId = row.id;
  const verified = row.passwordHash
    ? await deps.credentials.verify(row.passwordHash, password)
    : await deps.credentials.verifyDummy(password);
  if (row.status !== 'active' || !row.superAdmin) {
    throw new PlatformSupportRefusal(
      'operator_not_eligible',
      'the operator must be an active platform administrator',
    );
  }
  if (!verified || !row.passwordHash) {
    throw new PlatformSupportRefusal(
      'operator_authentication_failed',
      'the operator password was not accepted',
    );
  }
  ctx.operatorAuthenticated = true;
  return { id: row.id, passwordHash: row.passwordHash };
}

/**
 * Inside the changing transaction: the same operator, still active, still a
 * super administrator, with the credential that was just verified. `FOR SHARE`
 * holds the operator row until commit, so a concurrent disable or password
 * change waits for this transaction rather than interleaving with it.
 */
async function revalidate(tx: Transaction, operator: Operator, email: string): Promise<void> {
  const row = await loadOperator(tx, email, true);
  if (
    !row ||
    row.id !== operator.id ||
    row.status !== 'active' ||
    !row.superAdmin ||
    row.passwordHash !== operator.passwordHash
  ) {
    throw new PlatformSupportRefusal(
      'operator_changed',
      'the operator is no longer an active platform administrator with that credential',
    );
  }
}

/**
 * Transaction-local elevation, exactly as `bootstrap` does: gone at commit or
 * rollback. `app.current_user_id` names the operator for anything that reads it.
 */
async function elevate(tx: Transaction, operatorId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.is_platform_admin', 'on', true)`);
  await tx.execute(sql`SELECT set_config('app.current_user_id', ${operatorId}, true)`);
}

/** Serialises every create/revoke of one address, whoever runs it. */
async function lockAddress(tx: Transaction, email: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`acc:platform-support:${email.toLowerCase()}`}, 0))`,
  );
}

// --- audit ---------------------------------------------------------------------------------

function audit(
  deps: PlatformSupportDeps,
  tx: Transaction,
  ctx: RunContext,
  entry: {
    action: AuditAction;
    resourceType: 'user' | 'user_role';
    resourceId: string | null;
    outcome: 'success' | 'denied';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  },
) {
  return deps.audit.record(
    {
      scopeType: 'platform',
      scopeId: null,
      actorType: 'user',
      actorUserId: ctx.operatorId!,
      actorApiKeyId: null,
      actorLabel: PLATFORM_SUPPORT_ACTOR_LABEL,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      outcome: entry.outcome,
      before: entry.before,
      after: entry.after,
      metadata: {
        via: 'platform-support-cli',
        command: ctx.command,
        email: ctx.targetEmail,
        ...entry.metadata,
      },
      correlationId: ctx.correlationId,
    },
    tx,
  );
}

/** A refusal by a known operator, recorded after the failed transaction rolled back. */
async function recordRefusal(
  db: Database,
  deps: PlatformSupportDeps,
  ctx: RunContext,
  refusal: PlatformSupportRefusal,
): Promise<void> {
  if (!ctx.operatorId) return;
  await db.transaction((tx) =>
    audit(deps, tx, ctx, {
      action:
        ctx.command === 'create'
          ? AUDIT_ACTIONS.USER_ROLE_GRANTED
          : AUDIT_ACTIONS.USER_ROLE_REVOKED,
      resourceType: 'user',
      resourceId: ctx.targetUserId ?? null,
      outcome: 'denied',
      before: null,
      after: null,
      metadata: {
        reason: refusal.code,
        detail: refusal.reason,
        roleKey: SUPPORT_ROLE_KEY,
        operatorAuthenticated: ctx.operatorAuthenticated,
      },
    }),
  );
}

// --- state checks ----------------------------------------------------------------------------

interface GrantRow {
  readonly id: string;
  readonly roleKey: string;
  readonly roleOrgId: string | null;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly orgId: string | null;
}

async function grantsOf(q: Database | Transaction, userId: string): Promise<GrantRow[]> {
  const result = await q.execute(sql`
    SELECT ur.id, r.key AS "roleKey", r.org_id AS "roleOrgId", ur.scope_type::text AS "scopeType",
           ur.scope_id AS "scopeId", ur.org_id AS "orgId"
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ${userId}
     ORDER BY ur.created_at, ur.id`);
  return result.rows as unknown as GrantRow[];
}

const isSupportGrant = (g: GrantRow) =>
  g.roleKey === SUPPORT_ROLE_KEY &&
  g.roleOrgId === null &&
  g.scopeType === 'platform' &&
  g.scopeId === null &&
  g.orgId === null;

interface CredentialState {
  readonly status: string;
  readonly hasPassword: boolean;
  readonly mfaEnabled: boolean;
  readonly hasMfaSecretRef: boolean;
  readonly liveSessions: number;
  readonly unrevokedSessions: number;
  readonly usableApiKeys: number;
}

async function credentialState(
  q: Database | Transaction,
  userId: string,
): Promise<CredentialState> {
  const result = await q.execute(sql`
    SELECT u.status::text AS status,
           (u.password_hash IS NOT NULL) AS "hasPassword",
           u.mfa_enabled AS "mfaEnabled",
           (u.mfa_secret_ref IS NOT NULL) AS "hasMfaSecretRef",
           (SELECT count(*)::int FROM sessions s
             WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.rotated_at IS NULL
               AND s.expires_at > now()) AS "liveSessions",
           (SELECT count(*)::int FROM sessions s
             WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS "unrevokedSessions",
           (SELECT count(*)::int FROM api_keys k
             WHERE k.created_by = u.id AND k.revoked_at IS NULL
               AND (k.expires_at IS NULL OR k.expires_at > now())) AS "usableApiKeys"
      FROM users u WHERE u.id = ${userId}`);
  const row = result.rows[0] as CredentialState | undefined;
  if (!row) throw new PlatformSupportRefusal('postcondition', 'the identity disappeared');
  return row;
}

function postcondition(ok: boolean, what: string): void {
  if (!ok) throw new PlatformSupportRefusal('postcondition', `post-condition failed: ${what}`);
}

// --- create --------------------------------------------------------------------------------

/**
 * Creates a new `active` identity holding exactly one grant, `alendei_support`
 * at platform scope, with its audit rows, in one transaction.
 */
export async function createPlatformSupportUser(
  db: Database,
  deps: PlatformSupportDeps,
  request: CreateRequest,
): Promise<CreateResult> {
  // Defence in depth: the command checks the environment before connecting;
  // this function refuses on its own as well.
  assertPlatformSupportEnvironment(request.appEnv, null, { requireConfirmation: false });
  const ctx: RunContext = {
    command: 'create',
    correlationId: uuidv7(),
    targetEmail: request.userEmail,
    operatorAuthenticated: false,
  };
  const checkpoint = deps.checkpoint ?? (async () => {});

  try {
    const operator = await authenticateOperator(
      db,
      deps,
      ctx,
      request.operatorEmail,
      request.operatorPassword,
    );
    const problem = passwordProblem(request.password);
    if (problem) throw new PlatformSupportRefusal('password_rule', problem);
    if (request.password === request.operatorPassword) {
      throw new PlatformSupportRefusal(
        'password_reuse',
        "the new password must differ from the operator's password",
      );
    }
    // Hashed before the transaction opens: the Argon2 cost is not spent holding locks.
    const digest = await deps.credentials.hash(request.password);
    await checkpoint('before-transaction');

    return await db.transaction(async (tx) => {
      await elevate(tx, operator.id);
      await lockAddress(tx, request.userEmail);
      await revalidate(tx, operator, request.operatorEmail);

      const existing = await tx.execute(
        sql`SELECT id, status::text AS status FROM users WHERE lower(email) = lower(${request.userEmail})`,
      );
      const found = existing.rows[0] as { id: string; status: string } | undefined;
      if (found) {
        ctx.targetUserId = found.id;
        throw new PlatformSupportRefusal(
          'duplicate_identity',
          `an identity with this address already exists (${found.status}); identities are never reused`,
        );
      }

      const invited = await deps.users.invite(tx, request.userEmail).catch((error: unknown) => {
        const cause = (error as { cause?: { code?: string } }).cause ?? error;
        if ((cause as { code?: string }).code === '23505') {
          throw new PlatformSupportRefusal(
            'duplicate_identity',
            'an identity with this address already exists; identities are never reused',
          );
        }
        throw error;
      });
      ctx.targetUserId = invited.id;
      await audit(deps, tx, ctx, {
        action: AUDIT_ACTIONS.USER_INVITED,
        resourceType: 'user',
        resourceId: invited.id,
        outcome: 'success',
        before: null,
        after: { email: invited.email, status: invited.status },
      });
      await checkpoint('create:after-invite');

      const role = await tx.execute(
        sql`SELECT id FROM roles WHERE key = ${SUPPORT_ROLE_KEY} AND org_id IS NULL`,
      );
      const roleId = (role.rows[0] as { id: string } | undefined)?.id;
      if (!roleId) {
        throw new Error(`platform support: the ${SUPPORT_ROLE_KEY} role is missing — run the seed`);
      }
      const granted = await tx.execute(sql`
        INSERT INTO user_roles (user_id, role_id, scope_type, scope_id, granted_by)
        VALUES (${invited.id}, ${roleId}, 'platform', NULL, ${operator.id})
        RETURNING id`);
      const grantId = (granted.rows[0] as { id: string }).id;
      await audit(deps, tx, ctx, {
        action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
        resourceType: 'user_role',
        resourceId: grantId,
        outcome: 'success',
        before: null,
        after: {
          userId: invited.id,
          email: invited.email,
          roleKey: SUPPORT_ROLE_KEY,
          scopeType: 'platform',
          scopeId: null,
        },
      });
      await checkpoint('create:after-grant');

      const activated = await deps.users.activateWithDigest(tx, invited.id, digest);
      await audit(deps, tx, ctx, {
        action: AUDIT_ACTIONS.USER_ACTIVATED,
        resourceType: 'user',
        resourceId: invited.id,
        outcome: 'success',
        before: { email: invited.email, status: 'invited' },
        after: { email: activated.email, status: activated.status },
      });
      await checkpoint('create:after-activate');

      const grants = await grantsOf(tx, invited.id);
      postcondition(grants.length === 1, 'exactly one grant');
      postcondition(
        isSupportGrant(grants[0]!),
        `the grant is ${SUPPORT_ROLE_KEY} at platform scope`,
      );
      postcondition(!grants.some((g) => g.orgId !== null), 'no tenant membership');
      postcondition(!grants.some((g) => g.roleKey === OPERATOR_ROLE_KEY), 'no super-admin grant');
      const state = await credentialState(tx, invited.id);
      postcondition(state.status === 'active' && state.hasPassword, 'active with a password');
      postcondition(!state.mfaEnabled && !state.hasMfaSecretRef, 'no MFA factor');
      postcondition(state.unrevokedSessions === 0, 'no sessions');
      postcondition(state.usableApiKeys === 0, 'no API keys');
      await checkpoint('create:after-audit');

      return {
        userId: invited.id,
        email: activated.email,
        grantId,
        correlationId: ctx.correlationId,
      };
    });
  } catch (error) {
    if (error instanceof PlatformSupportRefusal) await recordRefusal(db, deps, ctx, error);
    throw error;
  }
}

// --- revoke --------------------------------------------------------------------------------

/**
 * Removes the `alendei_support` grant, revokes every session, clears the
 * password digest and MFA reference and disables the identity, with its audit
 * rows, in one transaction. Refuses any identity that is not exactly a
 * platform-support identity, and refuses the operator themself.
 */
export async function revokePlatformSupportUser(
  db: Database,
  deps: PlatformSupportDeps,
  request: RevokeRequest,
): Promise<RevokeResult> {
  assertPlatformSupportEnvironment(request.appEnv, null, { requireConfirmation: false });
  const ctx: RunContext = {
    command: 'revoke',
    correlationId: uuidv7(),
    targetEmail: request.userEmail,
    operatorAuthenticated: false,
  };
  const checkpoint = deps.checkpoint ?? (async () => {});

  try {
    const operator = await authenticateOperator(
      db,
      deps,
      ctx,
      request.operatorEmail,
      request.operatorPassword,
    );
    await checkpoint('before-transaction');

    return await db.transaction(async (tx) => {
      await elevate(tx, operator.id);
      await lockAddress(tx, request.userEmail);
      await revalidate(tx, operator, request.operatorEmail);

      // Row lock before the session advisory lock (`SessionService` lock order).
      const located = await tx.execute(sql`
        SELECT id, email, status::text AS status, (password_hash IS NOT NULL) AS "hasPassword",
               mfa_enabled AS "mfaEnabled"
          FROM users WHERE lower(email) = lower(${request.userEmail}) FOR UPDATE`);
      const target = located.rows[0] as
        | { id: string; email: string; status: string; hasPassword: boolean; mfaEnabled: boolean }
        | undefined;
      if (!target) {
        throw new PlatformSupportRefusal('target_not_found', 'no identity with this address');
      }
      ctx.targetUserId = target.id;
      if (target.id === operator.id) {
        throw new PlatformSupportRefusal('self_revocation', 'an operator cannot revoke themself');
      }

      const grants = await grantsOf(tx, target.id);
      if (grants.length !== 1 || !isSupportGrant(grants[0]!)) {
        throw new PlatformSupportRefusal(
          'target_not_platform_support',
          `the identity does not hold exactly one ${SUPPORT_ROLE_KEY} grant at platform scope and nothing else`,
        );
      }
      if (target.status !== 'active' && target.status !== 'invited') {
        throw new PlatformSupportRefusal(
          'target_not_platform_support',
          `the identity is ${target.status}`,
        );
      }
      const before = await credentialState(tx, target.id);
      if (before.usableApiKeys > 0) {
        throw new PlatformSupportRefusal(
          'usable_api_key',
          'the identity has created API keys that are still usable; revoke them first',
        );
      }

      const grant = grants[0]!;
      await tx.execute(sql`DELETE FROM user_roles WHERE id = ${grant.id}`);
      await audit(deps, tx, ctx, {
        action: AUDIT_ACTIONS.USER_ROLE_REVOKED,
        resourceType: 'user_role',
        resourceId: grant.id,
        outcome: 'success',
        before: {
          userId: target.id,
          email: target.email,
          roleKey: SUPPORT_ROLE_KEY,
          scopeType: 'platform',
          scopeId: null,
        },
        after: null,
      });
      await checkpoint('revoke:after-grant-delete');

      const sessionsRevoked = await deps.sessions.revokeAllForUser(
        tx,
        target.id,
        PLATFORM_SUPPORT_SESSION_REVOCATION_REASON,
      );
      await checkpoint('revoke:after-sessions');

      const disabled = await deps.users.disableAndClearCredentials(tx, target.id);
      await checkpoint('revoke:after-credentials');
      await audit(deps, tx, ctx, {
        action: AUDIT_ACTIONS.USER_DISABLED,
        resourceType: 'user',
        resourceId: target.id,
        outcome: 'success',
        before: {
          email: target.email,
          status: target.status,
          hadPassword: target.hasPassword,
          mfaEnabled: target.mfaEnabled,
        },
        after: { email: disabled.email, status: disabled.status, credentialCleared: true },
        metadata: { sessionsRevoked },
      });

      postcondition((await grantsOf(tx, target.id)).length === 0, 'no grant remains');
      const after = await credentialState(tx, target.id);
      postcondition(after.status === 'disabled', 'the identity is disabled');
      postcondition(!after.hasPassword, 'no password digest remains');
      postcondition(!after.mfaEnabled && !after.hasMfaSecretRef, 'no MFA factor remains');
      postcondition(after.unrevokedSessions === 0, 'no session remains unrevoked');
      postcondition(after.usableApiKeys === 0, 'no usable API key remains');
      await checkpoint('revoke:after-audit');

      return {
        userId: target.id,
        email: target.email,
        revokedGrantId: grant.id,
        sessionsRevoked,
        correlationId: ctx.correlationId,
      };
    });
  } catch (error) {
    if (error instanceof PlatformSupportRefusal) await recordRefusal(db, deps, ctx, error);
    throw error;
  }
}

// --- status --------------------------------------------------------------------------------

/** A read-only report, in a `READ ONLY` transaction: it cannot write even by mistake. */
export async function platformSupportStatus(
  db: Database,
  appEnv: string | undefined,
  email: string,
): Promise<StatusResult> {
  assertPlatformSupportEnvironment(appEnv, null, { requireConfirmation: false });
  return db.transaction(
    async (tx) => {
      const found = await tx.execute(
        sql`SELECT id FROM users WHERE lower(email) = lower(${email})`,
      );
      const userId = (found.rows[0] as { id: string } | undefined)?.id ?? null;
      if (!userId) {
        return {
          classification: 'not_found',
          userId: null,
          status: null,
          hasPassword: false,
          mfaEnabled: false,
          hasMfaSecretRef: false,
          grants: [],
          liveSessions: 0,
          unrevokedSessions: 0,
          usableApiKeys: 0,
          recentAudit: [],
        };
      }
      const grants = await grantsOf(tx, userId);
      const state = await credentialState(tx, userId);
      const auditRows = await tx.execute(sql`
        SELECT action, outcome::text AS outcome, created_at AS "createdAt"
          FROM audit_logs
         WHERE resource_id = ${userId}
            OR (after->>'userId') = ${userId} OR (before->>'userId') = ${userId}
         ORDER BY created_at DESC, id DESC
         LIMIT 10`);
      const classification: IdentityClass =
        grants.length === 1 &&
        isSupportGrant(grants[0]!) &&
        state.status === 'active' &&
        state.hasPassword
          ? 'platform_support_active'
          : grants.length === 0 &&
              state.status === 'disabled' &&
              !state.hasPassword &&
              !state.hasMfaSecretRef &&
              state.unrevokedSessions === 0
            ? 'revoked'
            : 'other';
      return {
        classification,
        userId,
        status: state.status,
        hasPassword: state.hasPassword,
        mfaEnabled: state.mfaEnabled,
        hasMfaSecretRef: state.hasMfaSecretRef,
        grants: grants.map((g) => ({
          roleKey: g.roleKey,
          scopeType: g.scopeType,
          scopeId: g.scopeId,
        })),
        liveSessions: state.liveSessions,
        unrevokedSessions: state.unrevokedSessions,
        usableApiKeys: state.usableApiKeys,
        recentAudit: (
          auditRows.rows as { action: string; outcome: string; createdAt: Date | string }[]
        ).map((r) => ({
          action: r.action,
          outcome: r.outcome,
          createdAt: new Date(r.createdAt).toISOString(),
        })),
      };
    },
    { accessMode: 'read only' },
  );
}
