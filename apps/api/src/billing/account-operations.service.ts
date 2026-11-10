import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PAGE_LIMITS,
  PERMISSIONS,
  type AuditAction,
  type AuthPrincipal,
  type ErrorCode,
  type PageInfo,
} from '@acc/contracts';
import type { Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { CursorCodec } from '../common/http/cursor';
import { AppConfigService } from '../config/app-config.service';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { MetricsService } from '../observability/metrics.service';
import type {
  AccountOperationKind,
  BillingAccountName,
  ListAccountOperationsQueryDto,
} from './account-operations.dto';

const PLATFORM = { scopeType: 'platform', scopeId: null } as const;
/** Newest first, by id (UUIDv7). */
const SORT = 'id';

export interface BillingAccountView {
  readonly account: BillingAccountName;
  readonly id: string;
  readonly status: 'active' | 'frozen';
  /** Prepaid wallet only. */
  readonly balancePaise: number | null;
  /** Credit account only. */
  readonly creditLimitPaise: number | null;
  /** Credit account only. */
  readonly usedPaise: number | null;
  readonly reservedPaise: number;
  /** balance − reserved, or limit − used − reserved. */
  readonly availablePaise: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BillingAccountsView {
  readonly orgId: string;
  readonly wallet: BillingAccountView | null;
  readonly creditAccount: BillingAccountView | null;
}

export interface AccountOperationView {
  readonly id: string;
  readonly orgId: string;
  readonly account: BillingAccountName;
  readonly kind: AccountOperationKind;
  readonly status: 'pending' | 'executed' | 'rejected';
  /** The new credit limit of a credit-limit change; otherwise null. */
  readonly amountPaise: number | null;
  /** The limit the requester saw (credit-limit change). */
  readonly previousLimitPaise: number | null;
  readonly dualControl: boolean;
  /** The threshold in force at request (server configuration); null when unset. */
  readonly thresholdPaise: number | null;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly executedAt: string | null;
  /** Recharge: the external payment reference (platform only, never shown to tenants). */
  readonly paymentReference: string | null;
  /** Recharge: when the money was received (`YYYY-MM-DD`). */
  readonly receivedOn: string | null;
  /** Recharge: the ledger entry it posted. */
  readonly resultLedgerId: string | null;
  /** Why the last approval was refused (the request stayed pending). */
  readonly lastRefusal: string | null;
  readonly lastRefusedAt: string | null;
}

export interface AccountOperationResult {
  readonly operation: AccountOperationView;
  /** The affected account as it stands after the operation; null if it does not exist. */
  readonly account: BillingAccountView | null;
}

interface OperationRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  account: BillingAccountName;
  kind: AccountOperationKind;
  status: 'pending' | 'executed' | 'rejected';
  amount_paise: string | null;
  previous_limit_paise: string | null;
  dual_control: boolean;
  threshold_paise: string | null;
  reason: string;
  requested_by: string;
  requested_at: string | Date;
  approved_by: string | null;
  approved_at: string | Date | null;
  rejected_by: string | null;
  rejected_at: string | Date | null;
  rejection_reason: string | null;
  executed_at: string | Date | null;
  payment_reference: string | null;
  received_on: string | Date | null;
  result_ledger_id: string | null;
  last_refusal: string | null;
  last_refused_at: string | Date | null;
}

interface AccountRow extends Record<string, unknown> {
  account: BillingAccountName;
  account_id: string;
  status: 'active' | 'frozen';
  balance_paise: string | null;
  credit_limit_paise: string | null;
  used_paise: string | null;
  reserved_paise: string;
  version: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (v: string | Date | null): string | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
/** A `date` column as `YYYY-MM-DD` (the driver may return a string or a local-midnight Date). */
const day = (v: string | Date | null): string | null => {
  if (v === null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

function operationView(r: OperationRow): AccountOperationView {
  return {
    id: r.id,
    orgId: r.org_id,
    account: r.account,
    kind: r.kind,
    status: r.status,
    amountPaise: num(r.amount_paise),
    previousLimitPaise: num(r.previous_limit_paise),
    dualControl: r.dual_control,
    thresholdPaise: num(r.threshold_paise),
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedAt: iso(r.requested_at)!,
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    rejectedBy: r.rejected_by,
    rejectedAt: iso(r.rejected_at),
    rejectionReason: r.rejection_reason,
    executedAt: iso(r.executed_at),
    paymentReference: r.payment_reference,
    receivedOn: day(r.received_on),
    resultLedgerId: r.result_ledger_id,
    lastRefusal: r.last_refusal,
    lastRefusedAt: iso(r.last_refused_at),
  };
}

function accountView(r: AccountRow): BillingAccountView {
  const reserved = Number(r.reserved_paise);
  const available =
    r.account === 'wallet'
      ? Number(r.balance_paise) - reserved
      : Number(r.credit_limit_paise) - Number(r.used_paise) - reserved;
  return {
    account: r.account,
    id: r.account_id,
    status: r.status,
    balancePaise: num(r.balance_paise),
    creditLimitPaise: num(r.credit_limit_paise),
    usedPaise: num(r.used_paise),
    reservedPaise: reserved,
    availablePaise: available,
    version: Number(r.version),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

/** The SQLSTATE of a database error, unwrapped from the query builder's wrapper. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  return undefined;
}

function refusal(
  status: HttpStatus,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AppException {
  return new AppException({ status, code, message, details });
}

const SELF_APPROVAL = () =>
  refusal(
    HttpStatus.FORBIDDEN,
    ERROR_CODES.BILLING_RESOLUTION_SELF_APPROVAL,
    'An account operation must be approved or rejected by a different user than its requester',
  );

/** Maps the account-operation functions' refusals; no amount or limit is disclosed. */
function translate(error: unknown): unknown {
  if (error instanceof AppException) return error;
  switch (sqlState(error)) {
    case 'BL013':
    case '23505':
      return refusal(
        HttpStatus.CONFLICT,
        ERROR_CODES.BILLING_ACCOUNT_OPERATION_CONFLICT,
        'This account operation is not possible now: the account already exists or does not exist, is already in that state, the organization is closed, or an operation of this kind is pending',
      );
    case 'BL014':
      return refusal(
        HttpStatus.CONFLICT,
        ERROR_CODES.BILLING_ACCOUNT_OPERATION_STALE,
        'The account operation no longer matches the account or the approved amount; nothing was executed',
      );
    case 'BL011':
      return SELF_APPROVAL();
    case 'BL002':
      return refusal(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.BILLING_ACCOUNT_FROZEN,
        "The organization's wallet is frozen; nothing was credited",
      );
    case 'BL001':
      return refusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED,
        'The organization has no wallet; nothing was credited',
      );
    case 'P0002':
      return refusal(HttpStatus.NOT_FOUND, ERROR_CODES.RESOURCE_NOT_FOUND, 'Not found');
    case '22023':
      return refusal(HttpStatus.BAD_REQUEST, ERROR_CODES.VALIDATION_FAILED, 'Invalid request');
    case '55P03':
    case '40P01':
    case '40001':
      return refusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        ERROR_CODES.BILLING_BUSY,
        'The billing records are busy; retry with the same Idempotency-Key',
      );
    case '42501':
      return refusal(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.AUTHZ_SCOPE_DENIED,
        'You do not have permission to perform this action',
      );
    default:
      return error;
  }
}

/** The audit action recording an executed operation. */
function executedAction(op: AccountOperationView): AuditAction {
  switch (op.kind) {
    case 'provision':
      return op.account === 'wallet'
        ? AUDIT_ACTIONS.BILLING_WALLET_PROVISIONED
        : AUDIT_ACTIONS.BILLING_CREDIT_ACCOUNT_PROVISIONED;
    case 'credit_limit_change':
      return AUDIT_ACTIONS.BILLING_CREDIT_LIMIT_CHANGED;
    case 'freeze':
      return AUDIT_ACTIONS.BILLING_ACCOUNT_FROZEN;
    case 'unfreeze':
      return AUDIT_ACTIONS.BILLING_ACCOUNT_UNFROZEN;
    case 'recharge':
      return AUDIT_ACTIONS.BILLING_WALLET_RECHARGED;
  }
}

/** Approval refusals that leave a pending recharge pending, with the reason recorded on it. */
const ACCOUNT_STATE_REFUSALS = new Set(['BL001', 'BL002']);
/** The refusal an approval observed, by its SQLSTATE. */
const OBSERVED_REFUSAL: Readonly<Record<string, string>> = {
  BL001: 'account_not_configured',
  BL002: 'account_frozen',
};
/** Errors on which the refusal-recording transaction is retried. */
const TRANSIENT = new Set(['40001', '40P01', '55P03']);
/** At most this many runs of the refusal-recording transaction. */
const REFUSAL_RECORD_ATTEMPTS = 3;

/**
 * How an approval refusal was recorded:
 * - `operation_and_audit`: on the pending operation (`last_refusal`, re-derived and confirmed by
 *   the database) and in the audit log;
 * - `audit_only`: the account's state changed before it could be recorded (for example the wallet
 *   was unfrozen in between), so the database declined to record a state it can no longer
 *   confirm; the observed refusal is in the audit log, marked as such;
 * - `failed`: nothing could be recorded — logged at error level and counted
 *   (`acc_billing_account_refusal_record_failures_total`), and reported to the caller.
 */
export type RefusalRecording = 'operation_and_audit' | 'audit_only' | 'failed';

export interface AccountOperationInput {
  readonly account: BillingAccountName;
  readonly kind: AccountOperationKind;
  readonly reason: string;
  readonly newLimitPaise?: number;
  readonly previousLimitPaise?: number;
}

/**
 * Phase 7 PR 7-6d-1 — billing-account provisioning, credit limits, freeze and unfreeze
 * (`DECISIONS.md` §1zi.13 D-76d-1, D-76d-4; handover Rev 2).
 *
 * Platform only: `billing.manage` at platform scope, signed-in user sessions only
 * (checked here). Every mutation requires an `Idempotency-Key`, is audited as
 * security-sensitive in its own transaction and runs entirely in the migration `0059`
 * SECURITY DEFINER functions, which check the caller again, decide dual control, bind
 * an approval and execute. Provisioning, limits and freezes write no ledger fact; a
 * recharge (PR 7-6d-2) posts exactly one, through the ledger writer's recharge branch.
 *
 * The dual-control threshold is `BILLING_DUAL_CONTROL_THRESHOLD_PAISE`, read from the
 * server configuration on each request and never from the request itself.
 */
@Injectable()
export class AccountOperationsService {
  private readonly logger = new Logger(AccountOperationsService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly idempotency: IdempotencyService,
    private readonly cursors: CursorCodec,
    private readonly config: AppConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // --- mutations --------------------------------------------------------------------

  async request(
    principal: AuthPrincipal,
    orgId: string,
    route: string,
    input: AccountOperationInput,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: AccountOperationResult }>> {
    this.requireUserSession(principal);
    // Trusted server configuration only (D-76d-1); no request field reaches this.
    const threshold = this.config.billing.dualControlThresholdPaise;
    const body: Record<string, unknown> = { reason: input.reason };
    if (input.kind === 'credit_limit_change') {
      body.newLimitPaise = input.newLimitPaise;
      body.previousLimitPaise = input.previousLimitPaise;
    }
    try {
      const outcome = await this.idempotency.executePlatform({
        key,
        successStatus: HttpStatus.CREATED,
        request: {
          method: 'POST',
          route,
          orgId: null,
          principal,
          pathParams: { orgId },
          query: {},
          body,
        },
        authorize: (tx) => this.authorize(tx, principal),
        work: async (tx) => {
          const { rows } = await tx.execute<{ operation_id: string; executed: boolean }>(sql`
            SELECT * FROM app_billing_account_request(
              ${orgId}::uuid, ${input.account}::text, ${input.kind}::text,
              ${input.newLimitPaise ?? null}::bigint, ${input.previousLimitPaise ?? null}::bigint,
              ${input.reason}::text, ${threshold}::bigint, ${key}::text)`);
          const operation = await this.load(tx, rows[0]!.operation_id);
          await this.record(
            tx,
            principal,
            AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
            operation,
          );
          if (operation.status === 'executed') {
            await this.record(tx, principal, executedAction(operation), operation);
          }
          return { data: { operation, account: await this.accountOf(tx, operation) } };
        },
      });
      if (!outcome.replayed) {
        const op = outcome.body.data.operation;
        this.count(op.kind, op.status === 'executed' ? 'executed' : 'pending');
      }
      return outcome;
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Phase 7 PR 7-6d-2 — a wallet recharge request (D-76d-1, D-76d-2, D-76d-4): the net
   * spendable amount, a payment reference unique per organization, the received date.
   * Refused for a frozen wallet; executes at once only within the configured threshold.
   */
  async recharge(
    principal: AuthPrincipal,
    orgId: string,
    input: { amountPaise: number; paymentReference: string; receivedOn: string; reason: string },
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: AccountOperationResult }>> {
    this.requireUserSession(principal);
    const threshold = this.config.billing.dualControlThresholdPaise;
    try {
      const outcome = await this.idempotency.executePlatform({
        key,
        successStatus: HttpStatus.CREATED,
        request: {
          method: 'POST',
          route: '/platform/billing/organizations/:orgId/recharges',
          orgId: null,
          principal,
          pathParams: { orgId },
          query: {},
          body: { ...input },
        },
        authorize: (tx) => this.authorize(tx, principal),
        work: async (tx) => {
          const { rows } = await tx.execute<{ operation_id: string; executed: boolean }>(sql`
            SELECT * FROM app_billing_account_request_recharge(
              ${orgId}::uuid, ${input.amountPaise}::bigint, ${input.paymentReference}::text,
              ${input.receivedOn}::date, ${input.reason}::text, ${threshold}::bigint, ${key}::text)`);
          const operation = await this.load(tx, rows[0]!.operation_id);
          await this.record(
            tx,
            principal,
            AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
            operation,
          );
          if (operation.status === 'executed') {
            await this.record(tx, principal, executedAction(operation), operation);
          }
          return { data: { operation, account: await this.accountOf(tx, operation) } };
        },
      });
      if (!outcome.replayed) {
        const op = outcome.body.data.operation;
        this.count(op.kind, op.status === 'executed' ? 'executed' : 'pending');
      }
      return outcome;
    } catch (error) {
      if (ACCOUNT_STATE_REFUSALS.has(sqlState(error) ?? '')) this.count('recharge', 'refused');
      throw translate(error);
    }
  }

  async approve(
    principal: AuthPrincipal,
    id: string,
    expected: {
      amountPaise?: number;
      paymentReference?: string;
      receivedOn?: string;
    },
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: AccountOperationResult }>> {
    this.requireUserSession(principal);
    const expectedAmountPaise = expected.amountPaise;
    let kind: string | null = null;
    try {
      const outcome = await this.idempotency.executePlatform({
        key,
        successStatus: HttpStatus.OK,
        request: {
          method: 'POST',
          route: '/platform/billing/account-operations/:id/approve',
          orgId: null,
          principal,
          pathParams: { id },
          query: {},
          body: {
            expectedAmountPaise: expectedAmountPaise ?? null,
            expectedPaymentReference: expected.paymentReference ?? null,
            expectedReceivedOn: expected.receivedOn ?? null,
          },
        },
        authorize: (tx) => this.authorize(tx, principal),
        work: async (tx) => {
          const before = await this.load(tx, id);
          kind = before.kind;
          this.refuseOwnRequest(before, principal);
          if (before.kind === 'recharge') {
            // Bound to the exact amount and evidence snapshot (D-76d-1).
            if (
              expectedAmountPaise === undefined ||
              expected.paymentReference === undefined ||
              expected.receivedOn === undefined
            ) {
              throw refusal(
                HttpStatus.BAD_REQUEST,
                ERROR_CODES.VALIDATION_FAILED,
                'A recharge approval names the amount, payment reference and received date it approves',
              );
            }
            await tx.execute(sql`
              SELECT app_billing_account_approve_recharge(
                ${id}::uuid, ${expectedAmountPaise}::bigint, ${expected.paymentReference}::text,
                ${expected.receivedOn}::date)`);
          } else {
            if (expected.paymentReference !== undefined || expected.receivedOn !== undefined) {
              throw refusal(
                HttpStatus.BAD_REQUEST,
                ERROR_CODES.VALIDATION_FAILED,
                'Only a recharge approval names a payment reference and received date',
              );
            }
            await tx.execute(
              sql`SELECT app_billing_account_approve(${id}::uuid, ${expectedAmountPaise ?? null}::bigint)`,
            );
          }
          const after = await this.load(tx, id);
          await this.record(
            tx,
            principal,
            AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_APPROVED,
            after,
            before,
          );
          await this.record(tx, principal, executedAction(after), after);
          return { data: { operation: after, account: await this.accountOf(tx, after) } };
        },
      });
      if (!outcome.replayed) this.count(outcome.body.data.operation.kind, 'executed');
      return outcome;
    } catch (error) {
      const state = sqlState(error) ?? '';
      if (kind === 'recharge' && ACCOUNT_STATE_REFUSALS.has(state)) {
        // The approval rolled back (its key is not consumed; the recharge stays pending). The
        // refusal is recorded in its own transaction; how it was recorded is reported, never
        // silently dropped.
        const observed = OBSERVED_REFUSAL[state]!;
        const recorded = await this.recordRefusal(principal, id, observed);
        this.count('recharge', 'refused');
        const base = translate(error) as AppException;
        throw refusal(base.getStatus(), base.code as ErrorCode, base.message, {
          refusal: observed,
          refusalRecorded: recorded,
        });
      }
      throw translate(error);
    }
  }

  async reject(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: AccountOperationResult }>> {
    this.requireUserSession(principal);
    try {
      const outcome = await this.idempotency.executePlatform({
        key,
        successStatus: HttpStatus.OK,
        request: {
          method: 'POST',
          route: '/platform/billing/account-operations/:id/reject',
          orgId: null,
          principal,
          pathParams: { id },
          query: {},
          body: { reason },
        },
        authorize: (tx) => this.authorize(tx, principal),
        work: async (tx) => {
          const before = await this.load(tx, id);
          this.refuseOwnRequest(before, principal);
          await tx.execute(sql`SELECT app_billing_account_reject(${id}::uuid, ${reason}::text)`);
          const after = await this.load(tx, id);
          await this.record(
            tx,
            principal,
            AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REJECTED,
            after,
            before,
          );
          return { data: { operation: after, account: await this.accountOf(tx, after) } };
        },
      });
      if (!outcome.replayed) this.count(outcome.body.data.operation.kind, 'rejected');
      return outcome;
    } catch (error) {
      throw translate(error);
    }
  }

  // --- reads --------------------------------------------------------------------------

  async accounts(principal: AuthPrincipal, orgId: string): Promise<BillingAccountsView> {
    this.requireUserSession(principal);
    try {
      return await this.db.withRequestTenant(async (tx) => {
        await this.authorize(tx, principal);
        const rows = await this.accountRows(tx, orgId);
        const pick = (name: BillingAccountName) => {
          const row = rows.find((r) => r.account === name);
          return row ? accountView(row) : null;
        };
        return { orgId, wallet: pick('wallet'), creditAccount: pick('credit_account') };
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async list(
    principal: AuthPrincipal,
    query: ListAccountOperationsQueryDto,
  ): Promise<{ items: readonly AccountOperationView[]; page: PageInfo }> {
    this.requireUserSession(principal);
    const limit = query.limit ?? PAGE_LIMITS.DEFAULT;
    const after = query.cursor ? this.cursors.decode(query.cursor, SORT) : null;
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal);
      const { rows } = await tx.execute<OperationRow>(sql`
        SELECT * FROM app_billing_account_operations_list(
          NULL, ${query.orgId ?? null}::uuid, ${query.account ?? null}::text,
          ${query.kind ?? null}::text, ${query.status ?? null}::text,
          ${after?.i ?? null}::uuid, ${limit + 1}::integer)`);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(operationView),
        page: {
          nextCursor: hasMore && last ? this.cursors.encode({ s: SORT, i: last.id }) : null,
          hasMore,
          limit,
        },
      };
    });
  }

  async get(principal: AuthPrincipal, id: string): Promise<AccountOperationView> {
    this.requireUserSession(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal);
      return this.load(tx, id);
    });
  }

  // --- helpers --------------------------------------------------------------------------

  /**
   * Records an approval refusal, in its own transaction (the approval itself rolled back).
   * The database re-derives the refusal from the account and records it on the operation only
   * if it still holds; the observed refusal is always audited — so a race in which the wallet is
   * unfrozen between the refused approval and this transaction leaves an `audit_only` record
   * rather than none. Transient errors are retried; any other failure is logged at error level,
   * counted and returned as `failed` — never swallowed.
   */
  private async recordRefusal(
    principal: AuthPrincipal,
    id: string,
    observed: string,
  ): Promise<RefusalRecording> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.db.withRequestTenant(async (tx) => {
          const { rows } = await tx.execute<{ refusal: string | null }>(
            sql`SELECT app_billing_account_note_refusal(${id}::uuid) AS refusal`,
          );
          const confirmed = rows[0]?.refusal ?? null;
          const op = await this.load(tx, id);
          await this.audit.record(
            {
              scopeType: 'platform',
              scopeId: null,
              ...actorFromPrincipal(principal),
              action: AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REFUSED,
              resourceType: 'BillingAccountOperation',
              resourceId: op.id,
              outcome: 'failure',
              before: null,
              after: { ...op },
              metadata: {
                orgId: op.orgId,
                account: op.account,
                kind: op.kind,
                refusal: observed,
                recordedOnOperation: confirmed !== null,
                ...(confirmed === null ? { stateChangedBeforeRecording: true } : {}),
              },
            },
            tx,
          );
          return confirmed === null ? 'audit_only' : 'operation_and_audit';
        });
      } catch (error) {
        const state = sqlState(error);
        if (attempt < REFUSAL_RECORD_ATTEMPTS && TRANSIENT.has(state ?? '')) continue;
        this.logger.error({
          msg: 'billing account operation: an approval refusal could not be recorded',
          operationId: id,
          refusal: observed,
          attempts: attempt,
          sqlState: state ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        this.metrics?.billingAccountRefusalRecordFailures.inc();
        return 'failed';
      }
    }
  }

  private async load(tx: Transaction, id: string): Promise<AccountOperationView> {
    const { rows } = await tx.execute<OperationRow>(
      sql`SELECT * FROM app_billing_account_operations_list(${id}::uuid, NULL, NULL, NULL, NULL, NULL, 1)`,
    );
    if (!rows[0]) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Account operation not found',
        logContext: { resource: 'BillingAccountOperation', id },
      });
    }
    return operationView(rows[0]);
  }

  private async accountRows(tx: Transaction, orgId: string): Promise<AccountRow[]> {
    const { rows } = await tx.execute<AccountRow>(
      sql`SELECT * FROM app_billing_accounts_get(${orgId}::uuid)`,
    );
    return rows;
  }

  private async accountOf(
    tx: Transaction,
    op: AccountOperationView,
  ): Promise<BillingAccountView | null> {
    const row = (await this.accountRows(tx, op.orgId)).find((r) => r.account === op.account);
    return row ? accountView(row) : null;
  }

  /** Dual control, first layer (the database's CHECK and definers are the second). */
  private refuseOwnRequest(op: AccountOperationView, principal: AuthPrincipal): void {
    if (op.status === 'pending' && op.requestedBy === principal.userId) throw SELF_APPROVAL();
  }

  private record(
    tx: Transaction,
    principal: AuthPrincipal,
    action: AuditAction,
    after: AccountOperationView,
    before: AccountOperationView | null = null,
  ): Promise<void> {
    return this.audit.record(
      {
        scopeType: 'platform',
        scopeId: null,
        ...actorFromPrincipal(principal),
        action,
        resourceType: 'BillingAccountOperation',
        resourceId: after.id,
        outcome: 'success',
        before: before ? { ...before } : null,
        after: { ...after },
        metadata: { orgId: after.orgId, account: after.account, kind: after.kind },
      },
      tx,
    );
  }

  private count(action: string, outcome: 'executed' | 'pending' | 'rejected' | 'refused'): void {
    this.metrics?.billingAccountOperations.inc({ action, outcome });
  }

  private requireUserSession(principal: AuthPrincipal): void {
    if (principal.actorType !== 'user' || !principal.userId || !principal.sessionId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'Billing account administration requires a signed-in user session',
      });
    }
  }

  /** billing.manage at platform scope, as the 7-6b/7-6c billing routes authorize. */
  private async authorize(tx: Transaction, principal: AuthPrincipal): Promise<void> {
    const { orgId, resellerId } = principal.tenant;
    const hasPlatformGrant = principal.roles.some((grant) => grant.scopeType === 'platform');
    if (
      !(orgId || resellerId || hasPlatformGrant) &&
      !(await this.authorization.allows(tx, {
        principal,
        permission: PERMISSIONS.BILLING_MANAGE,
        target: PLATFORM,
        resourceType: 'Billing',
      }))
    ) {
      RequestContext.recordAuthorizationCheck(PERMISSIONS.BILLING_MANAGE);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: {
          permission: PERMISSIONS.BILLING_MANAGE,
          targetScopeType: 'platform',
          reason: 'unattributable refusal',
        },
      });
    }
    await this.authorization.assert(tx, {
      principal,
      permission: PERMISSIONS.BILLING_MANAGE,
      target: PLATFORM,
      resourceType: 'Billing',
    });
  }
}
