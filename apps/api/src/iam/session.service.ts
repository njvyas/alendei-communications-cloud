import { Injectable } from '@nestjs/common';
import { schema, type Transaction } from '@acc/db';
import { and, asc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';

import { AppConfigService } from '../config/app-config.service';
import { issueRefreshToken, type RefreshTokenMaterial } from './refresh-token';

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatedAt: Date | null;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly deviceInfo?: Record<string, unknown>;
}

/** What a rotation attempt concluded. Callers must handle all three. */
export type RotationOutcome =
  | {
      readonly status: 'rotated';
      readonly session: SessionRecord;
      readonly refresh: RefreshTokenMaterial;
    }
  | { readonly status: 'reuse_detected'; readonly familyId: string }
  | { readonly status: 'not_rotatable'; readonly reason: 'unknown' | 'revoked' | 'expired' };

/**
 * Session persistence (`RBAC.md` §5a, `DATABASE.md` §2).
 *
 * Every method takes the caller's transaction. That is not a convenience: a
 * session mutation and its audit row must commit or roll back together
 * (ADR-003 D-2), and `acc_auth` — the principal that owns these tables before a
 * tenant context exists — is the same principal `AuditWriter` uses for the auth
 * vocabulary. Passing one transaction through both is what makes the pair atomic.
 *
 * This class deliberately does not issue, validate or parse access tokens. It
 * persists sessions and rotates refresh tokens; the login, refresh and logout
 * endpoints that orchestrate it belong to Phase 1B.3.
 *
 * **Phase 1C.2 — one serialization point per user.** Every operation that
 * creates, rotates or revokes a user's sessions first takes
 * `pg_advisory_xact_lock` on that user (`lockUser`), in its own transaction. A
 * refresh can therefore never interleave with a revocation or a cap-enforcing
 * login: whichever commits second sees the first's result. The lock is the same
 * PostgreSQL primitive organization-creation idempotency already uses, is
 * released at commit or rollback, and survives multiple processes.
 *
 * **Lock order.** A transaction that also locks the user's `users` row (login's
 * `last_login_at`, the disable path's status change) takes that row lock
 * *before* this advisory lock; nothing takes them in the other order, and the
 * per-request `touch` holds only a `sessions` row lock and waits on nothing
 * else. There is no cycle.
 *
 * **The revocation unit is the rotation chain** (`family_id`): a refresh
 * replaces a session row with a successor, so the id a client listed may already
 * be spent. Revoking "a session" revokes every unrevoked row of its chain.
 */
@Injectable()
export class SessionService {
  constructor(private readonly config: AppConfigService) {}

  /**
   * A live session (ADR-012 F-11): not revoked, not rotated, not expired —
   * judged by the database clock. Only live sessions count toward the cap, are
   * listed, or are reported as revoked.
   */
  static live(): SQL {
    return and(
      isNull(schema.sessions.revokedAt),
      isNull(schema.sessions.rotatedAt),
      sql`${schema.sessions.expiresAt} > now()`,
    )!;
  }

