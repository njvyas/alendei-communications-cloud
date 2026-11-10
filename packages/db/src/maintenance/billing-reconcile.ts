/**
 * `billing:reconcile` — Phase 7 PR 7-7a (`DECISIONS.md` §1zi.16; handover
 * `docs/PHASE-7-7A-RECONCILE-HANDOVER.md`; baseline §7.3, §6.5, RQ-4, RQ-6).
 *
 * A read-only, report-only reconciliation of the billing data written by Phases
 * 7.1–7.6d. Checks C-1 to C-6:
 *
 *   C-1 account balances equal the ledger (full history per account);
 *   C-2 terminal billed messages: nothing left reserved, policy-correct charges;
 *   C-3 provider cost per attempt;
 *   C-4 stale open reservations (warning);
 *   C-5 ledger partitions (report-only verdict of the 7-1 report);
 *   C-6 the unknown-outcome register (listing only; never findings).
 *
 * Every query runs inside ONE `REPEATABLE READ READ ONLY` transaction (one snapshot; the
 * database refuses any write), and the run asserts that no transaction id was assigned.
 * Nothing here repairs, resolves or writes; repairs are audited adjustments (a later slice).
 */

import type { ClientBase } from 'pg';

import {
  evaluateLedgerPartitions,
  readLedgerPartitionReport,
  type LedgerPartitionVerdict,
} from './ledger-partitions';

export const RECONCILE_REPORT_VERSION = 1;
/** Approved defaults (owner, 10-Nov-2026). */
export const RECONCILE_DEFAULTS = Object.freeze({
  staleHours: 24,
  statementTimeoutMs: 120_000,
  lockTimeoutMs: 5_000,
});
/** The per-organisation runtime target, measured and reported (not enforced). */
export const RECONCILE_RUNTIME_TARGET_MS = 60_000;

export type CheckId = 'C-1' | 'C-2' | 'C-3' | 'C-4' | 'C-5' | 'C-6';
export type Severity = 'critical' | 'error' | 'warning';

export interface Finding {
  /** Stable identifier: `<check>:<rule>:<subject>` — the same defect always has the same id. */
  readonly id: string;
  readonly check: CheckId;
  readonly rule: string;
  readonly severity: Severity;
  readonly orgId: string | null;
  readonly subject: Readonly<Record<string, string>>;
  readonly expected: number | string | null;
  readonly actual: number | string | null;
  readonly detail: string;
}

export interface CheckResult {
  readonly id: CheckId;
  readonly title: string;
  /** `pass`: ran, no findings; `findings`: ran, findings; `error`: could not complete. */
  readonly status: 'pass' | 'findings' | 'error';
  readonly durationMs: number;
  readonly findings: readonly Finding[];
  readonly info: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface ReconcileReport {
  readonly reportVersion: number;
  readonly command: 'billing:reconcile';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** False when the run could not complete (exit code 2). */
  readonly complete: boolean;
  readonly error: string | null;
  readonly database: string | null;
  readonly migrationProof: string | null;
  readonly snapshotAt: string | null;
  readonly readOnly: boolean;
  readonly transactionIdAssigned: boolean | null;
  readonly scope: {
    readonly orgs: readonly string[] | null;
    readonly since: string | null;
    readonly staleHours: number;
    readonly statementTimeoutMs: number;
  };
  readonly runtimeTargetMs: number;
  readonly checks: readonly CheckResult[];
  readonly summary: {
    readonly findings: number;
    readonly critical: number;
    readonly error: number;
    readonly warning: number;
  };
  readonly exitCode: 0 | 1 | 2;
}

export interface ReconcileOptions {
  /** Restrict C-1–C-4 and C-6 to these organisations; `null` = all. C-5 is global. */
  readonly orgs: readonly string[] | null;
  /** `YYYY-MM`: message-level checks (C-2, C-3, C-4, C-6) only for messages from this month. */
  readonly since: string | null;
  readonly staleHours: number;
  readonly statementTimeoutMs: number;
}

const TERMINAL = new Set(['accepted', 'failed', 'outcome_unknown']);
const OPERATOR_NOTE = 'outcome_unknown_resolved';

const TITLES: Record<CheckId, string> = {
  'C-1': 'Account balances equal the ledger',
  'C-2': 'Terminal billed messages: release and policy-correct charges',
  'C-3': 'Provider cost per attempt',
  'C-4': 'Stale open reservations',
  'C-5': 'Ledger partitions (report-only)',
  'C-6': 'Unknown-outcome register (listing only)',
};

const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));

