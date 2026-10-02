import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  anonymousLoginFailureActor,
  type AuthPrincipal,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AppException } from '../common/errors/app.exception';
import { AuditWriter } from '../audit/audit-writer.service';
import { CredentialService } from '../iam/credential.service';
import { SessionService } from '../iam/session.service';
import { UserLifecycleService } from '../iam/user-lifecycle.service';
import { hashRefreshToken } from '../iam/refresh-token';
import { TenantDatabase } from '../database/tenant-database.service';
import { AccessTokenService } from './jwt.service';
import { MetricsService } from '../observability/metrics.service';

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
    private readonly metrics: MetricsService,
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

    let evictedCount = 0;
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

      // The `users` row is written *before* the per-user session lock is taken
      // (`createWithinCap`), the same order the disable path uses, so the two
      // can never wait on each other in a cycle (`SessionService`, Phase 1C.2).
      //
      // Conditional on `status = 'active'`: the status read above is not locked,
      // and a disable committing in between would otherwise let this login mint a
      // session for a disabled account. The `UPDATE` re-evaluates the predicate
      // after waiting on the disable's row lock, so it refuses instead.
      const stillActive = await tx
        .update(schema.users)
        .set({ lastLoginAt: new Date() })
        .where(and(eq(schema.users.id, user.id), eq(schema.users.status, 'active')))
        .returning({ id: schema.users.id });
      if (stillActive.length === 0) return null;

      // Transparent upgrade when the configured cost has since increased.
      if (digest && this.credentials.needsRehash(digest)) {
        const rehashed = await this.credentials.hash(password);
        await tx
          .update(schema.users)
          .set({ passwordHash: rehashed, passwordUpdatedAt: new Date() })
          .where(eq(schema.users.id, user.id));
      }

      // ADR-012 F-11: at `AUTH_MAX_SESSIONS_PER_USER` live sessions the oldest
      // are evicted so the new one fits — serialized per user, in this
      // transaction, each eviction audited in it too.
      const { session, refresh, evicted } = await this.sessions.createWithinCap(tx as Transaction, {
        userId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      evictedCount = evicted.length;
      for (const evictedId of evicted) {
        await this.audit.record(
          {
            ...this.selfActor(user.id),
            action: AUDIT_ACTIONS.SESSION_REVOKED,
            resourceType: 'session',
            resourceId: evictedId,
            outcome: 'success',
            before: null,
            after: { revoked: true },
            metadata: { reason: 'session_limit_exceeded', evictedBy: session.id },
            correlationId: meta.correlationId,
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
          tx as Transaction,
        );
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
    // Counted only once the login transaction has committed, so a rolled-back
    // sign-in never reports an eviction that did not happen.
    if (evictedCount > 0) this.metrics.sessionCapEvictions.inc(evictedCount);
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
   * everywhere". Conflating them would mean a user closing one browser tab
   * silently killing their other devices.
   *
   * "Sign out my other devices" is `POST /auth/sessions/revoke-all`
   * (`revokeAllOwnSessions`, Phase 1C.2), which keeps this session; one other
   * device is `DELETE /auth/sessions/:id`. A caller whose access token has
   * expired logs out with the refresh cookie instead (`logoutWithRefreshToken`).
   */
  async logout(principal: AuthPrincipal, meta: RequestMeta): Promise<void> {
    if (!principal.sessionId || !principal.userId) return;
    await this.db.auth.transaction(async (tx) => {
      // The whole rotation chain: this device, including a successor a
      // concurrent refresh may just have minted (Phase 1C.2).
      const outcome = await this.sessions.revokeChain(
        tx as Transaction,
        principal.sessionId!,
        'user_logout',
      );
      const revoked = outcome?.liveRevoked ?? 0;
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

  /**
   * Logout by refresh cookie, for a caller presenting no valid bearer token —
   * typically because the access token has expired (ADR-012 F-12).
   *
   * The session the cookie belongs to is found by the token's hash and its whole
   * rotation chain is revoked. An unknown, rotated-away or already-revoked cookie
   * does nothing, and the caller is answered identically either way (`204`, the
   * cookie cleared): the route is not an oracle for whether a token exists.
   * `auth.logout` is written only when a live session was actually revoked.
   */
  async logoutWithRefreshToken(presentedToken: string, meta: RequestMeta): Promise<void> {
    await this.db.auth.transaction(async (tx) => {
      const session = await this.sessions.findByRefreshTokenHash(
        tx as Transaction,
        hashRefreshToken(presentedToken),
      );
      if (!session) return;
      const outcome = await this.sessions.revokeChain(tx as Transaction, session.id, 'user_logout');
      if (!outcome || outcome.liveRevoked === 0) return;
      await this.audit.record(
        {
          ...this.selfActor(outcome.userId),
          action: AUDIT_ACTIONS.AUTH_LOGOUT,
          resourceType: 'session',
          resourceId: session.id,
          outcome: 'success',
          before: null,
          after: { revoked: true },
          metadata: { via: 'refresh_cookie' },
          correlationId: meta.correlationId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx as Transaction,
      );
    });
  }

  /**
   * Revokes every other live session of the caller and keeps the current one
   * (ADR-012 F-10). A session principal only: an API key has no session to keep.
   */
  async revokeAllOwnSessions(principal: AuthPrincipal, meta: RequestMeta): Promise<number> {
    const userId = principal.userId;
    const sessionId = principal.sessionId;
    if (principal.actorType !== 'user' || !userId || !sessionId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'Revoking your sessions requires a signed-in user session',
      });
    }

    return this.db.auth.transaction(async (tx) => {
      const revoked = await this.sessions.revokeOtherChains(
        tx as Transaction,
        userId,
        sessionId,
        'user_revoked_all',
      );
      await this.audit.record(
        {
          ...this.selfActor(userId),
          action: AUDIT_ACTIONS.SESSION_REVOKED_ALL,
          resourceType: 'session',
          resourceId: sessionId,
          outcome: 'success',
          before: null,
          after: { revoked },
          metadata: { keptCurrent: true },
          correlationId: meta.correlationId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx as Transaction,
      );
      return revoked;
    });
  }

  /**
   * The caller's own **live** sessions (ADR-012 F-11): rotated, expired and
   * revoked rows are history, not sessions, and are never listed. Never another
   * user's.
   */
  async listSessions(userId: string, currentSessionId: string | null): Promise<SessionSummary[]> {
    const rows = await this.db.auth.transaction((tx) =>
      this.sessions.listLive(tx as Transaction, userId),
    );
    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  /** A self-attributed `acc_auth` audit actor: the user, at platform scope. */
  private selfActor(userId: string) {
    return {
      scopeType: 'platform' as const,
      scopeId: null,
      actorType: 'user' as const,
      actorUserId: userId,
      actorApiKeyId: null,
      actorLabel: null,
    };
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

    const notFound = () =>
      new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Session not found',
        logContext: { sessionId, requestedBy: userId },
      });

    await this.db.auth.transaction(async (tx) => {
      const target = await this.sessions.findById(tx as Transaction, sessionId);
      if (!target || target.userId !== userId) throw notFound();

      // The rotation chain, not the row: the listed id may already have been
      // rotated into a successor (Phase 1C.2). A chain with nothing live left is
      // `404`, as a repeat of this call is (`API.md` §4).
      const outcome = await this.sessions.revokeChain(tx as Transaction, sessionId, 'user_revoked');
      if (!outcome || outcome.liveRevoked === 0) throw notFound();

      const current = principal.sessionId
        ? await this.sessions.findById(tx as Transaction, principal.sessionId)
        : null;

      // `acc_auth`, in this transaction: `session.revoked` is in its vocabulary
      // since migration 0013 — before which this write was refused and every
      // successful self-revocation rolled back with a 500 (a Phase 1B defect).
      await this.audit.record(
        {
          ...this.selfActor(userId),
          action: AUDIT_ACTIONS.SESSION_REVOKED,
          resourceType: 'session',
          resourceId: sessionId,
          outcome: 'success',
          before: null,
          after: { revoked: true },
          metadata: { self: current?.familyId === outcome.familyId },
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
