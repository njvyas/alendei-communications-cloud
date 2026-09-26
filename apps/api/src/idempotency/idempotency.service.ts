import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import { fingerprint, type EffectiveRequest } from './request-fingerprint';

/** What an idempotent execution returns to its caller. */
export interface IdempotentOutcome<T> {
  readonly body: T;
  readonly status: number;
  /** True when this response came from a stored record rather than fresh work. */
  readonly replayed: boolean;
}

export interface IdempotentExecution<T> {
  /** The key the caller supplied, already validated. `null` runs without idempotency. */
  readonly key: string | null;
  readonly request: EffectiveRequest;
  /** The status a *fresh* execution returns, stored for replay. */
  readonly successStatus: number;
  /** The protected work, run inside the same transaction as the claim. */
  readonly work: (tx: Transaction) => Promise<T>;
  /**
   * The target-scope check this request requires, run **before a replay is
   * returned**.
   *
   * A replay does not run `work`, so without this the stored response would be
   * handed back on the strength of a decision made during the *original*
   * request — which is precisely "a previously successful request became a
   * credential". It runs in the same transaction as the lookup, so authorization
   * stays where ADR-005 D-5 requires it, and it must be the *same* check `work`
   * performs rather than a second copy of it.
   */
  readonly authorize: (tx: Transaction) => Promise<void>;
}