function finding(
  check: CheckId,
  rule: string,
  severity: Severity,
  orgId: string | null,
  subject: Record<string, string>,
  expected: number | string | null,
  actual: number | string | null,
  detail: string,
): Finding {
  const key = Object.values(subject).join('/');
  return {
    id: `${check}:${rule}:${key}`,
    check,
    rule,
    severity,
    orgId,
    subject,
    expected,
    actual,
    detail,
  };
}

// --- SQL (read-only; every ledger lookup per message names the full fact key) ----------------

/** The §5.2 history proof, as `RELEASE.md` computes it. */
export const SQL_MIGRATION_PROOF = `
  SELECT count(*)::int || '|' || md5(string_agg(hash || ':' || created_at, ',' ORDER BY id)) AS proof
    FROM drizzle.__drizzle_migrations`;

/** C-1, wallets: materialised columns against the ledger, full history per account. */
export const SQL_C1_WALLETS = `
  SELECT w.id AS account_id, w.org_id, w.balance_paise::text AS balance, w.reserved_paise::text AS reserved,
         l.recharged::text, l.charged::text, l.auto_charged::text, l.reserved_in::text, l.released::text
    FROM wallets w
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'recharge'), 0) AS recharged,
             COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'customer_charge'), 0) AS charged,
             COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'customer_charge'
                        AND x.reference_note IS DISTINCT FROM '${OPERATOR_NOTE}'), 0) AS auto_charged,
             COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'reservation'), 0) AS reserved_in,
             COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'reservation_release'), 0) AS released
        FROM usage_ledger x
       WHERE x.org_id = w.org_id AND x.wallet_id = w.id
    ) l
   WHERE ($1::uuid[] IS NULL OR w.org_id = ANY($1::uuid[]))
   ORDER BY w.org_id`;

/** C-1, credit accounts. */
export const SQL_C1_CREDIT = `
  SELECT c.id AS account_id, c.org_id, c.used_paise::text AS used, c.reserved_paise::text AS reserved,
         l.charged::text, l.auto_charged::text, l.reserved_in::text, l.released::text
    FROM credit_accounts c
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'customer_charge'), 0) AS charged,
             COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'customer_charge'
                        AND x.reference_note IS DISTINCT FROM '${OPERATOR_NOTE}'), 0) AS auto_charged,
             COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'reservation'), 0) AS reserved_in,
             COALESCE(sum(x.amount_paise) FILTER (WHERE x.entry_type = 'reservation_release'), 0) AS released
        FROM usage_ledger x
       WHERE x.org_id = c.org_id AND x.credit_account_id = c.id
    ) l
   WHERE ($1::uuid[] IS NULL OR c.org_id = ANY($1::uuid[]))
   ORDER BY c.org_id`;

/**
 * C-2, C-3, C-4: one row per anchor (the message, and each of its attempts) of every billed
 * message in scope, with the facts on that anchor — each looked up by its full fact key
 * (`anchor_month = app_uuidv7_month(anchor)`, anchor, kind) in a per-row LATERAL … LIMIT 1 (the
 * PR #97 technique: the key is unique, so the limit changes no result, and it keeps the lookup a
 * parameterised scan that is pruned at run time to the anchor's one monthly partition instead of
 * a hash join over every partition, which the planner otherwise chooses at volume).
 */
