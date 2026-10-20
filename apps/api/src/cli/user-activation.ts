/**
 * Operator-run activation of an invited tenant user (first release, MVP).
 *
 *   printf '%s\n' "$PASSWORD" | npm run user:activate --workspace @acc/api -- \
 *     --operator <platform admin email> --organization <id or slug> --email <user email> \
 *     --password-stdin
 *
 * `POST /users` creates an identity as `invited`, without a credential, and the
 * product has no invitation-acceptance route yet. This is the sanctioned way to
 * give such a user their first password, and it is kept as narrow as bootstrap:
 *
 *   - Never reachable over HTTP. It runs on the host as the schema owner, like
 *     `bootstrap`, `db:migrate` and `db:seed`.
 *   - Explicit and accountable: the operator names an active platform
 *     administrator holding `users.reactivate` at platform scope, who is
 *     recorded as the actor, and names both the user and the organization.
 *   - Tenant users only, in the named organization: the user must hold a grant
 *     there and no platform or reseller grant (those are bootstrap's or a
 *     platform administrator's to create, never this command's).
 *   - First credential only: an `invited` user with no credential. An active,
 *     disabled or already-credentialed user is refused; nothing is overwritten.
 *   - The password arrives on stdin only — never argv or the environment, so it
 *     is absent from process listings — is hashed by `UserLifecycleService`
 *     (`CredentialService`, Argon2id) and is never stored, logged or echoed.
 *   - Audited: success writes `user.activated` in the same transaction as the
 *     activation; a refusal with a known operator writes a `denied` row.
 */
import { AUDIT_ACTIONS, PERMISSIONS } from '@acc/contracts';
import { schema, type Database, type Transaction } from '@acc/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { AuditWriter } from '../audit/audit-writer.service';
import type { UserLifecycleService } from '../iam/user-lifecycle.service';

export const ACTIVATION_ACTOR_LABEL = 'user_activation_cli';

/**
 * The MVP password rule. The codebase has no password policy yet (bootstrap
 * accepts any non-empty secret); these bounds are the minimum this command
 * enforces, and the upper bound keeps hashing input reasonable.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export class ActivationRefusal extends Error {
  constructor(readonly reason: string) {
    super(`user activation refused: ${reason}`);
    this.name = 'ActivationRefusal';
  }
}

export interface ActivationRequest {
  readonly operatorEmail: string;
  /** The organization's id or slug. */
  readonly organization: string;
  readonly userEmail: string;
  readonly password: string;
}

export interface ActivationResult {
  readonly userId: string;
  readonly email: string;
  readonly orgId: string;
  readonly orgSlug: string;
}

/** The reason a password is unacceptable, or null. Never repeats the password. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `the password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `the password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  if (password.trim() !== password) return 'the password must not start or end with whitespace';
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An active user holding `users.reactivate` through a platform-scope grant. */
async function platformOperator(tx: Transaction, email: string): Promise<string> {
  const rows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
    .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.userRoles.roleId))
    .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
    .where(
      and(
        sql`lower(${schema.users.email}) = lower(${email})`,
        eq(schema.users.status, 'active'),
        eq(schema.userRoles.scopeType, 'platform'),
        isNull(schema.userRoles.scopeId),
        eq(schema.permissions.key, PERMISSIONS.USERS_REACTIVATE),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new ActivationRefusal(
      'the operator must be an active platform administrator holding users.reactivate',
    );
  }
  return rows[0].id;
}

/**
 * Activates one invited tenant user. Throws `ActivationRefusal` (after writing a
 * `denied` audit row when the operator is known) for every refused request.
 */
export async function activateInvitedUser(
  db: Database,
  deps: { readonly users: UserLifecycleService; readonly audit: AuditWriter },
  request: ActivationRequest,
): Promise<ActivationResult> {
  const correlationId = uuidv7();
  const known: { operatorId?: string; orgId?: string; userId?: string } = {};

  try {
    return await db.transaction(async (tx) => {
      known.operatorId = await platformOperator(tx, request.operatorEmail);

      const problem = passwordProblem(request.password);
      if (problem) throw new ActivationRefusal(problem);

      const [org] = await tx
        .select({
          id: schema.organizations.id,
          slug: schema.organizations.slug,
          status: schema.organizations.status,
        })
        .from(schema.organizations)
        .where(
          UUID.test(request.organization)
            ? eq(schema.organizations.id, request.organization)
            : eq(schema.organizations.slug, request.organization),
        );
      if (!org) throw new ActivationRefusal(`organization ${request.organization} not found`);
      known.orgId = org.id;
      if (org.status !== 'active') {
        throw new ActivationRefusal(`organization ${org.slug} is ${org.status}, not active`);
      }

      // Locked, so a concurrent activation or administrative change waits.
      const locked = await tx.execute(
        sql`SELECT id, email, status::text AS status, password_hash IS NOT NULL AS "hasCredential"
              FROM users WHERE lower(email) = lower(${request.userEmail}) FOR UPDATE`,
      );
      const user = locked.rows[0] as
        { id: string; email: string; status: string; hasCredential: boolean } | undefined;
      if (!user) throw new ActivationRefusal(`no user ${request.userEmail}`);
      known.userId = user.id;
      if (user.status !== 'invited') {
        throw new ActivationRefusal(`the user is ${user.status}, not invited`);
      }
      if (user.hasCredential) throw new ActivationRefusal('the user already has a credential');

      const grants = await tx
        .select({ scopeType: schema.userRoles.scopeType, orgId: schema.userRoles.orgId })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, user.id));
      if (grants.some((g) => g.scopeType === 'platform' || g.scopeType === 'reseller')) {
        throw new ActivationRefusal(
          'the user holds a platform or reseller grant; this command activates tenant users only',
        );
      }
      if (!grants.some((g) => g.orgId === org.id)) {
        throw new ActivationRefusal(`the user holds no grant in organization ${org.slug}`);
      }

      const activated = await deps.users.activate(tx, user.id, request.password);
      await deps.audit.record(
        {
          scopeType: 'organization',
          scopeId: org.id,
          actorType: 'user',
          actorUserId: known.operatorId,
          actorApiKeyId: null,
          actorLabel: ACTIVATION_ACTOR_LABEL,
          action: AUDIT_ACTIONS.USER_ACTIVATED,
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
          before: { status: 'invited' },
          after: { status: activated.status },
          metadata: { via: 'activate-user-cli' },
          correlationId,
        },
        tx,
      );
      return { userId: user.id, email: activated.email, orgId: org.id, orgSlug: org.slug };
    });
  } catch (error) {
    if (error instanceof ActivationRefusal && known.operatorId) {
      const operatorId = known.operatorId;
      await db.transaction((tx) =>
        deps.audit.record(
          {
            scopeType: known.orgId ? 'organization' : 'platform',
            scopeId: known.orgId ?? null,
            actorType: 'user',
            actorUserId: operatorId,
            actorApiKeyId: null,
            actorLabel: ACTIVATION_ACTOR_LABEL,
            action: AUDIT_ACTIONS.USER_ACTIVATED,
            resourceType: 'user',
            resourceId: known.userId ?? null,
            outcome: 'denied',
            before: null,
            after: null,
            metadata: { via: 'activate-user-cli', reason: error.reason },
            correlationId,
          },
          tx,
        ),
      );
    }
    throw error;
  }
}