/**
 * HTTP idempotency: execution/replay coordination for mutating requests
 * (`API.md` §4, `DATABASE.md` §7.1, ADR-006).
 *
 * **It is not a business state machine.** It records that a request ran and what
 * it answered; it never interprets, re-derives or re-validates the business
 * outcome, and the protected work is a closure it cannot see into.
 *
 * ---
 *
 * **One transaction, and that is the whole design.** The claim, the business
 * mutation and the finalize all run inside a single `withRequestTenant`
 * transaction:
 *
 *   claim (INSERT) → work() → finalize (UPDATE) → COMMIT
 *
 * Either all of it commits or none of it does. That closes the failure class the
 * mechanism exists for — a mutation that commits while its record does not, so a
 * retry runs the mutation twice — by making the two inseparable rather than by
 * ordering them carefully and hoping. There is **no crash window**: a process
 * that dies anywhere in the sequence leaves the transaction to roll back, and
 * the key is free for a genuine retry.
 *
 * It is also why this is not an interceptor. An interceptor runs outside the
 * handler's transaction and would need one of its own, which reopens precisely
 * that gap. And it is why authorization is untouched: `work()` receives the same
 * `tx`, so `AuthorizationService.assert` still runs inside the request's own
 * tenant transaction exactly as ADR-005 D-5 requires.
 *
 * ---
 *
 * **Concurrency is the database's, not the application's.** The claim is
 * `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now()`. The unique index
 * on `(org_id, endpoint, idempotency_key)` *is* the mutex, and it is
 * transactional — a second writer blocks on the row lock until the first commits
 * or rolls back, then either finds a completed record to replay or takes the
 * claim itself. That guarantee survives multiple processes, containers and
 * restarts because it lives in PostgreSQL. No in-memory lock would, and Redis is
 * not consulted at all: it may accelerate elsewhere, it is never the correctness
 * boundary.
 *
 * ---
 *
 * **Only successes are stored.** Validation, authorization, business `4xx`,
 * `5xx` and crashes all roll the transaction back, taking the claim with them,
 * so nothing is cached and a retry is always permitted. Two consequences worth
 * stating plainly:
 *
 *   - A transient failure cannot poison a key. The alternative — recording
 *     failures — makes a database blip permanently unrepeatable.
 *   - **A replay can never bypass authorization.** A refused request leaves no
 *     record, so there is nothing to replay; and a stored record is only ever
 *     reached *after* the current request has authenticated and had its own
 *     authorization evaluated. A previously successful request is not a
 *     credential.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /**
   * How long a duplicate waits for the in-flight original before giving up.
   *
   * Bounded rather than indefinite: without it a duplicate inherits the
   * original's whole runtime and a stuck transaction would hold a connection per
   * retry. On expiry the caller gets a retryable `409`, which is the documented
   * in-progress answer (`API.md` §4) and the only path on which that code is
   * reachable — a `pending` row is never *visible* to another transaction, so a
   * duplicate blocks rather than reading one.
   */
  private static readonly LOCK_WAIT_MS = 3_000;
  private static readonly RETRY_AFTER_SECONDS = 1;

  /** `^[A-Za-z0-9_.:-]{16,255}$` — opaque to the server, but bounded. */
  private static readonly KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

  constructor(private readonly db: TenantDatabase) {}

  /**
   * Validates a caller-supplied key.
   *
   * Length and alphabet only: the key is opaque and the server assigns it no
   * meaning. A minimum of 16 characters is a guard against a caller using
   * something guessable like `1` — which within one organization would collide
   * with another principal's key and be refused as a mismatch, turning a
   * careless client into a confusing support ticket.
   */
  static validateKey(raw: string): string {
    const key = raw.trim();
    if (!IdempotencyService.KEY_PATTERN.test(key)) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
        message:
          'Idempotency-Key must be 16-255 characters of letters, digits, hyphen, underscore, dot or colon',
      });
    }
    return key;
  }

  /**
   * Runs `work` at most once for a given key, or replays what it answered.
   *
   * With no key the work simply runs in its own tenant transaction — idempotency
   * is opt-in per request on these endpoints (`API.md` §4), and its absence must
   * cost nothing.
   */
  async execute<T>(execution: IdempotentExecution<T>): Promise<IdempotentOutcome<T>> {
    if (execution.key === null) {
      const body = await this.db.withRequestTenant(execution.work);
      return { body, status: execution.successStatus, replayed: false };
    }

    const orgId = execution.request.orgId;
    if (orgId === null) {
      // The key namespace is organization-scoped, so a request without one has
      // nowhere to record a claim. Refused here, before any lookup, with the
      // same error the endpoints themselves raise — rather than being allowed to
      // reach a NOT NULL column and surface as a `500`.
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }

    const endpoint = `${execution.request.method.toUpperCase()} ${execution.request.route}`;
    const hash = fingerprint(execution.request);
    const key = execution.key;

    return this.db.withRequestTenant(async (tx) => {
      // Bounded for this transaction only. `SET LOCAL` resets on commit *and*
      // rollback, so a pooled connection never carries it into another request.
      await tx.execute(
        sql`set local lock_timeout = ${sql.raw(String(IdempotencyService.LOCK_WAIT_MS))}`,
      );

      const claimed = await this.claim(tx, execution, endpoint, key, hash).catch((error) => {
        throw this.translateLockTimeout(error);
      });

      if (claimed) {
        const body = await execution.work(tx);
        await this.finalize(tx, claimed.id, execution.successStatus, body);
        return { body, status: execution.successStatus, replayed: false };
      }

      // No claim: a live record exists. Authorize **before** anything stored is
      // disclosed — the current request must satisfy current authorization, and
      // a refusal here throws exactly as it would on a fresh execution,
      // including its `authorization.denied` audit row.
      await execution.authorize(tx);

      // Read in this same transaction, which the conflicting write already
      // serialised behind, so what is read is the committed outcome and not a
      // half-written one.
      return this.replay<T>(tx, execution, endpoint, key, hash);
    });
  }

  /**
   * Takes the claim, or returns `null` because a live record already holds it.
   *
   * `DO UPDATE … WHERE expires_at <= now()` makes expiry a reclaim rather than a
   * collision: an expired key is genuinely a fresh request (`API.md` §4), and
   * without this the unique index would refuse it forever. A *live* conflict
   * updates nothing and returns no row, which is how the caller learns to
   * replay.
   */
  /**
   * Idempotent execution for a request that **creates the organization its own
   * key would be namespaced by** — `POST /organizations` (Phase 1C.1a,
   * ADR-012).
   *
   * `idempotency_keys` is namespaced by organization and RLS-scoped by it, and
   * the creator of an organization acts in none (a platform or reseller
   * administrator). Rather than widening that table's key or its policy, this
   * path keeps both exactly as they are and changes only *how the record is
   * found*:
   *
   *   1. a transaction-scoped advisory lock on `(endpoint, actor, key)`
   *      serializes concurrent duplicates — the unique index cannot, because the
   *      organization it would conflict on does not exist yet;
   *   2. an existing record is looked up by `(endpoint, key, actor)` within the
   *      caller's own RLS reach — a platform administrator sees every
   *      organization, a reseller administrator those beneath its reseller;
   *   3. on a miss, `work` runs and the record is written **in the new
   *      organization's namespace, in the same transaction** — so an organization
   *      and its record commit or roll back together, and there is no crash
   *      window.
   *
   * The caller has already authorized the request in `tx` — a replay is never a
   * credential — and has already elevated `tx` to the provisioning context
   * before `work` inserts anything. Only successes are stored, as everywhere
   * else (ADR-006).
   */
  async executeOrganizationCreation<T>(
    tx: Transaction,
    execution: Omit<IdempotentExecution<T>, 'work' | 'authorize'> & {
      readonly work: (tx: Transaction) => Promise<{ body: T; orgId: string }>;
    },
  ): Promise<IdempotentOutcome<T>> {
    if (execution.key === null) {
      const { body } = await execution.work(tx);
      return { body, status: execution.successStatus, replayed: false };
    }

    const principal = execution.request.principal;
    const endpoint = `${execution.request.method.toUpperCase()} ${execution.request.route}`;
    const hash = fingerprint(execution.request);
    const key = execution.key;
    const actor = principal.userId ?? principal.apiKeyId ?? 'anonymous';

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`acc:idempotency:${endpoint}:${actor}:${key}`}, 0))`,
    );

    const [record] = await tx
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.endpoint, endpoint),
          eq(schema.idempotencyKeys.idempotencyKey, key),
          principal.userId
            ? eq(schema.idempotencyKeys.actorUserId, principal.userId)
            : eq(schema.idempotencyKeys.actorApiKeyId, principal.apiKeyId!),
          sql`${schema.idempotencyKeys.expiresAt} > now()`,
        ),
      )
      .limit(1);

    if (record) {
      if (record.requestHash !== hash) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
          message: 'This Idempotency-Key was already used for a different request',
          logContext: { endpoint },
        });
      }
      return {
        body: record.responseSnapshot as T,
        status: record.responseStatusCode ?? execution.successStatus,
        replayed: true,
      };
    }

    const { body, orgId } = await execution.work(tx);
    await tx.insert(schema.idempotencyKeys).values({
      orgId,
      endpoint,
      idempotencyKey: key,
      requestHash: hash,
      status: 'completed',
      responseStatusCode: execution.successStatus,
      responseSnapshot: body as never,
      completedAt: new Date(),
      actorUserId: principal.userId,
      actorApiKeyId: principal.apiKeyId,
      correlationId: RequestContext.get()?.correlationId ?? null,
    });
    return { body, status: execution.successStatus, replayed: false };
  }

  private async claim<T>(
    tx: Transaction,
    execution: IdempotentExecution<T>,
    endpoint: string,
    key: string,
    hash: string,
  ): Promise<{ id: string } | null> {
    const principal = execution.request.principal;
    const correlationId = RequestContext.get()?.correlationId ?? null;

    const rows = await tx
      .insert(schema.idempotencyKeys)
      .values({
        // Non-null: `execute` refuses a request with no organization context
        // before reaching the claim.
        orgId: execution.request.orgId!,
        endpoint,
        idempotencyKey: key,
        requestHash: hash,
        status: 'pending',
        actorUserId: principal.userId,
        actorApiKeyId: principal.apiKeyId,
        correlationId,
      })
      .onConflictDoUpdate({
        target: [
          schema.idempotencyKeys.orgId,
          schema.idempotencyKeys.endpoint,
          schema.idempotencyKeys.idempotencyKey,
        ],
        set: {
          requestHash: hash,
          status: 'pending',
          responseStatusCode: null,
          responseSnapshot: null,
          completedAt: null,
          failureReason: null,
          actorUserId: principal.userId,
          actorApiKeyId: principal.apiKeyId,
          correlationId,
          expiresAt: sql`now() + interval '24 hours'`,
        },
        setWhere: sql`${schema.idempotencyKeys.expiresAt} <= now()`,
      })
      .returning({ id: schema.idempotencyKeys.id });

    return rows[0] ?? null;
  }

  /**
   * Replays a live record, or refuses it.
   *
   * The hash is compared **before** anything is disclosed, so a key belonging to
   * a different request — including one made by a different principal, whose
   * identity is part of the hash — is refused without revealing that a record
   * exists at all, let alone its contents.
   */
  private async replay<T>(
    tx: Transaction,
    execution: IdempotentExecution<T>,
    endpoint: string,
    key: string,
    hash: string,
  ): Promise<IdempotentOutcome<T>> {
    const [record] = await tx
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.orgId, execution.request.orgId!),
          eq(schema.idempotencyKeys.endpoint, endpoint),
          eq(schema.idempotencyKeys.idempotencyKey, key),
        ),
      );

    if (!record) {
      // The holder rolled back between the failed claim and this read, so the
      // key is free again. Retrying is the honest answer — re-claiming here
      // would need a second attempt loop for a case a client resolves in one.
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.IDEMPOTENCY_REQUEST_IN_PROGRESS,
        message: 'A request with this Idempotency-Key was in progress; retry shortly',
      });
    }

    if (record.requestHash !== hash) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
        // Says what is wrong without saying what the stored request was: the
        // fingerprint, the stored body and the original actor are all withheld.
        message: 'This Idempotency-Key was already used for a different request',
        logContext: { endpoint, storedActorUserId: record.actorUserId },
      });
    }

    if (record.status !== 'completed' || record.responseStatusCode === null) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.IDEMPOTENCY_REQUEST_IN_PROGRESS,
        message: 'A request with this Idempotency-Key is still in progress; retry shortly',
      });
    }

    return {
      // Stored verbatim and returned verbatim: a replay is the original answer,
      // not a new one described as old. Nothing is added to the envelope and
      // nothing is recomputed (`API.md` §4).
      body: record.responseSnapshot as T,
      status: record.responseStatusCode,
      replayed: true,
    };
  }

  private async finalize<T>(tx: Transaction, id: string, status: number, body: T): Promise<void> {
    await tx
      .update(schema.idempotencyKeys)
      .set({
        status: 'completed',
        responseStatusCode: status,
        responseSnapshot: body as never,
        completedAt: new Date(),
      })
      .where(eq(schema.idempotencyKeys.id, id));
  }

  /**
   * `55P03 lock_not_available` — the wait for an in-flight original expired.
   *
   * Reported as the documented retryable `409` rather than a generic `500`: the
   * original is committing or rolling back, and the next attempt gets a definite
   * answer.
   */
  private translateLockTimeout(error: unknown): unknown {
    const code =
      (error as { cause?: { code?: string }; code?: string })?.cause?.code ??
      (error as { code?: string })?.code;
    if (code !== '55P03') return error;

    this.logger.warn('idempotent request waited past the lock timeout for its original');
    return new AppException({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.IDEMPOTENCY_REQUEST_IN_PROGRESS,
      message: 'A request with this Idempotency-Key is still in progress; retry shortly',
      details: { retryAfterSeconds: IdempotencyService.RETRY_AFTER_SECONDS },
    });
  }
}