export const SQL_MESSAGE_ANCHORS = `
  WITH msgs AS (
    SELECT m.id, m.org_id, m.status::text AS status, m.billing_policy_snapshot::text AS policy,
           m.created_at
      FROM messages m
     WHERE m.billing_enforced
       AND ($1::uuid[] IS NULL OR m.org_id = ANY($1::uuid[]))
       AND ($2::date IS NULL OR app_uuidv7_month(m.id) >= $2::date)
  ),
  anchors AS (
    SELECT ms.id AS message_id, ms.id AS anchor_id, 'message'::text AS anchor_kind,
           NULL::integer AS attempt_number
      FROM msgs ms
    UNION ALL
    SELECT a.message_id, a.id, 'attempt'::text, a.attempt_number
      FROM message_attempts a JOIN msgs ms ON ms.id = a.message_id
  )
  SELECT an.message_id, ms.org_id, ms.status, ms.policy, ms.created_at,
         an.anchor_id, an.anchor_kind, an.attempt_number,
         b.reached_provider AS reached,
         ev.price::text AS price, ev.cost::text AS cost,
         r.amount::text AS reservation,
         c.amount::text AS charge, c.note AS charge_note,
         rel.amount::text AS release,
         pc.amount::text AS provider_cost,
         res.action AS resolution_action, res.attempt_id AS resolution_attempt_id,
         res.post_provider_cost AS resolution_posts_cost,
         res.provider_cost_paise::text AS resolution_cost
    FROM anchors an
    JOIN msgs ms ON ms.id = an.message_id
    LEFT JOIN message_attempt_billing b
      ON an.anchor_kind = 'attempt' AND b.attempt_id = an.anchor_id
    LEFT JOIN LATERAL (
      SELECT e.total_customer_price_paise AS price, e.total_provider_cost_paise AS cost
        FROM pricing_evaluations e
       WHERE (an.anchor_kind = 'message' AND e.subject = 'message' AND e.message_id = an.message_id)
          OR (an.anchor_kind = 'attempt' AND e.subject = 'attempt' AND e.message_attempt_id = an.anchor_id)
       LIMIT 1
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT l.amount_paise AS amount FROM usage_ledger l
       WHERE l.anchor_month = app_uuidv7_month(an.anchor_id) AND l.anchor_id = an.anchor_id
         AND l.fact_kind = 'reservation'
       LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT l.amount_paise AS amount, l.reference_note AS note FROM usage_ledger l
       WHERE l.anchor_month = app_uuidv7_month(an.anchor_id) AND l.anchor_id = an.anchor_id
         AND l.fact_kind = 'customer_charge'
       LIMIT 1
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT l.amount_paise AS amount FROM usage_ledger l
       WHERE l.anchor_month = app_uuidv7_month(an.anchor_id) AND l.anchor_id = an.anchor_id
         AND l.fact_kind = 'reservation_release'
       LIMIT 1
    ) rel ON true
    LEFT JOIN LATERAL (
      SELECT l.amount_paise AS amount FROM usage_ledger l
       WHERE l.anchor_month = app_uuidv7_month(an.anchor_id) AND l.anchor_id = an.anchor_id
         AND l.fact_kind = 'provider_cost'
       LIMIT 1
    ) pc ON true
    LEFT JOIN billing_unknown_resolutions res
      ON res.message_id = an.message_id AND res.status = 'executed'
   ORDER BY an.message_id, an.anchor_kind DESC, an.attempt_number NULLS FIRST`;

/**
 * C-6: the unknown-outcome register's derivation (`app_billing_unknown_register`, migration
 * `0056` as replaced by `0057`), without its paging and filters. The register function itself
 * requires a signed-in platform user; this is the same query, run read-only by the owner.
 */
export const SQL_C6_REGISTER = `
  WITH items AS (
    SELECT m.id AS message_id,
           m.org_id,
           app_channel_code(m.channel_id) AS channel_code,
           m.billing_policy_snapshot AS billing_policy,
           m.completed_at,
           a.id AS attempt_id,
           a.provider_id,
           (a.delivery_status IN ('delivered', 'undelivered') OR a.read_at IS NOT NULL) AS evidenced,
           CASE WHEN m.billing_policy_snapshot = 'charge_per_attempt' THEN a.id ELSE m.id END AS charge_anchor
      FROM messages m
      LEFT JOIN LATERAL (
        SELECT x.id, x.provider_id, x.delivery_status, x.read_at
          FROM message_attempts x
         WHERE x.message_id = m.id AND x.status = 'outcome_unknown'
         ORDER BY x.attempt_number DESC
         LIMIT 1
      ) a ON true
     WHERE m.billing_enforced
       AND m.status = 'outcome_unknown'
       AND ($1::uuid[] IS NULL OR m.org_id = ANY($1::uuid[]))
       AND ($2::date IS NULL OR app_uuidv7_month(m.id) >= $2::date)
  ),
  assessed AS (
    SELECT i.*,
           CASE WHEN i.billing_policy = 'charge_per_attempt' THEN
             (SELECT sum(e.total_customer_price_paise)::bigint FROM pricing_evaluations e
               WHERE e.subject = 'attempt' AND e.message_id = i.message_id
                 AND (e.message_attempt_id = i.attempt_id
                      OR EXISTS (SELECT 1 FROM message_attempt_billing b
                                  WHERE b.attempt_id = e.message_attempt_id AND b.reached_provider)))
           ELSE
             (SELECT e.total_customer_price_paise FROM pricing_evaluations e
               WHERE e.subject = 'message' AND e.message_id = i.message_id
               LIMIT 1)
           END AS customer_exposure,
           (SELECT e.total_provider_cost_paise FROM pricing_evaluations e
             WHERE e.subject = 'attempt' AND e.message_attempt_id = i.attempt_id) AS cost_exposure,
           (i.charge_anchor IS NOT NULL AND EXISTS (
              SELECT 1 FROM usage_ledger l
               WHERE l.anchor_month = app_uuidv7_month(i.charge_anchor)
                 AND l.anchor_id = i.charge_anchor
                 AND l.fact_kind = 'customer_charge'
                 AND l.message_id = i.message_id)) AS charged,
           (i.attempt_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM usage_ledger l
               WHERE l.anchor_month = app_uuidv7_month(i.attempt_id)
                 AND l.anchor_id = i.attempt_id
                 AND l.fact_kind = 'provider_cost')) AS costed,
           (SELECT x.action FROM billing_unknown_resolutions x
             WHERE x.message_id = i.message_id AND x.status = 'executed') AS executed_action,
           EXISTS (SELECT 1 FROM billing_unknown_resolutions x
                    WHERE x.message_id = i.message_id AND x.status = 'pending') AS pending
      FROM items i
  ),
  labelled AS (
    SELECT s.*,
           CASE WHEN s.evidenced THEN 'evidenced' ELSE 'unevidenced' END AS evidence_label,
           CASE
             WHEN s.executed_action = 'write_off' THEN 'written_off'
             WHEN (s.charged OR s.executed_action = 'charge') AND s.costed THEN 'charged'
             WHEN s.charged OR s.executed_action = 'charge' THEN 'charged_without_cost'
             WHEN s.pending THEN 'pending_approval'
             ELSE 'open'
           END AS status_label
      FROM assessed s
  )
  SELECT r.message_id, r.org_id, r.channel_code, r.billing_policy::text AS billing_policy,
         r.completed_at, floor(extract(epoch FROM (now() - r.completed_at)))::bigint::text AS age_seconds,
         r.attempt_id, r.provider_id,
         r.customer_exposure::text AS estimated_customer_paise,
         r.cost_exposure::text AS estimated_provider_cost_paise,
         r.evidence_label AS evidence, r.status_label AS status
    FROM labelled r
   ORDER BY r.completed_at, r.message_id`;

