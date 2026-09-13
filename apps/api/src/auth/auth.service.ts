import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  anonymousLoginFailureActor,
  type AuthPrincipal,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AppException } from '../common/errors/app.exception';
import { AuditWriter } from '../audit/audit-writer.service';
import { CredentialService } from '../iam/credential.service';
import { SessionService } from '../iam/session.service';
import { UserLifecycleService } from '../iam/user-lifecycle.service';
import { hashRefreshToken } from '../iam/refresh-token';
import { TenantDatabase } from '../database/tenant-database.service';
import { AccessTokenService } from './jwt.service';

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
}

export interface AuthTokens {
  readonly accessToken: string;
  readonly expiresIn: number;
  /** Returned to the transport layer only, to be set as an httpOnly cookie. */
  readonly refreshToken: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly current: boolean;
}

/**
 * Authentication orchestration (`RBAC.md` §5a).
 *
 * Every mutation here runs inside one `acc_auth` transaction together with its
 * audit row, so the two share a fate (ADR-003 D-2). `acc_auth` is the right
 * principal because all of this happens before a tenant context exists — and it
 * is the same principal that owns `sessions`, which is what makes the coupling
 * possible at all.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly credentials: CredentialService,
    private readonly users: UserLifecycleService,
    private readonly sessions: SessionService,
    private readonly tokens: AccessTokenService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Verifies a password and starts a session.
   *
   * Unknown address, wrong password and non-active account are indistinguishable
   * to the caller: identical error, and comparable work, because an unknown
   * address still pays for a full Argon2id verification through `verifyDummy`.
   * A response that returned faster for an unknown email would be a user
   * enumeration oracle regardless of what the body said.
   */
  async login(email: string, password: string, meta: RequestMeta): Promise<AuthTokens> {
    const invalid = (): AppException =>
      new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        message: 'Email or password is incorrect',
      });

    const outcome = await this.db.auth.transaction(async (tx) => {
      const user = await this.users.findByEmail(tx as Transaction, email);

      if (!user) {
        await this.credentials.verifyDummy(password);
        await this.recordAnonymousFailure(tx as Transaction, meta, 'unknown_identity');
        return null;
      }

      const digest = await this.users.passwordDigest(tx as Transaction, user.id);
      const passwordOk = digest
        ? await this.credentials.verify(digest, password)
        : await this.credentials.verifyDummy(password);

      // Status is checked independently of the digest: a disabled account whose
      // password still verifies must not authenticate.
      if (!passwordOk || !this.users.canAuthenticate(user)) {
        await this.audit.record(
          {
            scopeType: 'platform',
            scopeId: null,
            actorType: 'user',
            actorUserId: user.id,
            actorApiKeyId: null,
            actorLabel: null,
            action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
            resourceType: 'auth',
            resourceId: user.id,
            outcome: 'failure',
            before: null,
            after: null,
            metadata: { reason: passwordOk ? 'account_not_active' : 'invalid_password' },
            correlationId: meta.correlationId,
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
          tx as Transaction,
        );
        return null;
      }

      const { session, refresh } = await this.sessions.create(tx as Transaction, {
        userId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      await tx
        .update(schema.users)
        .set({ lastLoginAt: new Date() })
        .where(eq(schema.users.id, user.id));

      // Transparent upgrade when the configured cost has since increased.
      if (digest && this.credentials.needsRehash(digest)) {
        const rehashed = await this.credentials.hash(password);
        await tx
          .update(schema.users)
          .set({ passwordHash: rehashed, passwordUpdatedAt: new Date() })
          .where(eq(schema.users.id, user.id));
      }

      await this.audit.record(
        {
          scopeType: 'platform',
          scopeId: null,
          actorType: 'user',
          actorUserId: user.id,
          actorApiKeyId: null,
          actorLabel: null,
          action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
          resourceType: 'session',
          resourceId: session.id,
          outcome: 'success',
          before: null,
          after: { sessionId: session.id },
          metadata: {},
          correlationId: meta.correlationId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx as Transaction,
      );

      const issued = this.tokens.issue({ userId: user.id, sessionId: session.id });
      return {
        accessToken: issued.token,
        expiresIn: issued.expiresIn,
        refreshToken: refresh.token,
        sessionId: session.id,
        userId: user.id,
      } satisfies AuthTokens;
    });

    if (!outcome) throw invalid();
    return outcome;
  }

  /**
   * Records a failure that cannot be attributed to a real identity (ADR-003 R4).
   *
   * A separate transaction, because the caller's transaction may itself be
   * rolled back and this record must survive: an unknown-address attempt has no
   * business mutation to be atomic with, and losing it would make credential
   * stuffing invisible.
   */
  private async recordAnonymousFailure(
    _tx: Transaction,
    meta: RequestMeta,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      scopeType: 'platform',
      scopeId: null,
      ...anonymousLoginFailureActor(),
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      resourceType: 'auth',
      resourceId: null,
      outcome: 'failure',
      before: null,
      after: null,
      // The attempted address is deliberately not recorded: it is unverified
      // caller input, and writing it would turn the audit log into a list of
      // addresses someone probed.
      metadata: { reason },
      correlationId: meta.correlationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Rotates a refresh token.
   *
   * Delegates the race to `SessionService.rotate`, whose conditional UPDATE is
   * what makes two concurrent refreshes of one token produce exactly one winner.
   * A `reuse_detected` outcome is a replayed token: the whole family is revoked
   * and the caller is refused, because the alternative — letting the legitimate
   * holder continue — leaves a thief with a working chain.
   */
  async refresh(presentedToken: string, meta: RequestMeta): Promise<AuthTokens> {
    const revoked = (): AppException =>
      new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_SESSION_REVOKED,
        message: 'This session is no longer valid; sign in again',
      });

    const result = await this.db.auth.transaction(async (tx) => {
      const hash = hashRefreshToken(presentedToken);
      const existing = await this.sessions.findByRefreshTokenHash(tx as Transaction, hash);
      if (!existing) return { kind: 'invalid' as const };

      const user = await this.users.findById(tx as Transaction, existing.userId);
      if (!user || !this.users.canAuthenticate(user)) return { kind: 'invalid' as const };

      const outcome = await this.sessions.rotate(tx as Transaction, existing.id, {
        userId: existing.userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      if (outcome.status !== 'rotated') {
        await this.audit.record(
          {
            scopeType: 'platform',
            scopeId: null,
            actorType: 'user',
            actorUserId: existing.userId,
            actorApiKeyId: null,
            actorLabel: null,
            action: AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED,
            resourceType: 'session',
            resourceId: existing.id,
            outcome: 'failure',
            before: null,
            after: null,
            metadata:
              outcome.status === 'reuse_detected'
                ? { reason: 'refresh_token_reuse_detected', familyRevoked: true }
                : { reason: outcome.reason },
            correlationId: meta.correlationId,
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
          tx as Transaction,
        );
        return { kind: 'refused' as const };
      }

      await this.audit.record(
        {
          scopeType: 'platform',
          scopeId: null,
          actorType: 'user',
          actorUserId: existing.userId,
          actorApiKeyId: null,
          actorLabel: null,
          action: AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED,
          resourceType: 'session',
          resourceId: outcome.session.id,
          outcome: 'success',
          before: { sessionId: existing.id },
          after: { sessionId: outcome.session.id },
          metadata: {},
          correlationId: meta.correlationId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx as Transaction,
      );

      const issued = this.tokens.issue({
        userId: existing.userId,
        sessionId: outcome.session.id,
      });
      return {
        kind: 'rotated' as const,
        tokens: {
          accessToken: issued.token,
          expiresIn: issued.expiresIn,
          refreshToken: outcome.refresh.token,
          sessionId: outcome.session.id,
          userId: existing.userId,
        } satisfies AuthTokens,
      };
    });

    if (result.kind !== 'rotated') throw revoked();
    return result.tokens;
  }

  /**
   * Revokes the presenting session only.
   *
   * Phase 1B.3 deliberately implements *this session* logout, not "sign out
   * everywhere" — that is `DELETE /auth/sessions`, a separate, explicit action.
   * Conflating them would mean a user closing one browser tab silently killing
   * their other devices.
   */
  async logout(principal: AuthPrincipal, meta: RequestMeta): Promise<void> {
    if (!principal.sessionId || !principal.userId) return;
    await this.db.auth.transaction(async (tx) => {
      const revoked = await this.sessions.revoke(
        tx as Transaction,
        principal.sessionId!,
        'user_logout',
      );
      await this.audit.record(
        {
          scopeType: 'platform',
          scopeId: null,
          actorType: 'user',
          actorUserId: principal.userId,
          actorApiKeyId: null,
          actorLabel: null,
          action: AUDIT_ACTIONS.AUTH_LOGOUT,
          resourceType: 'session',
          resourceId: principal.sessionId,
          outcome: 'success',
          before: null,
          after: { revoked: revoked > 0 },
          metadata: {},
          correlationId: meta.correlationId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx as Transaction,
      );
    });
  }

  /** The caller's own live sessions. Never another user's. */
  async listSessions(userId: string, currentSessionId: string | null): Promise<SessionSummary[]> {
    const rows = await this.db.auth.transaction((tx) =>
      tx
        .select({
          id: schema.sessions.id,
          createdAt: schema.sessions.createdAt,
          lastUsedAt: schema.sessions.lastUsedAt,
          expiresAt: schema.sessions.expiresAt,
          ip: schema.sessions.ip,
          userAgent: schema.sessions.userAgent,
        })
        .from(schema.sessions)
        .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
        .orderBy(desc(schema.sessions.createdAt)),
    );

    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  /**
   * Revokes one of the caller's own sessions.
   *
   * Ownership is checked against the authenticated user id, never against
   * anything on the request. A session belonging to someone else reports `404`
   * rather than `403`, so the endpoint cannot be used to discover which session
   * ids exist.
   */
  async revokeSession(
    principal: AuthPrincipal,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const userId = principal.userId;
    if (!userId)
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });

    await this.db.auth.transaction(async (tx) => {
      const target = await this.sessions.findById(tx as Transaction, sessionId);
      if (!target || target.userId !== userId) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Session not found',
          logContext: { sessionId, requestedBy: userId },
        });
      }

      await this.sessions.revoke(tx as Transaction, sessionId, 'user_revoked');
      await this.audit.record(
        {
          scopeType: 'platform',
          scopeId: null,
          actorType: 'user',
          actorUserId: userId,
          actorApiKeyId: null,
          actorLabel: null,
          action: AUDIT_ACTIONS.SESSION_REVOKED,
          resourceType: 'session',
          resourceId: sessionId,
          outcome: 'success',
          before: null,
          after: { revoked: true },
          metadata: { self: sessionId === principal.sessionId },
          correlationId: meta.correlationId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx as Transaction,
      );
    });
  }

  /** A stable id for correlating an anonymous attempt without naming anyone. */
  static anonymousCorrelation(): string {
    return uuidv7();
  }
}
