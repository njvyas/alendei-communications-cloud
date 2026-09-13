import { Injectable } from '@nestjs/common';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

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
 */
@Injectable()
export class SessionService {
  constructor(private readonly config: AppConfigService) {}

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

  /** Revokes one session. Idempotent: re-revoking leaves the original reason and time. */
  async revoke(tx: Transaction, sessionId: string, reason: string): Promise<number> {
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

  /** Revokes every live session for a user — "sign out everywhere". */
  async revokeAllForUser(tx: Transaction, userId: string, reason: string): Promise<number> {
    const rows = await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
      .returning({ id: schema.sessions.id });
    return rows.length;
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