// --- pure evaluation ------------------------------------------------------------------------

export interface WalletRow {
  account_id: string;
  org_id: string;
  balance: string;
  reserved: string;
  recharged: string;
  charged: string;
  auto_charged: string;
  reserved_in: string;
  released: string;
}

export interface CreditRow {
  account_id: string;
  org_id: string;
  used: string;
  reserved: string;
  charged: string;
  auto_charged: string;
  reserved_in: string;
  released: string;
}

/** C-1: materialised columns against the ledger. */
export function evaluateBalances(
  wallets: readonly WalletRow[],
  credits: readonly CreditRow[],
): Finding[] {
  const out: Finding[] = [];
  const check = (
    rule: string,
    org: string,
    account: string,
    kind: string,
    expected: number,
    actual: number,
    what: string,
  ) => {
    if (expected !== actual) {
      out.push(
        finding(
          'C-1',
          rule,
          'error',
          org,
          { account, kind },
          expected,
          actual,
          `${what}: materialised ${actual} paise, ledger ${expected} paise`,
        ),
      );
    }
  };
  for (const w of wallets) {
    check(
      'wallet_balance',
      w.org_id,
      w.account_id,
      'wallet',
      num(w.recharged) - num(w.charged),
      num(w.balance),
      'wallet balance',
    );
    check(
      'wallet_reserved',
      w.org_id,
      w.account_id,
      'wallet',
      num(w.reserved_in) - num(w.released) - num(w.auto_charged),
      num(w.reserved),
      'wallet reserved',
    );
  }
  for (const c of credits) {
    check(
      'credit_used',
      c.org_id,
      c.account_id,
      'credit_account',
      num(c.charged),
      num(c.used),
      'credit used',
    );
    check(
      'credit_reserved',
      c.org_id,
      c.account_id,
      'credit_account',
      num(c.reserved_in) - num(c.released) - num(c.auto_charged),
      num(c.reserved),
      'credit reserved',
    );
  }
  return out;
}

export interface AnchorRow {
  message_id: string;
  org_id: string;
  status: string;
  policy: string;
  created_at: Date | string;
  anchor_id: string;
  anchor_kind: 'message' | 'attempt';
  attempt_number: number | null;
  reached: boolean | null;
  price: string | null;
  cost: string | null;
  reservation: string | null;
  charge: string | null;
  charge_note: string | null;
  release: string | null;
  provider_cost: string | null;
  resolution_action: string | null;
  resolution_attempt_id: string | null;
  resolution_posts_cost: boolean | null;
  resolution_cost: string | null;
}

export interface MessageEvaluation {
  readonly c2: Finding[];
  readonly c3: Finding[];
  readonly c4: Finding[];
  readonly info: {
    readonly messages: number;
    readonly terminal: number;
    readonly attempts: number;
    readonly openReservationPaise: number;
  };
}

