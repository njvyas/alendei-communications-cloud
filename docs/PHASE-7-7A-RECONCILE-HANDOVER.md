# ACC Phase 7.7a: `billing:reconcile`, Implementation Handover

**Status:** DRAFT for owner review, 10-Nov-2026. Documentation only. **Implementation is not authorised.**
**Baseline:** `origin/develop` `36cd1e5` (PR #101 merged; migrations `0000`–`0060`; proof `61|da9371bb1f6a3e2cdc765f88823e8f02`).
**Parent:** `PHASE-7-7-IMPLEMENTATION-HANDOVER.md` Rev 2, §6 and §8 (slice 7-7a). **Open owner decisions needed:** none. The defaults marked [P] in §8 are confirmable.

---

## 1. Scope (exact)

**In scope:** a read-only, report-only operator command, `billing:reconcile`, implementing **checks C-1 to C-6** (§4) over the merged Phase 7.1–7.6d data. It produces a human-readable report and a JSON report, with exit codes 0, 1 and 2.

**Out of scope (nothing of these in this PR):**
- any financial write, ledger fact, repair or adjustment ("repair" is the operator's separate, audited action in a later slice);
- any migration, database function, grant or policy change;
- any API route, DTO or OpenAPI change;
- metrics, gauges or dashboards (D-77-7);
- checks C-7 and C-8 (added with 7-7b and 7-7c);
- any partition creation or ensure;
- scheduling or any worker.

Billing enforcement is unchanged; no QA or production activity.

## 2. Placement [P]

| Item | Path |
|---|---|
| Checks (SQL) and pure evaluation | `packages/db/src/maintenance/billing-reconcile.ts` |
| Command | `packages/db/src/cli/billing-reconcile.ts` |
| Scripts | `billing:reconcile` in `packages/db/package.json`, with a root alias |
| Runbook | A `billing:reconcile` section in `docs/RUNBOOK.md` (when to run: weekly and in every deploy checklist, per baseline §9.1; how to read findings; repairs only by audited adjustment once 7-7b exists) |
| Decision record | `DECISIONS.md` §1zi.16 "PR 7-7a as built" |

It follows the `db:ledger:partitions` pattern:
- the owner connection `DATABASE_ADMIN_URL`, which is needed to read every tenant's rows despite RLS;
- the shared `_env.ts` loading;
- no application-role use.

## 3. Read-only guarantee

1. **One transaction:** `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` runs every check on one consistent snapshot. PostgreSQL refuses any data write or DDL in it (`25006 read_only_sql_transaction`).
2. **Session guards:** `SET LOCAL statement_timeout` (§8) and `SET LOCAL lock_timeout = '5s'`. A read-only transaction takes only `ACCESS SHARE` locks, so it never blocks writers' row locks.
3. **No transaction id:** before `COMMIT`, the run asserts `txid_current_if_assigned() IS NULL`. A read-only transaction never needs one. A non-null value is reported, and the run exits **2**.
4. **Partition checks are report-only:**
   - they read `app_ledger_partition_report()` (STABLE, SECURITY INVOKER) through the shared `readLedgerPartitionReport` and apply the shared pure `evaluateLedgerPartitions` verdict;
   - they **never** call `app_ledger_ensure_partitions`, the `--ensure` path or any write.
5. **No other side effects:** the command creates no table (temporary tables are refused in a read-only transaction anyway), calls no `set_config` and writes no audit row. It writes files only where the operator asks (`--json <path>`).
6. **Static guarantee:** a unit test reads the reconcile sources and fails on any of the following:
   - `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `MERGE`, `COPY`;
   - `CREATE`, `ALTER`, `DROP`, `GRANT`, `REVOKE`;
   - `set_config`;
   - `app_ledger_ensure_partitions`, `ensureAndVerifyLedgerPartitions`, `app_ledger_post`;
   - a call to any `app_billing_*` mutation function.

## 4. Checks

All monetary values are integer paise. Each finding records:
- the check id and severity (`critical`, `error`, `warning`);
- the organisation and the account / message / attempt / partition concerned;
- `expected` and `actual`;
- a short rule text.

Checks never stop at the first finding.

### C-1 Account balances equal the ledger (all history per account)

| Account | Field | Expected from the ledger |
|---|---|---|
| Wallet | `balance_paise` | Σ `recharge` − Σ `customer_charge` (wallet facts) |
| Wallet | `reserved_paise` | Σ `reservation` − Σ `reservation_release` − Σ automatic `customer_charge` |
| Credit account | `used_paise` | Σ `customer_charge` (credit facts) |
| Credit account | `reserved_paise` | Σ `reservation` − Σ `reservation_release` − Σ automatic `customer_charge` |

- "Automatic" means a charge whose `reference_note` is not `outcome_unknown_resolved`. Operator charges (7-6c) do not draw on the reservation.
- Any difference is `error`.
- Reported but not a finding: `credit_limit_paise` (configuration, not ledger-derived) and frozen status.
- **Gap documented:** accounts whose opening balance was set outside the ledger before 7-6d (test fixtures only; there is no such production path) show as drift by design.

### C-2 Terminal billed messages: release and policy-correct charges

For every message with `billing_enforced` and status `accepted`, `failed` or `outcome_unknown`:
- **(a)** the outstanding reservation (Σ reservation − Σ automatic charge − Σ release) is **0**. A release row exists only when something was left to release; 7.5's writer posts none for zero, so "one release" is checked as "at most one", plus outstanding = 0;
- **(b)** charges follow the snapshotted policy:

  | Status | Policy | Charges expected |
  |---|---|---|
  | `accepted` | `charge_per_logical_message` | One automatic charge on the message anchor equal to E_m when E_m > 0, else none |
  | `accepted` | `charge_per_attempt` | One automatic charge on each attempt recorded as reaching the provider, equal to its E_a when > 0; none on other attempts |
  | `failed` | Either | No charge (failed-delivery fee 0) |
  | `outcome_unknown` | Either | No automatic charge. Operator charges are allowed only with an executed charge resolution for the message (7-6c), and then only on the anchors that resolution's rules produce (D-76c-1) |

Each violation is `error`. Ledger lookups name the full fact key, including `anchor_month = app_uuidv7_month(anchor)` (the PR #97 pattern), so they prune.

### C-3 Provider cost per attempt

For every attempt of a billed message:
- **reached the provider** (`message_attempt_billing.reached_provider = true`): exactly one `provider_cost` fact on the attempt anchor, equal to the attempt evaluation's provider cost when > 0;
- **otherwise:** none, except the one posted by an executed evidenced charge resolution on the unknown attempt (7-6c, O-1).

A missing, extra or unequal cost is `error`.

### C-4 Stale open reservations

- **What is reported:** a non-terminal billed message with an outstanding reservation > 0, older than the stale threshold (default 24 h [P], `--stale-hours`) — `warning`.
- **Not a finding:** the same message younger than the threshold. The total open reservation is reported as information.

### C-5 Ledger partitions (report-only)

From the partition report and the shared verdict:
- a continuity gap, a partition missing a TRUNCATE or row guard, RLS or restricted privileges, or an orphan `usage_ledger_p*` table: `error`;
- headroom below 2 months: `critical`;
- headroom below 6 months: `warning` (RQ-6).

The report states that partitions are extended only by `db:migrate`, application start or `db:ledger:partitions --ensure`. Reconcile itself never does.

### C-6 Unknown-outcome section (OD-7-4U)

- **Listing:** every billed `outcome_unknown` message, with organisation, channel, policy, unknown attempt, age, evidence, status (`open`, `pending_approval`, `charged`, `charged_without_cost`, `written_off`) and estimated exposure (report-only, never a ledger fact). It uses the same derivation as `app_billing_unknown_register` (`0056`, as replaced in `0057`), re-expressed in the reconcile query. It cannot call the register function, which requires a signed-in platform user.
- **Summary:** counts and exposure by status and channel.
- **Findings:** **none.** Open items are information, not defects. Policy breaches on these messages are C-2 or C-3 findings.

## 5. Command and output

```
npm run billing:reconcile -- [--org <uuid> ...] [--since <YYYY-MM>] [--stale-hours <n>]
                            [--statement-timeout-ms <n>] [--json <path|->] [--quiet]
```

**Options:**
- `--org`: limits C-1 to C-4 and C-6 to the given organisations (repeatable). C-5 is global.
- `--since`: limits the message-level checks (C-2, C-3, C-4, C-6) to messages whose id month is ≥ the month given. C-1 always covers an account's full history, which the balance needs.
- **Human report (stdout):**
  - a header (database name, the migration history proof, the snapshot time, read-only = true, transaction id = none);
  - one block per check (status, counts, findings table, duration);
  - a summary and the exit code.
- **JSON report** (`--json <path>`, or `-` for stdout instead of the human report), versioned:

```json
{ "reportVersion": 1, "startedAt": "...", "finishedAt": "...",
  "database": "...", "migrationProof": "61|...", "readOnly": true, "transactionIdAssigned": false,
  "scope": { "orgs": [], "since": null, "staleHours": 24 },
  "checks": [ { "id": "C-1", "status": "pass|findings|error", "durationMs": 0,
                "findings": [ { "severity": "error", "orgId": "...", "subject": { "accountId": "..." },
                                "rule": "...", "expected": 0, "actual": 0 } ],
                "info": {} } ],
  "summary": { "critical": 0, "error": 0, "warning": 0 }, "exitCode": 0 }
```

- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | `0` | Every check ran; no findings (C-6 listings are not findings) |
  | `1` | Every check ran; at least one finding of any severity |
  | `2` | The run could not complete (invalid arguments, connection failure, statement or lock timeout, unexpected error, or a transaction id was assigned). A partial report is printed and marked incomplete |

- **Confidentiality:** the report contains financial data for operators. Nothing is logged at info level beyond the run summary, and amounts appear only in the report itself.

## 6. Acceptance tests

**Where they run:** DB integration, on disposable clones only (`scripts/with-db-clone.mjs`). Each fixture organisation is built through the real paths:
- account operations;
- recharge;
- the 7.4 reservation and 7.5 settlement functions (or the writer, as their suites do);
- 7-6c resolutions.

Defects are injected only as committed owner changes with triggers suspended, then removed in teardown.

| ID | Case | Expected |
|---|---|---|
| A-1 | **Clean run:** organisations covering both policies, both billing modes, accepted, failed and unknown messages, an executed charge and a write-off resolution, recharges and a frozen account | Exit 0; zero findings for those organisations; C-6 lists the unknown items exactly as `app_billing_unknown_register` does for the same data (parity, field by field) |
| A-2 | Wallet `balance_paise` +1 | C-1 `error`, expected and actual exact; exit 1 |
| A-3 | Wallet or credit `reserved_paise` drift; credit `used_paise` drift | C-1 `error` for each |
| A-4 | Accepted per-message message with its release removed (outstanding > 0) | C-2(a) `error` |
| A-5 | Accepted per-message charge of the wrong amount; a missing charge; a charge on an attempt anchor under `charge_per_logical_message` | C-2(b) `error` for each |
| A-6 | Failed message with an automatic charge; unknown message with an operator-noted charge but no executed resolution | C-2(b) `error` |
| A-7 | Reached attempt without provider cost; unreached attempt with one; cost ≠ evaluation | C-3 `error` for each |
| A-8 | Non-terminal message with an open reservation older and younger than the threshold | One C-4 `warning` (the older one only) |
| A-9 | A far-future partition with its TRUNCATE guard removed; an orphan `usage_ledger_p*` table | C-5 `error` for each |
| A-10 | Headroom below 6 and below 2 months | C-5 `warning`, then `critical` (pure verdict tests with a shifted clock, as the 7-1 suite does) |
| A-11 | Every defect at once | All reported in one run; no early stop; exit 1 |
| A-12 | Invalid arguments; unreachable database; `--statement-timeout-ms 1` | Exit 2, with an incomplete-report marker |

**Read-only proofs:**
- **R-1:** the command's database client records every statement. The first is `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`; none is a write, DDL, `set_config` or an ensure call.
- **R-2:** the JSON report states `transactionIdAssigned: false` for every run in the suite.
- **R-3:** row counts, and the sums of `usage_ledger`, `wallets`, `credit_accounts`, `billing_account_operations`, `billing_unknown_resolutions` and `idempotency_keys`, are identical before and after every run. So are the partition list and its guards.
- **R-4:** the static source test of §3(6).

**Mutation checks** (each must fail the suite), recorded in the evidence:
- dropping `READ ONLY` together with an injected insert (proves R-1 and R-3 detect a write);
- removing the `anchor_month` predicate from a C-2 lookup (the pruning test fails);
- ignoring `reference_note` in C-1 (the operator-charge reserved formula breaks A-1);
- C-2 accepting any charge amount (A-5 passes wrongly, so the suite fails).

**Format and unit tests:**
- argument parsing;
- exit-code mapping;
- the JSON schema shape (version, required fields);
- human-report rendering of each status;
- the pure C-5 verdict mapping.

## 7. Runtime bounds and partition pruning

- **Pruning (asserted in CI, the 7-6b technique):** `EXPLAIN (ANALYZE, FORMAT JSON)` of the C-2, C-3 and C-6 ledger lookups on a fixture spanning several months shows that only the anchors' monthly partitions execute; the others are pruned at initialisation or never executed.
- **C-1 cannot prune by month,** because a balance needs full history. Its per-account aggregation must use the `(org_id, occurred_at)` index on each partition, with no sequential scan of any `usage_ledger` partition for an `--org` run. The plan is asserted and recorded.
- **Volume measurement (evidence, not a CI gate):**
  - **fixture:** a seeded clone with one organisation of 100,000 ledger facts across 3 months and 30,000 messages (both policies), plus the standard seed;
  - **record:** the wall time of `billing:reconcile --org <it>` and of a full run, with `EXPLAIN` plans per check, in the evidence folder;
  - **budget [P]:** ≤ 60 s for the `--org` run on the development host. A breach is reported to the owner, not hidden.
- **Timeouts:** `statement_timeout` default 120 s per statement [P]; `lock_timeout` 5 s. Either expiry gives exit 2.

## 8. Defaults to confirm [P] (not decisions; changeable at review)

| Default | Value |
|---|---|
| Stale-reservation threshold | 24 hours |
| Statement timeout | 120 s |
| Exit status on findings | `1` on any finding, warnings included |
| Runtime budget | 60 s for a 100k-fact organisation |
| Report time zone | UTC (no business-date logic in 7-7a) |

## 9. Delivery and evidence

- **PR:** one draft PR, **7-7a**, from `origin/develop` at authorisation; unmerged until owner review. No migration: the history proof is unchanged and re-verified on a fresh clone.
- **Before the PR:**
  - format, lint, typecheck, build, unit;
  - DB integration, API integration and security suites on a fresh clone;
  - the mutation checks;
  - full CI (5/5).
- **Evidence** (`~/acc-evidence/<date>-phase-7-7a-pr/`, SHA-256 manifest):
  - suite logs and the CI run id;
  - a sample human report and JSON report (clean and seeded-defect runs);
  - the `EXPLAIN` plans and runtime measurement;
  - mutation-check logs;
  - the read-only proof output (statement log, `transactionIdAssigned: false`, before/after counts);
  - a before/after function, policy and grant fingerprint showing no database change.
- **Documentation:** `DECISIONS.md` §1zi.16; the runbook section; `BILLING.md` §1 cross-reference to the command.

## 10. Coordination

- **Migrations:** no migration in this slice. `0060` is occupied on `develop` by PR #101. Gemini's uncommitted Phase 8A-2 work names `0060_phase8a_contact_import_export` and must coordinate its next number against current `develop`; nothing in 7-7a depends on or alters it.
- **Gemini:** Gemini's files are not touched.

Verify with a qualified professional before acting on any financial interpretation of reconciliation findings.