  /** The per-user serialization point. Re-entrant within one transaction. */
  async lockUser(tx: Transaction, userId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`acc:sessions:user:${userId}`}, 0))`,
    );
  }

  /**
   * Starts a session for a login, evicting the user's oldest live sessions
   * until the new one fits under `AUTH_MAX_SESSIONS_PER_USER` (ADR-012 F-11,
   * OD-6).
   *
   * Under the per-user lock, so concurrent logins are serialized and each sees
   * the others' committed sessions: the cap can never be exceeded. Eviction
   * order is `created_at`, then `id` — deterministic even for identical
   * timestamps — and the new session is inserted afterwards, so it is never
   * itself a candidate. Each evicted chain is revoked with reason
   * `session_limit_exceeded`; the caller audits each one in this transaction.
   */
  async createWithinCap(
    tx: Transaction,
    input: CreateSessionInput,
  ): Promise<{ session: SessionRecord; refresh: RefreshTokenMaterial; evicted: string[] }> {
    const cap = this.config.auth.maxSessionsPerUser;
    await this.lockUser(tx, input.userId);

    const live = await tx
      .select({ id: schema.sessions.id, familyId: schema.sessions.familyId })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, input.userId), SessionService.live()))
      .orderBy(asc(schema.sessions.createdAt), asc(schema.sessions.id));

    const excess = live.length - cap + 1;
    const evicted: string[] = [];
    for (const victim of live.slice(0, Math.max(0, excess))) {
      await this.revokeFamily(tx, victim.familyId, 'session_limit_exceeded');
      evicted.push(victim.id);
    }

    const created = await this.create(tx, input);
    return { ...created, evicted };
  }

  /** Starts a new session family. The refresh token is returned exactly once. */
  async create(
    tx: Transaction,
    input: CreateSessionInput,
  ): Promise<{ session: SessionRecord; refresh: RefreshTokenMaterial }> {
    const refresh = issueRefreshToken();
    const expiresAt = new Date(Date.now() + this.config.auth.refreshTokenTtlSeconds * 1000);

    const [row] = await tx
      .insert(schema.sessions)
      .values({
        userId: input.userId,
        refreshTokenHash: refresh.hash,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        deviceInfo: input.deviceInfo ?? {},
        expiresAt,
      })
      .returning({
        id: schema.sessions.id,
        userId: schema.sessions.userId,
        familyId: schema.sessions.familyId,
        expiresAt: schema.sessions.expiresAt,
        revokedAt: schema.sessions.revokedAt,
        rotatedAt: schema.sessions.rotatedAt,
      });

    if (!row) throw new Error('session: insert returned no row');
    return { session: row, refresh };
  }

  /** Looks a session up by the hash of a presented refresh token. */
  async findByRefreshTokenHash(tx: Transaction, hash: string): Promise<SessionRecord | null> {
    const [row] = await tx
      .select({
        id: schema.sessions.id,
        userId: schema.sessions.userId,
        familyId: schema.sessions.familyId,
        expiresAt: schema.sessions.expiresAt,
        revokedAt: schema.sessions.revokedAt,
        rotatedAt: schema.sessions.rotatedAt,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.refreshTokenHash, hash));
    return row ?? null;
  }

  /**
   * Rotates a session, atomically.
   *
   * The concurrency invariant, enforced by the database rather than by a check
   * in this method: **two concurrent refreshes presenting the same token cannot
   * both rotate it.** The `UPDATE ... WHERE rotated_at IS NULL` takes a row lock;
   * the loser re-evaluates its predicate after the winner commits, matches
   * nothing, and reports zero rows. There is no read-then-write window for the
   * two to race inside.
   *
   * A zero-row result is therefore not a retryable glitch — it means the token
   * had already been spent, which is the signature of a replayed token. The
   * caller gets `reuse_detected` and the whole family has been revoked.
   */
  async rotate(
    tx: Transaction,
    sessionId: string,
    input: CreateSessionInput,
  ): Promise<RotationOutcome> {
    const located = await this.findById(tx, sessionId);
    if (!located) return { status: 'not_rotatable', reason: 'unknown' };

    // Serialize against every revocation and login for this user, then re-read:
    // a revocation that committed while this waited must be seen, or the
    // successor minted below would outlive it (Phase 1C.2).
    await this.lockUser(tx, located.userId);
    const existing = await this.findById(tx, sessionId);
    if (!existing) return { status: 'not_rotatable', reason: 'unknown' };
    if (existing.revokedAt) return { status: 'not_rotatable', reason: 'revoked' };
    if (existing.expiresAt.getTime() <= Date.now()) {
      return { status: 'not_rotatable', reason: 'expired' };
    }

    // The successor is created first so the conditional update can name it and
    // the whole rotation is one atomic step from the predecessor's point of view.
    const successor = await this.create(tx, { ...input, userId: existing.userId });
    await tx
      .update(schema.sessions)
      .set({ familyId: existing.familyId })
      .where(eq(schema.sessions.id, successor.session.id));

    const claimed = await tx
      .update(schema.sessions)
      .set({ rotatedAt: new Date(), replacedBySessionId: successor.session.id })
      .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.rotatedAt)))
      .returning({ id: schema.sessions.id });

    if (claimed.length === 0) {
      // Someone else rotated this exact token first. Both the successor we just
      // minted and the entire family are now suspect.
      await this.revokeFamily(tx, existing.familyId, 'refresh_token_reuse_detected');
      await tx
        .update(schema.sessions)
        .set({ reuseDetectedAt: new Date() })
        .where(eq(schema.sessions.id, sessionId));
      return { status: 'reuse_detected', familyId: existing.familyId };
    }

    return {
      status: 'rotated',
      session: { ...successor.session, familyId: existing.familyId },
      refresh: successor.refresh,
    };
  }

  async findById(tx: Transaction, sessionId: string): Promise<SessionRecord | null> {
    const [row] = await tx
      .select({
        id: schema.sessions.id,
        userId: schema.sessions.userId,
        familyId: schema.sessions.familyId,
        expiresAt: schema.sessions.expiresAt,
        revokedAt: schema.sessions.revokedAt,
        rotatedAt: schema.sessions.rotatedAt,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    return row ?? null;
  }

  /**
   * Revokes one session *row*. Idempotent: re-revoking leaves the original
   * reason and time. A low-level primitive — request paths revoke the whole
   * rotation chain with `revokeChain`, because a single row may already have a
   * live successor.
   */
  async revoke(tx: Transaction, sessionId: string, reason: string): Promise<number> {
    const target = await this.findById(tx, sessionId);
    if (target) await this.lockUser(tx, target.userId);
    const rows = await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)))
      .returning({ id: schema.sessions.id });
    return rows.length;
  }

  /** Revokes every live session in a rotation chain — the response to token theft. */
  async revokeFamily(tx: Transaction, familyId: string, reason: string): Promise<number> {
    const rows = await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.familyId, familyId), isNull(schema.sessions.revokedAt)))
      .returning({ id: schema.sessions.id });
    return rows.length;
  }

  /**
   * Revokes the rotation chain `sessionId` belongs to — the logical session, or
   * device (Phase 1C.2). Every unrevoked row of the chain is revoked, so a
   * successor minted by a refresh cannot outlive the revocation of an id the
   * client listed before that refresh.
   *
   * Returns `null` for an unknown id, otherwise the owner, the chain, and how
   * many *live* sessions were revoked (`0` when the chain was already dead).
   */
  async revokeChain(
    tx: Transaction,
    sessionId: string,
    reason: string,
  ): Promise<{ userId: string; familyId: string; liveRevoked: number } | null> {
    const target = await this.findById(tx, sessionId);
    if (!target) return null;
    await this.lockUser(tx, target.userId);

    const rows = await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.familyId, target.familyId), isNull(schema.sessions.revokedAt)))
      .returning(this.liveBeforeRevocation());
    return {
      userId: target.userId,
      familyId: target.familyId,
      liveRevoked: rows.filter((r) => r.live).length,
    };
  }

  /**
   * Revokes every chain of `userId` except the one `keepSessionId` belongs to —
   * self revoke-all, which keeps the current session (ADR-012 F-10). Returns the
   * number of live sessions revoked.
   */
  async revokeOtherChains(
    tx: Transaction,
    userId: string,
    keepSessionId: string,
    reason: string,
  ): Promise<number> {
    await this.lockUser(tx, userId);
    const keep = await this.findById(tx, keepSessionId);
    if (!keep || keep.userId !== userId) {
      throw new Error('session: the session to keep does not belong to this user');
    }

    const rows = await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(schema.sessions.userId, userId),
          isNull(schema.sessions.revokedAt),
          ne(schema.sessions.familyId, keep.familyId),
        ),
      )
      .returning(this.liveBeforeRevocation());
    return rows.filter((r) => r.live).length;
  }

  /**
   * Revokes every session for a user — "sign out everywhere" (user disable,
   * administrator revoke-all). Returns the number of live sessions revoked.
   */
  async revokeAllForUser(tx: Transaction, userId: string, reason: string): Promise<number> {
    await this.lockUser(tx, userId);
    const rows = await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
      .returning(this.liveBeforeRevocation());
    return rows.filter((r) => r.live).length;
  }

  /** A user's live sessions, newest first (Phase 1C.2: rotated and expired rows excluded). */
  async listLive(tx: Transaction, userId: string) {
    return tx
      .select({
        id: schema.sessions.id,
        createdAt: schema.sessions.createdAt,
        lastUsedAt: schema.sessions.lastUsedAt,
        expiresAt: schema.sessions.expiresAt,
        ip: schema.sessions.ip,
        userAgent: schema.sessions.userAgent,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, userId), SessionService.live()))
      .orderBy(sql`${schema.sessions.createdAt} DESC`, sql`${schema.sessions.id} DESC`);
  }

  /**
   * `RETURNING` projection for a revoking `UPDATE`: whether the row was live
   * just before it. `rotated_at` and `expires_at` are not touched by the
   * update, so the returned values are the pre-update ones.
   */
  private liveBeforeRevocation() {
    return {
      id: schema.sessions.id,
      live: sql<boolean>`(${schema.sessions.rotatedAt} IS NULL AND ${schema.sessions.expiresAt} > now())`,
    };
  }

  /**
   * Whether a session may still be presented. Revocation and expiry are checked
   * on every use, not merely at access-token expiry (`RBAC.md` §5a), and a
   * rotated session is spent regardless of its own expiry.
   */
  isPresentable(session: SessionRecord, now = new Date()): boolean {
    return (
      session.revokedAt === null &&
      session.rotatedAt === null &&
      session.expiresAt.getTime() > now.getTime()
    );
  }

  /** Marks a session used, for device/session listings. */
  async touch(tx: Transaction, sessionId: string): Promise<void> {
    await tx
      .update(schema.sessions)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(schema.sessions.id, sessionId));
  }
}