/** C-2, C-3, C-4 from the anchor rows of each billed message. */
export function evaluateMessages(
  rows: readonly AnchorRow[],
  snapshotAt: Date,
  staleHours: number,
): MessageEvaluation {
  const byMessage = new Map<string, AnchorRow[]>();
  for (const r of rows) {
    const list = byMessage.get(r.message_id) ?? [];
    list.push(r);
    byMessage.set(r.message_id, list);
  }
  const c2: Finding[] = [];
  const c3: Finding[] = [];
  const c4: Finding[] = [];
  let terminal = 0;
  let attempts = 0;
  let openReservation = 0;

  for (const [messageId, anchors] of byMessage) {
    const message = anchors.find((a) => a.anchor_kind === 'message')!;
    const atts = anchors.filter((a) => a.anchor_kind === 'attempt');
    attempts += atts.length;
    const org = message.org_id;
    const isOperator = (a: AnchorRow) => a.charge !== null && a.charge_note === OPERATOR_NOTE;
    const autoCharge = (a: AnchorRow) => (a.charge !== null && !isOperator(a) ? num(a.charge) : 0);
    const opCharge = (a: AnchorRow) => (isOperator(a) ? num(a.charge) : 0);
    const reserved = anchors.reduce((s, a) => s + num(a.reservation), 0);
    const auto = anchors.reduce((s, a) => s + autoCharge(a), 0);
    const outstanding = reserved - auto - num(message.release);
    const resolution = message.resolution_action;

    if (!TERMINAL.has(message.status)) {
      // C-4: a non-terminal message still holding funds past the threshold.
      if (outstanding > 0) {
        openReservation += outstanding;
        const created = new Date(message.created_at);
        const ageHours = (snapshotAt.getTime() - created.getTime()) / 3_600_000;
        if (ageHours > staleHours) {
          c4.push(
            finding(
              'C-4',
              'stale_reservation',
              'warning',
              org,
              { message: messageId },
              0,
              outstanding,
              `non-terminal (${message.status}) message holds ${outstanding} paise reserved for ${Math.floor(ageHours)} h (threshold ${staleHours} h)`,
            ),
          );
        }
      }
    } else {
      terminal += 1;
      // C-2(a): nothing left reserved at the terminal state.
      if (outstanding !== 0) {
        c2.push(
          finding(
            'C-2',
            'outstanding_reservation',
            'error',
            org,
            { message: messageId },
            0,
            outstanding,
            `terminal (${message.status}) message: reserved ${reserved} − automatic charges ${auto} − release ${num(message.release)} = ${outstanding} paise outstanding`,
          ),
        );
      }
      // C-2(b): the policy-correct charges, per anchor.
      const expectedAuto = new Map<string, number>();
      const expectedOp = new Map<string, number>();
      const missingEvaluation = (a: AnchorRow) =>
        c2.push(
          finding(
            'C-2',
            'missing_evaluation',
            'error',
            org,
            { anchor: a.anchor_id },
            'evaluation',
            null,
            `${a.anchor_kind} ${a.anchor_id} has no customer-price evaluation`,
          ),
        );
      const price = (a: AnchorRow): number | null => {
        if (a.price === null) {
          missingEvaluation(a);
          return null;
        }
        return num(a.price);
      };
      const perAttempt = message.policy === 'charge_per_attempt';
      if (message.status === 'accepted') {
        if (!perAttempt) {
          const p = price(message);
          if (p !== null && p > 0) expectedAuto.set(message.anchor_id, p);
        } else {
          for (const a of atts.filter((x) => x.reached === true)) {
            const p = price(a);
            if (p !== null && p > 0) expectedAuto.set(a.anchor_id, p);
          }
        }
      } else if (message.status === 'outcome_unknown' && resolution === 'charge') {
        // 7-6c (Policy U, D-76c-1): the executed charge resolution's lines.
        if (!perAttempt) {
          const p = price(message);
          if (p !== null && p > 0) expectedOp.set(message.anchor_id, p);
        } else {
          for (const a of atts.filter(
            (x) => x.reached === true || x.anchor_id === message.resolution_attempt_id,
          )) {
            const p = price(a);
            if (p !== null && p > 0) expectedOp.set(a.anchor_id, p);
          }
        }
      }
      for (const a of anchors) {
        const expA = expectedAuto.get(a.anchor_id) ?? 0;
        const actA = autoCharge(a);
        if (expA !== actA) {
          c2.push(
            finding(
              'C-2',
              expA === 0 ? 'unexpected_charge' : 'charge_mismatch',
              'error',
              org,
              { anchor: a.anchor_id },
              expA,
              actA,
              `${message.status} ${message.policy} message ${messageId}: automatic charge on ${a.anchor_kind} ${a.anchor_id} is ${actA}, expected ${expA}`,
            ),
          );
        }
        const expO = expectedOp.get(a.anchor_id) ?? 0;
        const actO = opCharge(a);
        if (expO !== actO) {
          const rule =
            actO > 0 && resolution !== 'charge'
              ? 'unauthorised_operator_charge'
              : expO === 0
                ? 'unexpected_operator_charge'
                : 'operator_charge_mismatch';
          c2.push(
            finding(
              'C-2',
              rule,
              'error',
              org,
              { anchor: a.anchor_id },
              expO,
              actO,
              `${message.status} message ${messageId}: operator charge on ${a.anchor_kind} ${a.anchor_id} is ${actO}, expected ${expO} (executed resolution: ${resolution ?? 'none'})`,
            ),
          );
        }
      }
    }

    // C-3: provider cost per attempt (terminal or not).
    for (const a of atts) {
      let expected = 0;
      if (a.reached === true) {
        if (a.cost === null) {
          c3.push(
            finding(
              'C-3',
              'missing_evaluation',
              'error',
              org,
              { attempt: a.anchor_id },
              'evaluation',
              null,
              `attempt ${a.anchor_id} reached the provider but has no provider-cost evaluation`,
            ),
          );
        } else expected = Math.max(num(a.cost), 0);
      }
      if (
        message.resolution_action === 'charge' &&
        message.resolution_posts_cost === true &&
        message.resolution_attempt_id === a.anchor_id
      ) {
        expected = num(message.resolution_cost);
      }
      const actual = num(a.provider_cost);
      if (expected !== actual) {
        c3.push(
          finding(
            'C-3',
            expected === 0 ? 'unexpected_provider_cost' : 'provider_cost_mismatch',
            'error',
            org,
            { attempt: a.anchor_id },
            expected,
            actual,
            `attempt ${a.anchor_id} of message ${messageId} (reached: ${a.reached ?? 'unrecorded'}): provider cost ${actual}, expected ${expected}`,
          ),
        );
      }
    }
  }

  return {
    c2,
    c3,
    c4,
    info: { messages: byMessage.size, terminal, attempts, openReservationPaise: openReservation },
  };
}

/** C-5: the 7-1 partition verdict as findings (report-only). */
export function partitionFindings(verdict: LedgerPartitionVerdict, now: Date): Finding[] {
  const out: Finding[] = [];
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (!verdict.currentMonthCovered) {
    out.push(
      finding(
        'C-5',
        'current_month_missing',
        'critical',
        null,
        { month: current },
        'attached',
        'missing',
        `no partition covers the current month ${current}`,
      ),
    );
  }
  for (const gap of verdict.gaps) {
    out.push(
      finding(
        'C-5',
        'gap',
        'error',
        null,
        { month: gap },
        'attached',
        'missing',
        `partition gap at ${gap}`,
      ),
    );
  }
  for (const p of verdict.unprotected) {
    out.push(
      finding(
        'C-5',
        'unprotected',
        'error',
        null,
        { partition: p },
        'guarded',
        'unguarded',
        `partition ${p} lacks a required protection (statement guard, row guard, RLS or restricted privileges)`,
      ),
    );
  }
  for (const t of verdict.orphans) {
    out.push(
      finding(
        'C-5',
        'orphan',
        'error',
        null,
        { table: t },
        'attached',
        'orphan',
        `table ${t} is named like a ledger partition but is not attached`,
      ),
    );
  }
  if (verdict.currentMonthCovered) {
    if (verdict.headroomMonths < 2) {
      out.push(
        finding(
          'C-5',
          'headroom',
          'critical',
          null,
          { table: 'usage_ledger' },
          2,
          verdict.headroomMonths,
          `partition headroom ${verdict.headroomMonths} month(s) is below the critical threshold (2)`,
        ),
      );
    } else if (verdict.headroomMonths < 6) {
      out.push(
        finding(
          'C-5',
          'headroom',
          'warning',
          null,
          { table: 'usage_ledger' },
          6,
          verdict.headroomMonths,
          `partition headroom ${verdict.headroomMonths} month(s) is below the warning threshold (6)`,
        ),
      );
    }
  }
  return out;
}

export function exitCodeFor(checks: readonly CheckResult[], complete: boolean): 0 | 1 | 2 {
  if (!complete || checks.some((c) => c.status === 'error')) return 2;
  return checks.some((c) => c.findings.length > 0) ? 1 : 0;
}

// --- the run -------------------------------------------------------------------------------

const errorText = (e: unknown): string => {
  const err = e as { code?: string; message?: string };
  return `${err?.code ? `${err.code} ` : ''}${err?.message ?? String(e)}`;
};

/**
 * Runs C-1 to C-6 in one read-only transaction on `client` (the schema owner's connection).
 * Never throws for a check's failure: the check is marked `error` and the report incomplete.
 * Throws only if the read-only transaction itself cannot be opened.
 */
export async function runReconcile(
  client: ClientBase,
  options: ReconcileOptions,
  clock: () => Date = () => new Date(),
): Promise<ReconcileReport> {
  const started = clock();
  const orgs = options.orgs && options.orgs.length > 0 ? [...options.orgs] : null;
  const since = options.since ? `${options.since}-01` : null;
  const checks: CheckResult[] = [];
  let database: string | null = null;
  let proof: string | null = null;
  let snapshotAt: Date | null = null;
  let xidAssigned: boolean | null = null;
  let fatal: string | null = null;

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(options.statementTimeoutMs)}`);
    await client.query(`SET LOCAL lock_timeout = ${RECONCILE_DEFAULTS.lockTimeoutMs}`);
    const head = await client.query<{ db: string; at: Date }>(
      'SELECT current_database() AS db, now() AS at',
    );
    database = head.rows[0]!.db;
    snapshotAt = new Date(head.rows[0]!.at);
    proof = (await client.query<{ proof: string }>(SQL_MIGRATION_PROOF)).rows[0]?.proof ?? null;

    /** Runs one check under a savepoint, so a failing check never aborts the others. */
    const step = async (
      id: CheckId,
      body: () => Promise<{ findings: Finding[]; info: Record<string, unknown> }>,
    ) => {
      const t0 = Date.now();
      await client.query('SAVEPOINT reconcile_check');
      try {
        const { findings, info } = await body();
        await client.query('RELEASE SAVEPOINT reconcile_check');
        checks.push({
          id,
          title: TITLES[id],
          status: findings.length > 0 ? 'findings' : 'pass',
          durationMs: Date.now() - t0,
          findings,
          info,
        });
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT reconcile_check');
        checks.push({
          id,
          title: TITLES[id],
          status: 'error',
          durationMs: Date.now() - t0,
          findings: [],
          info: {},
          error: errorText(error),
        });
      }
    };

    await step('C-1', async () => {
      const wallets = (await client.query<WalletRow>(SQL_C1_WALLETS, [orgs])).rows;
      const credits = (await client.query<CreditRow>(SQL_C1_CREDIT, [orgs])).rows;
      return {
        findings: evaluateBalances(wallets, credits),
        info: { wallets: wallets.length, creditAccounts: credits.length },
      };
    });

    let evaluation: MessageEvaluation | null = null;
    let anchorError: unknown = null;
    const anchors = async () => {
      if (evaluation) return evaluation;
      if (anchorError) throw anchorError;
      try {
        const rows = (await client.query<AnchorRow>(SQL_MESSAGE_ANCHORS, [orgs, since])).rows;
        evaluation = evaluateMessages(rows, snapshotAt!, options.staleHours);
        return evaluation;
      } catch (error) {
        anchorError = error;
        throw error;
      }
    };
    await step('C-2', async () => {
      const e = await anchors();
      return {
        findings: e.c2,
        info: { billedMessages: e.info.messages, terminal: e.info.terminal },
      };
    });
    await step('C-3', async () => {
      const e = await anchors();
      return { findings: e.c3, info: { attempts: e.info.attempts } };
    });
    await step('C-4', async () => {
      const e = await anchors();
      return {
        findings: e.c4,
        info: { staleHours: options.staleHours, openReservationPaise: e.info.openReservationPaise },
      };
    });

    await step('C-5', async () => {
      const verdict = evaluateLedgerPartitions(
        await readLedgerPartitionReport(client),
        snapshotAt!,
      );
      return {
        findings: partitionFindings(verdict, snapshotAt!),
        info: {
          level: verdict.level,
          headroomMonths: verdict.headroomMonths,
          summary: verdict.summary,
        },
      };
    });

    await step('C-6', async () => {
      const items = (
        await client.query<Record<string, unknown> & { status: string; channel_code: string }>(
          SQL_C6_REGISTER,
          [orgs, since],
        )
      ).rows;
      const byStatus: Record<string, number> = {};
      const byChannel: Record<string, number> = {};
      let exposure = 0;
      for (const i of items) {
        byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
        byChannel[i.channel_code] = (byChannel[i.channel_code] ?? 0) + 1;
        if (i.status === 'open' || i.status === 'pending_approval') {
          exposure += num(i.estimated_customer_paise as string | null);
        }
      }
      // A listing only: open items are information, never findings (OD-7-4U).
      return {
        findings: [],
        info: {
          items: items.map((i) => ({
            ...i,
            completed_at:
              i.completed_at instanceof Date ? i.completed_at.toISOString() : i.completed_at,
          })),
          count: items.length,
          byStatus,
          byChannel,
          openEstimatedCustomerPaise: exposure,
        },
      };
    });

    const x = await client.query<{ xid: string | null }>(
      'SELECT txid_current_if_assigned()::text AS xid',
    );
    xidAssigned = x.rows[0]?.xid != null;
    if (xidAssigned) fatal = 'a transaction id was assigned: the run attempted a write';
    await client.query('COMMIT');
  } catch (error) {
    fatal = fatal ?? errorText(error);
    await client.query('ROLLBACK').catch(() => undefined);
  }

  const finished = clock();
  const all = checks.flatMap((c) => c.findings);
  const complete =
    fatal === null && checks.length === 6 && checks.every((c) => c.status !== 'error');
  return {
    reportVersion: RECONCILE_REPORT_VERSION,
    command: 'billing:reconcile',
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    complete,
    error: fatal ?? checks.find((c) => c.status === 'error')?.error ?? null,
    database,
    migrationProof: proof,
    snapshotAt: snapshotAt ? snapshotAt.toISOString() : null,
    readOnly: true,
    transactionIdAssigned: xidAssigned,
    scope: {
      orgs,
      since: options.since,
      staleHours: options.staleHours,
      statementTimeoutMs: options.statementTimeoutMs,
    },
    runtimeTargetMs: RECONCILE_RUNTIME_TARGET_MS,
    checks,
    summary: {
      findings: all.length,
      critical: all.filter((f) => f.severity === 'critical').length,
      error: all.filter((f) => f.severity === 'error').length,
      warning: all.filter((f) => f.severity === 'warning').length,
    },
    exitCode: exitCodeFor(checks, complete),
  };
}

// --- the human report ---------------------------------------------------------------------

export function renderHuman(report: ReconcileReport): string {
  const lines: string[] = [];
  lines.push('billing:reconcile — read-only billing reconciliation (Phase 7.7a)');
  lines.push(
    `database ${report.database ?? '?'}  migrations ${report.migrationProof ?? '?'}  snapshot ${report.snapshotAt ?? '?'}`,
  );
  lines.push(
    `read-only transaction: yes  transaction id assigned: ${report.transactionIdAssigned === null ? 'unknown' : report.transactionIdAssigned ? 'YES' : 'no'}`,
  );
  lines.push(
    `scope: orgs ${report.scope.orgs ? report.scope.orgs.join(', ') : 'all'}; since ${report.scope.since ?? 'all'}; stale threshold ${report.scope.staleHours} h; statement timeout ${report.scope.statementTimeoutMs} ms`,
  );
  lines.push('');
  for (const c of report.checks) {
    const head =
      c.status === 'pass'
        ? 'PASS'
        : c.status === 'findings'
          ? `FINDINGS (${c.findings.length})`
          : 'ERROR';
    lines.push(`${c.id} ${c.title}: ${head}  [${c.durationMs} ms]`);
    if (c.error) lines.push(`  error: ${c.error}`);
    for (const f of c.findings) {
      lines.push(`  ${f.severity.toUpperCase()} ${f.id}`);
      lines.push(`    ${f.detail}${f.orgId ? `  (org ${f.orgId})` : ''}`);
    }
    if (c.id === 'C-6') {
      const info = c.info as { count?: number; byStatus?: Record<string, number> };
      lines.push(
        `  ${info.count ?? 0} unknown-outcome item(s)${
          info.byStatus
            ? `: ${Object.entries(info.byStatus)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')}`
            : ''
        } (listing only; never a finding)`,
      );
    } else if (c.status !== 'error') {
      const info = Object.entries(c.info)
        .filter(([, v]) => typeof v !== 'object')
        .map(([k, v]) => `${k} ${String(v)}`)
        .join('; ');
      if (info) lines.push(`  ${info}`);
    }
  }
  lines.push('');
  const runtime = `${report.durationMs} ms (target per organisation: ${report.runtimeTargetMs} ms${report.scope.orgs && report.scope.orgs.length === 1 ? (report.durationMs <= report.runtimeTargetMs ? ', met' : ', EXCEEDED') : ''})`;
  lines.push(
    `summary: ${report.summary.findings} finding(s) — critical ${report.summary.critical}, error ${report.summary.error}, warning ${report.summary.warning}; runtime ${runtime}`,
  );
  if (!report.complete) lines.push(`INCOMPLETE: ${report.error ?? 'the run could not complete'}`);
  lines.push(`exit code ${report.exitCode} (0 clean, 1 findings, 2 could not complete)`);
  return lines.join('\n');
}
