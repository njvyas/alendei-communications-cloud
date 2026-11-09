# ACC Phase 7.4: Funds Reservation at Submission, Implementation Handover

**Status:** APPROVED by the owner, 09-Nov-2026 (D-74-1 to D-74-4, §17), and implemented as one draft PR. As-built facts and the deviations from this document are recorded in `DECISIONS.md` §1zi.7, which is binding where the two differ.

**Owner decisions (09-Nov-2026):**
- **D-74-1:** the five error mappings of §9 are adopted.
- **D-74-2:** missing and frozen accounts fail closed; no automatic account provisioning during submission.
- **D-74-3:** the extra per-attempt reservation belongs to 7.5, not 7.4. In 7.5, top up whenever the remaining reservation is less than the next attempt's price. The dispatcher is not modified in 7.4.
- **D-74-4:** enforcement defaults off. Startup refuses it outside tests until 7.5 is complete. Enabling it later requires account provisioning and funding, a readiness report and explicit owner approval.
**Date:** 09-Nov-2026
**Baseline inspected:** `develop` at `203edaa` (PR #92 merged). PRs #87, #88, #90, #91 and #92 are merged.
**Migration history on that commit:** `53|8b3f4018a42c3c46607b956d3dc7fdae` (`0000`–`0052`); PR #92 added no migration.

**Evidence markers:** **[V]** verified in the code or migrations at `203edaa`; **[I]** inferred, to be confirmed during implementation; **[P]** proposed by this handover.

**Owner direction for 7.4 (09-Nov-2026, binding):**
- **D-4:** `Idempotency-Key` is mandatory on `POST /messages` whenever billing reservation is enabled. The current optional-key behaviour is preserved while billing enforcement is disabled.
- Same-key/same-request replay, changed-request rejection and concurrent-request safety are mandatory.
- The 7.3 core stays the one submission path. Message creation is not duplicated, and there is no campaign-specific sending path.
- 7.4 and 7.5 stay separate. 7.4 does not implement settlement, invoices, refunds, operator money movement or campaign dispatch.

**Authority, in order of precedence:**
1. `DECISIONS.md` §1zi, the owner-approved Phase 7 decisions, in particular:
   - §1zi.1: OD-7-2 per-path lock order and the account-last rule; RQ-2; SMS billing units;
   - §1zi.3–§1zi.6: 7.1, 7.2 and 7.3 as built.
2. The Phase 7 consolidated baseline, Rev 3 (owner's evidence store), §§4, 6.1, 6.4, 7.2, 8.1 and 9.3.
3. `BILLING.md` §§5, 8 and 17; `DATABASE.md` §10.

---

## 1. Purpose and outcome

PR 7-4 makes every message created through `MessageSubmissionCore` hold funds before it can be dispatched, when billing enforcement is enabled. When enforcement is disabled, behaviour is unchanged from 7.3.

With enforcement **enabled**, in the same transaction that creates the message:
1. compute and persist the message's billable units;
2. rate the message with the 7.2 functions;
3. size the reservation from the organisation's billing policy;
4. lock the organisation's billing account, check available funds and post one `reservation` fact through the 7.1 writer.

Any failure rolls back the whole transaction, so no message, queue row, event, contact, evaluation, ledger fact or balance change survives.

With enforcement **disabled** (the default), the only change is that billable units are persisted on the new message row (§12). Nothing is rated, reserved or locked, and the HTTP contract is unchanged.

7.4 creates reservations only. **Nothing in 7.4 releases or consumes one.** Releasing and charging belong to 7.5 (§10), so enforcement must not be enabled in any shared environment before 7.5 is merged (§10.3, D-74-4).

---

## 2. Reconciliation of sources

### 2.1 Consistent
- §1zi.1 T0 order "billing account only, then new rows" fits the as-built writer, once the clarification in §5.2 is applied.
- §1zi.4: the writer serialises every posting for a message on the message row, then locks the account. The release amount is computed by the writer and is never supplied by the caller.
- §1zi.5: `app_rate_message` never re-rates. It fails closed with `BL007` (price) or `BL008` (provider cost).
- §1zi.6: the core runs only in the caller's transaction, under an authorization proof bound to that transaction.

### 2.2 Conflicts and gaps found (none is resolved silently)

| # | Finding | Evidence | Treatment |
|---|---|---|---|
| C-1 | The baseline T0 sequence locks the account **before** inserting the message. The as-built writer requires the message to exist first: it checks `messages`, has a foreign key to it, and locks the message row. `app_rate_message` also reads the message. | [V] `0050` `app_ledger_post` steps 2–3; `0051` `app_rate_message` | Inserts first, account last (§5.2). The account-last rule still holds, and the account stays the only lock T0 can wait on for billing. |
| C-2 | §1zi.1 gives the T2 extension order as "… → billing account → ledger, **then the new attempt row**". The writer refuses an attempt anchor unless the attempt row already exists, and a foreign key enforces the same. | [V] `0050` (`attempt does not belong to the message`; `usage_ledger_message_attempt_fkey`) | 7.5 must insert the attempt row **before** the account lock. This is still a new row, so the account-last rule holds. It is recorded here for 7.5; 7.4 does not touch T2. |
| C-3 | A keyed request already runs with `SET LOCAL lock_timeout = 3000` for its whole transaction. A contended account lock would therefore raise `55P03` inside `work`, where nothing translates it, so the client would get a `500`. | [V] `idempotency.service.ts` `execute`; `translateLockTimeout` wraps only the claim | The reservation step sets its own bound and maps `55P03` to `503 BILLING_BUSY` (§9). |
| C-4 | A message-subject rating passes no provider, so it uses only the channel-default rule. A provider-specific rule never affects the charge under `charge_per_logical_message`. A rate card that has only provider rules fails `BL007` for that policy. | [V] `0051` `app_price_lookup` (`r.provider_id IS NULL OR r.provider_id = p_provider_id` with a NULL provider) | This is the as-built 7.2 behaviour and is kept. It is recorded for owner awareness (§18, R-3), with a readiness check (§10.3). |
| C-5 | Under `charge_per_attempt`, each attempt is rated at T2 at the price **in force then**. If a new rate-card version raises the price after submission, a charge can exceed the reservation even with N or fewer attempts. RQ-2 as approved covers only attempts **beyond N**. | [V] `app_rate_message` uses `now()`; [I] effect at 7.5 settlement (`BL006`) | Owner decision D-74-3. |
| C-6 | The baseline places the reservation extension (RQ-2) in **7-5**. The owner's 7.4 brief asks this handover to cover it. | Baseline §8.1 | Specified here (§7.3); implementation placement is D-74-3. |
| C-7 | OD-7-7 (fail closed on a missing account or price) and OD-7-8 (HTTP error contract) are **not approved** in §1zi.2. The baseline gates both before 7-4. | §1zi.2 | The owner's brief settles fail-closed for missing pricing. D-74-1 and D-74-2 cover the rest. |
| C-8 | No path exists to create a billing account, record a recharge or set a credit limit. `recharge` is outside the writer's allowlist. With enforcement on, every organisation would therefore be refused (`BL001`, or `BL003` at zero balance). | [V] `0050` allowlist; no route or CLI | Enforcement cannot be used before account provisioning and funding exist (7.6). It is a prerequisite for enablement, not for 7.4 itself (§10.3, §16). |

---

## 3. Current state (verified on `203edaa`)

- **Submission [V]:**
  - The adapter is `MessagesService.sendMessage`. With a key it runs `IdempotencyService.execute` (claim → work → finalize in one transaction); without one, `withRequestTenant`.
  - `work` runs `authorizeSubmission` and then `MessageSubmissionCore.submit`.
  - The core's steps are:
    1. channel;
    2. workspace;
    3. address;
    4. suppression;
    5. contact (in a savepoint);
    6. consent;
    7. template;
    8. channel validation (SMS segments computed at core line ~456, with encoding `'GSM-7' | 'UCS-2'`);
    9. active assignment;
    10. insert into `messages`;
    11. enqueue;
    12. event.
  - T0 takes no advisory lock.
- **Ledger writer [V]:** `app_ledger_post(org, entry_type, anchor, amount, account 'wallet'|'credit', message, attempt, correlation, note)`.
  - SECURITY DEFINER; allowlist `reservation`, `reservation_release`, `customer_charge`, `provider_cost`.
  - Locks the message `FOR NO KEY UPDATE`, then the account `FOR UPDATE`.
  - An existing fact makes the call a no-op (`inserted = false`).
  - Available funds: wallet `balance − reserved`; credit `credit_limit − used − reserved`.
  - SQLSTATEs: `BL001` no account, `BL002` not active, `BL003` insufficient funds, `BL004` settled, `BL005` other account.
  - No application role may execute it.
- **Rating [V]:**
  - `app_rate_message(org, message, attempt NULL, units, with_customer, with_cost)` writes one evaluation per subject.
  - `app_price_lookup(...)` is read-only.
  - Both are SECURITY DEFINER; no application role may execute either.
- **Accounts [V]:**
  - `wallets` and `credit_accounts`: one of each per organisation at most; RLS on with no policy; no privileges for any application role.
  - The organisation's `billing_mode` (`prepaid`/`postpaid`) and `billing_policy` (`charge_per_logical_message` default / `charge_per_attempt`) can be changed only with `platform.tenants.manage` (`0025` guard).
- **Dispatcher candidates [V]:** active assignments for (org, channel), excluding providers already attempted for the message (`dispatcher.service.ts:405-420`). A message therefore makes at most one attempt per distinct actively assigned provider.

---

## 4. Target design

```
POST /messages adapter                       (campaign executor in 8B-3 uses the same core)
  ├─ enforcement on and no Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED (nothing runs)
  └─ IdempotencyService.execute: claim → work → finalize, one transaction
        work: authorizeSubmission → MessageSubmissionCore.submit(tx, ctx, request)
              steps 1–7 unchanged (all refusals precede money)
              8   insert messages   (+ billable units always; + billing snapshot when enforced)
              9   enqueue           (unchanged)
              10  message.queued    (unchanged)
              11  reserve           ← NEW, only when enforced: MessageReservation.reserve(tx, ctx, messageId)
                     └─ SELECT … FROM app_message_reserve(messageId)    (one SECURITY DEFINER entry point)
                           rate (app_rate_message / app_price_lookup) → size → app_ledger_post('reservation')
```

**Principles:**
- **One path.** Reservation is a step **inside** the core, so ordinary and campaign-originated messages reserve identically. No caller can create a message without it while enforcement is on.
- **Last step.** Reservation is the core's final step, so every existing refusal precedes it and the billing account is the last lock taken (§5).
- **One database entry point.** A new SECURITY DEFINER wrapper, `app_message_reserve`, is the only billing function `acc_app` may execute. It derives every input from the database:
  - organisation, channel and units from the message;
  - the account from the message's snapshot, checked against the organisation;
  - the amount from rating.

  The 7.1 writer and 7.2 rating functions are **not** granted to `acc_app` and **not altered** (§11).
- **Flag read once.** `BILLING_ENFORCEMENT_ENABLED` (default `false`) is read through `AppConfigService` once per submission and passed into the core, so one request never sees two values.

---

## 5. Transaction boundaries and lock ordering

### 5.1 Boundary
- One transaction per submission: the caller's, opened by `IdempotencyService.execute` or `withRequestTenant` on the HTTP path, and by the 8B-3 executor later.
- The core and the reservation step never open, commit or release a transaction. They may use no savepoint other than the existing contact savepoint.
- **No retry inside the transaction.** A `55P03`, `40P01` or `40001` aborts the request with `503 BILLING_BUSY`. The client retries with the same key, which is safe because only successes are stored.

### 5.2 Lock order for T0 (consistent with §1zi.1 "T0: billing account only, then new rows")

| # | Step | Locks taken | Can it wait? |
|---|---|---|---|
| 1 | Idempotency claim (keyed) | key-row unique index | Yes, on a same-key duplicate (existing behaviour; `409` after 3 s) |
| 2 | Contact savepoint | `contacts` / identity unique index | Yes, on a concurrent first send to the same new contact (existing) |
| 3 | Inserts: message, queue, event | new rows; `FOR KEY SHARE` on referenced org, workspace, channel, contact and template rows | No in practice [I]: nothing in the system takes `FOR UPDATE` or key-changing locks on those rows during sends |
| 4 | Rating (inside the wrapper): evaluation and component | new rows; `FOR KEY SHARE` on the plan version and rule | No [I]: activation is a non-key update and does not conflict with `KEY SHARE` |
| 5 | Writer: message row `FOR NO KEY UPDATE` | the transaction's **own uncommitted** row | No |
| 6 | Writer: billing account `FOR UPDATE` | **the only billing wait point** | Yes, bounded by the timeout in §5.3 |
| 7 | Writer: ledger fact, account update | new row; the locked account | No: the fact key is the new message's id |
| 8 | Idempotency finalize; COMMIT | own claimed key row | No |

**Rule check:** the account is the last row lock, and after it only new rows and the transaction's own rows are written. T0 therefore never waits on anything while holding an account. The dispatcher does not touch accounts in 7.4. No lock cycle can form; test CC-6 asserts this.

**Hold time:** an organisation's account lock is held from step 6 to COMMIT, so concurrent sends for one organisation serialise on it. This is the deliberate cost of reservation-not-check-then-act (`BILLING.md` §8). Load characterisation belongs to PR 7-8 (R-1).

### 5.3 Lock timeout [P]
- Immediately before step 6, the reservation step issues `SET LOCAL lock_timeout = '2000ms'` (a constant, not configuration). It overrides the 3 s idempotency bound for the remainder of the transaction, which only touches its own rows.
- `55P03`, `40P01` and `40001` raised from the wrapper are translated to `503 BILLING_BUSY` with `retryAfterSeconds` (§9). C-3 is closed.

---

## 6. Pricing integration (7.2, used unchanged)

- **Units (always persisted) [P]:**
  - **SMS:** `billable_units = analysis.segmentCount`, the value the core already computes after rendering and after the `maxSegments` check, with `sms_encoding` from the same analysis.
  - **WhatsApp and RCS:** `billable_units = 1`, with `billable_unit = 'message'`.
  - **Unit type:** derived from the channel's code in the core, and checked again in the wrapper against `app_pricing_unit_for_channel`. A mismatch is a programming error (`22023`).
  - The units are immutable after insert (§12).
  - Re-deriving them at dispatch is 7.5.
- **`charge_per_logical_message` [V function, P use]:**
  - The wrapper calls `app_rate_message(org, message, NULL, units, true, false)`. This records one message-subject evaluation (**E_m**) at the transaction time.
  - The reservation amount is `E_m.total_customer_price_paise`. 7.5 charges exactly this, so `BL006` cannot occur under this policy.
- **`charge_per_attempt` [P]:**
  - **No message-level evaluation** is recorded, because the charge is per attempt (E_a, rated in 7.5 at T2, once the provider is known).
  - The wrapper sizes the reservation with the read-only `app_price_lookup(org, channel, provider_i, units, now(), true, false)` for each distinct provider `i` with an active assignment for (org, channel). This is the dispatcher's candidate set before any attempt.
  - `N` = the number of those providers. Amount = `N × max_i(customer_price_paise_i)`, using each already-rounded per-transaction price (OD-P-1). No new rounding is introduced.
  - If any candidate is unpriced (`BL007`), the submission is refused. A provider the dispatcher may try must be priceable.
- **Provider cost is never computed at T0** (`with_cost = false`). `BL008` therefore cannot arise in 7.4. If it did, it would be treated as a programming error.
- **Zero price:** if the sized amount is 0, no reservation fact is posted (the writer refuses amounts ≤ 0; §1zi.5 assigns this rule to 7.4/7.5 callers), and the message proceeds. The evaluation (per-message policy) is still recorded.
- **Re-rating:** none. A replayed request runs no `work`. A second wrapper call for the same message returns the existing evaluation and the existing fact (`inserted = false`).

---

## 7. Available and reserved balance checks

### 7.1 At submission (7.4)
- The check is the writer's own, made under the account lock:
  - **Prepaid** (`wallets`): `balance − reserved ≥ amount`.
  - **Postpaid** (`credit_accounts`): `credit_limit − used − reserved ≥ amount`.

  Failure raises `BL003` → `402 BILLING_INSUFFICIENT_FUNDS`.
- The equality boundary succeeds: available equal to the amount is admitted.
- **The account comes from the message's snapshot** (§12): `prepaid` → wallet, `postpaid` → credit account.
  - The wrapper re-reads `organizations.billing_mode` and `billing_policy` and refuses a mismatch with the snapshot (`40001` class → `503 BILLING_BUSY`). A concurrent platform change of billing settings therefore cannot leave a message reserved under settings it was not sized for.
  - A missing account raises `BL001`; a frozen one `BL002`. Both fail closed (§9).
- **No balance, limit or price is disclosed** in any error body or log line at `info` or above. Only the code is returned.

### 7.2 Effect
- One `reservation` fact anchored on the message id, with `reserved += amount` on the selected account. `balance` and `used` are unchanged.
- One message has at most one submit-time reservation, enforced by the ledger's fact key.

### 7.3 Extra per-attempt reservation (RQ-2): specified here, implemented in T2
- **Approved trigger (§1zi.1):** under `charge_per_attempt`, before attempt N+1 or later is created, post a `reservation` fact anchored on the **new attempt id** under the account lock.
  - If funds are insufficient, the message terminates `failed` with a billing reason, and **no provider call** is made.
- **Sizing [P]:** the extension is `E_a` for the new attempt, recorded by `app_rate_message` with the attempt subject.
- **Order (C-2):**
  1. org advisory lock (shared);
  2. provider row (`admit`);
  3. message;
  4. insert the attempt row;
  5. rate E_a (new rows);
  6. billing account (writer);
  7. extension fact.

  The account is still the last lock.
- **Insufficient funds:** the extension's `BL003` must not abort the T2 transaction wholesale. T2 must be able to terminalise the message in the same transaction:
  - post the extension inside a savepoint, or pre-check under the account lock;
  - roll back to the savepoint, which also removes the attempt row;
  - mark the message `failed` with a billing reason (7.5 settles and releases it).
- **Price drift (C-5):** the approved trigger is attempt count only. D-74-3 asks whether to generalise it to "the outstanding reservation is less than this attempt's E_a", which covers both more attempts and a price rise.
- **Where it lives:** the extension is created in dispatcher T2 under `acc_dispatch`, in the same transaction as attempt creation. That is the dispatcher and the `acc_dispatch` writer branch, which the baseline assigns to 7-5. **Recommendation:** implement it in 7.5 with settlement (D-74-3). 7.4 only guarantees the submit-time N and the snapshot that 7.5 needs.

---

## 8. Idempotency and concurrency

### 8.1 D-4 implementation [P]
- **Enforcement on, no `Idempotency-Key`:** `400 IDEMPOTENCY_KEY_REQUIRED` ("This operation requires an Idempotency-Key header"), the existing code and message from 7.2.
  - It is raised in the adapter before any transaction, so nothing runs and nothing is audited.
  - This follows the `executePlatform` precedent: the key check precedes the permission check.
- **Enforcement off:** unchanged. The key is optional; unkeyed requests create a new message each time, as characterised in 7.3.
- **The key format check is unchanged:** 16–255 characters, otherwise `400 IDEMPOTENCY_KEY_INVALID`.

### 8.2 Guarantees (keyed path, all mandatory)

| Case | Guarantee | Mechanism |
|---|---|---|
| Same key, same request, after success | Stored `202` body replayed; no new message, evaluation, fact or balance change | Claim finds a completed record; `work` is not run; `authorize` is re-run first (existing) |
| Same key, different request | `422` "This Idempotency-Key was already used for a different request"; nothing created | Unchanged fingerprint of the five-field body, method, route and principal |
| Same key, concurrent | Exactly one message and one reservation; others replay, or get `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` after 3 s | Key unique index serialises (existing) |
| Same key, after a refusal (`402`, `422`, `503`) | The refusal is not stored; a retry runs fresh (for example, after a top-up) | Only successes are stored (existing); the whole transaction rolls back |
| Key used while enforcement was off, replayed after it is turned on | Replays the original response; no reservation; the message stays `billing_enforced = false` | Replay runs no `work`; the fingerprint is unchanged by 7.4 |

- **The fingerprint is unchanged by 7.4.** The enforcement flag is not part of it, so keys survive a flag change. The existing equality pin from 7.3 stays green.

### 8.3 Concurrency (distinct requests)
- **Overspend:** M concurrent submissions for one organisation whose funds cover exactly k reserve exactly k; M − k receive `402`; `reserved` rises by exactly k × amount (baseline F-4). The guarantee comes from the writer's account `FOR UPDATE` and its check-under-lock.
- **Isolation:** two organisations never wait on each other's account.
- **Contact race:** concurrent first sends to one new contact still produce one contact (characterised in 7.3); each message reserves independently.

### 8.4 Campaign-originated messages (8B-3, recorded only)
The reservation is per message and anchored on the message id. A duplicate message for one campaign recipient would therefore reserve twice. The 8B-3 blocker "database-level protection against duplicate messages for one campaign recipient" (§1zi.6) is the campaign path's idempotency equivalent of D-4, and must exist before campaign execution reserves funds. 7.4 adds nothing campaign-specific.

---

## 9. Fail-closed behaviour and error contract

All billing refusals occur after every existing check. This preserves 7.3 precedence: a message that is both suppressed and unfunded gets the suppression error.

| Condition | SQLSTATE | HTTP [P, D-74-1] | Code [P] |
|---|---|---|---|
| Enforcement on, no key | n/a | 400 | `IDEMPOTENCY_KEY_REQUIRED` (existing) |
| No assignment, active version or rule (any candidate, per policy) | `BL007` | 422 | `BILLING_PRICE_NOT_CONFIGURED` |
| No account of the organisation's mode | `BL001` | 422 | `BILLING_ACCOUNT_NOT_CONFIGURED` |
| Account frozen | `BL002` | 403 | `BILLING_ACCOUNT_FROZEN` |
| Insufficient available funds | `BL003` | 402 | `BILLING_INSUFFICIENT_FUNDS` |
| Account lock timeout, deadlock, serialization, or snapshot/organisation mismatch | `55P03`, `40P01`, `40001` | 503 | `BILLING_BUSY` (`retryAfterSeconds`) |
| `BL000`, `BL004`, `BL005`, `BL008`, `22023` | — | 500 | Not mapped: these are programming errors, logged with the message id and never shown to the client |

- **Fail closed everywhere:** no default price, no zero-price fallback for a missing rule, no "reserve later", and no send without a reservation while enforcement is on.
- The baseline proposed `402`, `422` and `503` (OD-7-8, not yet approved). The `BL001` and `BL002` rows are additions.
- **Contract work in the PR:**
  - add the codes to `ERROR_CODES` (`@acc/contracts`);
  - OpenAPI: `POST /messages` documents `402`, `403` (frozen), `422` (billing), `503`, and the conditional key requirement;
  - a contract note for the web owner. `apps/web` is not changed.

---

## 10. Release and failure paths: 7.4 versus 7.5

### 10.1 Within 7.4
- **Any failure after reservation** (caller error, finalize failure, crash, lock timeout): the transaction rolls back, and the reservation fact and `reserved` change disappear with the message. This is the only "release" 7.4 needs, and it is atomic. Tests RF-1 to RF-3.
- **Refusal before reservation:** nothing was posted.
- **Replay:** nothing is posted.

### 10.2 Owned by 7.5 (not implemented in 7.4)
- `reservation_release`, `customer_charge` and `provider_cost` at the dispatcher's terminal sites (baseline §6.2), including outcome-unknown under OD-7-4U.
- The `acc_dispatch` writer branch and grants; the fence `FOR UPDATE`; the recording split; the T3-only retry; per-lease recovery.
- RQ-2 extensions (recommended, D-74-3).
- Re-deriving units at dispatch and snapshotting them on attempts.
- **Settlement contract that 7.4 fixes for 7.5:**
  - settle according to the **message's** `billing_enforced` and snapshot, **never the current flag**;
  - a message with `billing_enforced = false` (created while enforcement was off, including messages still queued at enablement) is not billed by settlement, unless the owner decides otherwise before 7.5.

**Responsibility split:**

| Concern | 7.4 | 7.5 |
|---|---|---|
| Units at submit, billing snapshot | ✔ | reads them |
| E_m rating (per-message policy) | ✔ | charges E_m |
| Submit-time reservation (both policies) | ✔ | releases the remainder |
| RQ-2 extension at T2 | specified | ✔ (recommended) |
| E_a rating, provider cost, customer charge, release | — | ✔ |
| Dispatcher code or `acc_dispatch` grants | untouched | ✔ |
| Refunds, adjustments, recharge, invoices | — | — (7.6/7.7) |

### 10.3 Enablement safety [P, D-74-4]
In 7.4, an enforced message's reservation is **never released**, because settlement does not exist yet. Enabling enforcement against real traffic before 7.5 would hold funds indefinitely, and correcting that needs operator money movement that is not authorised. Therefore:
- **Startup guard:** in 7.4, the API refuses to start with `BILLING_ENFORCEMENT_ENABLED=true` unless `NODE_ENV=test`. 7.5 removes the guard.
- **Enablement prerequisites** (none in 7.4; listed so they are not assumed):
  1. 7.5 merged;
  2. an account-provisioning path and funding (recharge, credit limit), which is 7.6 under RQ-3;
  3. a readiness report showing every active organisation has an account of its mode, and a priceable channel default (per-message policy) or priced candidate providers (per-attempt policy);
  4. owner approval.

---

## 11. Security, tenant isolation, permissions and database privileges

- **No new permission.** Reservation is a consequence of `messages.send`, which is already asserted and bound by the 7.3 proof.
  - `billing.*` and `pricing.*` stay inert (`INERT_PERMISSION_KEYS`).
  - API-key and user-session principals reserve identically.
- **One new SECURITY DEFINER function [P]:** `app_message_reserve(p_message_id uuid) RETURNS TABLE (reserved_paise bigint, inserted boolean, evaluation_id uuid)`.
  - **Caller check first** (the `0049` pattern). Refuse with `42501` unless:
    - `current_user`/`session_user` is `acc_app`;
    - `app_content_context_valid()` holds (an org-level user or an API key);
    - the message's `org_id = app_current_org_id()`.
  - **Then:**
    - the message must have `billing_enforced = true` and a complete snapshot;
    - the snapshot must equal the organisation's current billing settings;
    - the unit must match the channel.
  - **Only this fact:** it posts only `reservation`, anchored on the message, with no attempt and an amount it computed. There is no amount, account, org or entry-type argument.
  - **Invariant D holds:** no dynamic SQL, `ALTER`, `set_config` or `SET ROLE`. `search_path` is pinned.
  - **Grants:** `REVOKE ALL FROM PUBLIC`; `GRANT EXECUTE TO acc_app` only. It is not granted to `acc_dispatch`, `acc_auth`, `acc_delivery` or any other role.
- **7.1 and 7.2 objects are unchanged:**
  - `app_ledger_post`, `app_rate_message` and `app_price_lookup` gain no grant and no new branch;
  - financial tables gain no policy or privilege;
  - `acc_app` still cannot read wallets, the ledger or evaluations.
- **Tenant isolation:**
  - the wrapper never takes an organisation from its caller;
  - the ledger and evaluation foreign keys are composite with `org_id` (existing);
  - a cross-tenant message id is refused before any read of money.
- **Audit:** no new audit action. Reservation is not a security-sensitive operator action, and the ledger fact is the record. Sensitive audit applies to 7.6 money movement.
- **Logging and metrics:** no amounts in logs at `info` or above. One counter `acc_billing_reservations_total{outcome}` [P], with bounded labels `reserved`, `zero_price`, `insufficient_funds`, `price_not_configured`, `account_unavailable`, `busy`. No organisation label.

---

## 12. Migration `0053` (expand-only) [P]

**`messages` columns:**

| Column | Type | Rule |
|---|---|---|
| `billable_units` | `integer NULL` | Set on every new row; `CHECK (billable_units BETWEEN 1 AND 1000000)`; NULL only on pre-`0053` rows |
| `billable_unit` | `pricing_unit NULL` | Set with `billable_units` (both or neither) |
| `sms_encoding` | `text NULL` | `'GSM-7'` or `'UCS-2'`; non-NULL only for SMS |
| `billing_enforced` | `boolean NOT NULL DEFAULT false` | True iff the submission ran the reservation step (metadata-only add) |
| `billing_mode_snapshot` | `billing_mode NULL` | Non-NULL iff `billing_enforced` |
| `billing_policy_snapshot` | `billing_policy NULL` | Non-NULL iff `billing_enforced` |

- **Immutability:** a `BEFORE UPDATE` trigger refuses any change to these six columns. The dispatcher's status updates are unaffected.
- **Grants:** the INSERT privilege of `acc_app` covers the new columns [I: verify whether `messages` uses column-level grants; extend them if so]. `acc_dispatch` gets no UPDATE on them.
- **Function:** `app_message_reserve` (§11) and its grant.
- **Not added:**
  - attempt units, which arrive with 7.5;
  - a ledger `pricing_evaluation_id`, which waits for a stage that needs it (DP-4);
  - any change to `organizations`, accounts, ledger or pricing objects, or to the `0045` index guard (no new foreign key).
- **History:** `54|<hash>`, computed on a disposable clone and recorded in `RELEASE.md` in the PR.
- **Naming deviation:** the baseline names a single `billing_snapshot`. Typed columns are proposed instead, so the database can check them.

---

## 13. Proposed PR scope (PR 7-4, one draft PR)

### 13.1 In scope
1. **Migration `0053` (§12).**
2. **`MessageReservation` service** in `apps/api/src/billing/`. It is the only TypeScript caller of `app_message_reserve`; it handles the lock timeout and error mapping.
3. **Core:**
   - a new final step `// 11. Reserve funds`, run only when enforced;
   - units and snapshot on the insert;
   - the core reads the organisation's billing settings only when enforced;
   - `SubmissionContext` gains `billingEnforced: boolean`, set by the caller from configuration. The request types are unchanged.
4. **Adapter:** the D-4 key check (§8.1).
5. **Configuration:** `BILLING_ENFORCEMENT_ENABLED` (default `false`) and the 7.4 startup guard (§10.3).
6. **Contracts:** error codes and OpenAPI (§9).
7. **Structural tests updated deliberately (§14.5).**
8. **Documentation:**
   - `DECISIONS.md` §1zi.7 (as built, deviations);
   - this handover, with its approval status;
   - `RELEASE.md` `0053` proof;
   - a `BILLING.md` §8 note on as-built T0 ordering. This is limited to 7.4 facts.

### 13.2 Out of scope (explicit)
- Settlement, release or charge facts; any dispatcher change; RQ-2 extension (unless D-74-3 places it in 7.4).
- `acc_dispatch` grants; refunds, adjustments, recharges, invoices, payments; account provisioning; billing APIs (`/wallets`, `/billing`).
- Reconciliation tooling; campaign execution or any campaign field.
- `apps/web`; QA or production deployment; enabling enforcement anywhere except test clones.

### 13.3 Size estimate [I]
About 250 lines of SQL, about 400 lines of TypeScript and about 1,200 lines of tests.

---

## 14. Required tests

All database tests run through `scripts/with-db-clone.mjs` on `acc_r015_base` clones.

### 14.1 Regression (existing, unchanged, green)
- **R-1:** `message-submission-parity.int-spec.ts` (40 tests), **byte-identical**, with enforcement off.
- **R-2:** 7.1 ledger and 7.2 pricing integration suites, unchanged.
- **R-3:** tenant-context trust suite (invariant D), ADR-015 permission and table-class censuses, and the security suite.
- **R-4:** full CI: lint, typecheck, build, OpenAPI drift (with a deliberate, reviewed diff), DB, API and security suites.

### 14.2 Integration, enforcement on (new)

| ID | Case | Expected |
|---|---|---|
| IN-1 | Prepaid, per-message policy, funded | `202`; one evaluation (E_m); one `reservation` fact equal to E_m; `reserved += E_m`; balance unchanged; units and snapshot stored |
| IN-2 | Postpaid, same | As IN-1, on the credit account |
| IN-3 | SMS units golden set (GSM-7, extended characters, UCS-2, surrogate boundary, multipart) | `billable_units` = segment count; encoding stored; E_m = rate × units, rounded once |
| IN-4 | Available equal to the amount / one paisa less | Success / `402`, with no rows in any of the nine tables and balances unchanged |
| IN-5 | Missing assignment; no active version; no channel rule | `422 BILLING_PRICE_NOT_CONFIGURED`; nothing persisted |
| IN-6 | No account of the mode; frozen account; only the other mode's account | `BILLING_ACCOUNT_NOT_CONFIGURED`, `BILLING_ACCOUNT_FROZEN`, and `BILLING_ACCOUNT_NOT_CONFIGURED`; nothing persisted |
| IN-7 | Per-attempt policy, 3 providers with distinct rules | Reservation = 3 × max price; no message evaluation |
| IN-8 | Per-attempt policy, one candidate unpriced | `422`; nothing persisted |
| IN-9 | Zero price | `202`; evaluation recorded; no fact; `reserved` unchanged |
| IN-10 | Precedence: suppressed or invalid payload and unfunded | Existing 7.3 refusal, not a billing error |
| IN-11 | API-key principal | Reserves as for a user |
| IN-12 | Enforcement off | No evaluation, fact or account access; units stored; `billing_enforced = false` |

### 14.3 Idempotency (new, mandatory)

| ID | Case | Expected |
|---|---|---|
| ID-1 | On, no key | `400 IDEMPOTENCY_KEY_REQUIRED`; no row anywhere, including the key table |
| ID-2 | Replay of the same key and body | Same response; one message, one fact; balance unchanged |
| ID-3 | Same key, changed body | `422`; no second message or fact |
| ID-4 | 8 concurrent, same key | One message, one fact; the rest replay or `409` |
| ID-5 | `402` then top-up (test setup) then retry with the same key | Second attempt succeeds once |
| ID-6 | Key created with enforcement off, replayed with it on | Original replay; no reservation |
| ID-7 | Off, no key | Unchanged (two sends, two messages) |

### 14.4 Concurrency (new)

| ID | Case | Expected |
|---|---|---|
| CC-1 | 20 concurrent distinct sends, funds for exactly 7 | Exactly 7 `202`, 13 `402`; `reserved` = 7 × E_m; ledger sum equals materialised `reserved` |
| CC-2 | Account lock held by a test session longer than 2 s | `503 BILLING_BUSY`; nothing persisted; key free for retry |
| CC-3 | Concurrent sends for orgs A and B while A's account is held | B completes without waiting |
| CC-4 | Concurrent platform change of `billing_mode` during a send | Either sized under the new mode, or `503`; never a reservation on the wrong account |
| CC-5 | 6 concurrent first sends to one new contact, enforced | 1 contact; 6 messages; 6 facts |
| CC-6 | Sends interleaved with dispatcher cycles (T2/T3) on the same org | No `40P01`; dispatcher behaviour unchanged |

### 14.5 Database and migration (new)
- **DB-1:** `0053` applies twice cleanly ("54 migrations verified"); the proof is recorded.
- **DB-2:** pre-existing message rows have `billing_enforced = false` and NULL units.
- **DB-3:** immutability: an UPDATE of each new column by `acc_app` and `acc_dispatch` is refused.
- **DB-4:** wrapper caller checks:
  - another org's message → `42501`;
  - no user or key in context → `42501`;
  - `acc_dispatch` (no grant) → `42501`;
  - a non-enforced message → refused;
  - a snapshot mismatch → refused;
  - a second call → `inserted = false`, with no balance change.
- **DB-5:** ACL census:
  - `app_message_reserve` is executable by `acc_app` only;
  - `app_ledger_post`, `app_rate_message` and `app_price_lookup` are still executable by no application role;
  - financial tables still have no application privilege.
- **DB-6:** invariant D over the new function (no dynamic SQL, `ALTER`, `set_config` or `SET ROLE`).
- **DB-7:** writer rollback: an error injected after the fact insert leaves neither the fact nor the balance change (baseline F-8, re-run through the wrapper).

### 14.6 Rollback and failure (new)
- **RF-1:** caller throws after `submit` (enforced) → no message, evaluation, fact or `reserved` change.
- **RF-2:** idempotency finalize fails → the same.
- **RF-3:** a connection is terminated mid-transaction → the same.

### 14.7 Structural (updated deliberately and reviewed)
- **ST-1:** `message-submission.architecture.spec.ts`:
  - the core's only billing reference is the `MessageReservation` import;
  - `app_ledger_post`, `app_rate_message`, `app_price_lookup`, `customer_charge`, `reservation_release` and `provider_cost` are still absent from the core;
  - the step order gains `// 11. Reserve funds` after `// 10.`.
- **ST-2:** `app_message_reserve` is named in exactly one `apps/api/src` file. `app_ledger_post`, `app_rate_message` and `app_price_lookup` are named in none.
- **ST-3:** `apps/api/src/messages/dispatch/**` is unchanged by the PR (diff check in review, plus a test that no dispatch file references the reservation service).
- **ST-4:** the scope-creep vocabulary allowlist is updated only for the new files.
- **ST-5:** the startup guard refuses `true` outside `NODE_ENV=test`.

---

## 15. Acceptance criteria (PR 7-4)
1. **Regression:** every test in §14.1 passes, and the parity suite is byte-identical.
2. **New suites:**
   - every test in §14.2 to §14.7 passes;
   - CC-1 shows no overspend in 5 consecutive runs;
   - ID-4 shows exactly one fact in 5 consecutive runs.
3. **Enforcement off:** the HTTP contract and behaviour are unchanged, apart from persisted units.
4. **Enforcement on:**
   - every created message has exactly one reservation fact, or a zero-price evaluation and none;
   - every refused submission persists nothing.
5. **Database integrity:**
   - after every suite, the materialised `reserved` equals the ledger's open-reservation sum for each test organisation;
   - no 7.1 or 7.2 object is altered (`pg_get_functiondef` and ACL equality against `203edaa`);
   - `0053` is expand-only.
6. **Scope and environment:** no settlement fact kind is posted anywhere; the dispatcher is untouched; enforcement cannot start outside tests.
7. **CI:** all five checks green. The PR stays draft and unmerged until owner review. There is no QA or production activity.

---

## 16. Dependencies

| Dependency | State | Needed for |
|---|---|---|
| 7.1 writer, accounts, partitions (`0050`) | Merged `ab1f2dd` | 7.4 |
| 7.2 rating (`0051`) | Merged `e3518ba` | 7.4 |
| 7.3 core (#92) | Merged `203edaa` | 7.4 |
| D-74-1, D-74-2 (error contract, fail-closed accounts) | **Open** | Before 7.4 implementation |
| D-74-3 (RQ-2 placement and trigger) | **Open** | Before 7.4 (placement); before 7.5 (trigger) |
| D-74-4 (startup guard) | **Open** | Before 7.4 implementation |
| 7.5 settlement | Not started | Before enforcement is enabled anywhere |
| Account provisioning and funding (7.6, RQ-3) | Not started | Before enforcement is enabled anywhere |
| 8B-3 blockers (§1zi.6), D-5 | Open | Before campaign messages reserve |

---

## 17. Decisions requiring owner approval

- **D-74-1: error contract (OD-7-8).** Approve the mapping in §9:
  - `402 BILLING_INSUFFICIENT_FUNDS`;
  - `422 BILLING_PRICE_NOT_CONFIGURED`;
  - `503 BILLING_BUSY` (retryable);
  - new: `422 BILLING_ACCOUNT_NOT_CONFIGURED` and `403 BILLING_ACCOUNT_FROZEN`.

  *Recommendation:* approve as listed.
- **D-74-2: fail closed on a missing or frozen account (OD-7-7, account half).** Your direction settles missing pricing. *Recommendation:* the same for accounts, with no automatic account creation at submission. Account provisioning stays with 7.6.
- **D-74-3: RQ-2 extension.**
  - **(a) Placement.** *Recommendation:* implement in 7.5, in dispatcher T2 alongside the `acc_dispatch` writer branch, as the baseline plans; 7.4 specifies it (§7.3).
  - **(b) Trigger.** Price drift between submission and attempt (C-5) can exceed the reservation. *Recommendation:* generalise the approved trigger to "before creating an attempt, extend by E_a − outstanding when the outstanding reservation is less than E_a". This covers both extra attempts and a price rise; insufficient funds still means no provider call. Needed before 7.5, not before 7.4.
- **D-74-4: enablement guard.** *Recommendation:* in 7.4 the API refuses to start with enforcement on outside `NODE_ENV=test`, and 7.5 removes the guard. Enablement in any environment then needs 7.5, provisioning and funding, a readiness report and your approval (§10.3).

**Not requested now, but listed so none is assumed:**
- **Billing of messages created while enforcement was off and settled after enablement:** recommended "not billed" (§10.2). This is a 7.5 decision.
- **Changing `billing_mode` while reservations are open:** CC-4 covers submission. Settlement follows the snapshot, and the writer refuses another account (`BL005`). Whether to block such changes is a 7.5/7.6 decision.
- **Enforcement scope:** the flag is deployment-wide; per-organisation rollout is not provided.

---

## 18. Risks

- **R-1: hot-account serialisation.** All sends for one organisation serialise on its account row from reservation to COMMIT. Reservation as the last step keeps the hold short. Throughput limits are measured in 7-8 (baseline load test). [I]
- **R-2: reservations never released before 7.5.** Mitigated by D-74-4 and the startup guard.
- **R-3: per-message pricing ignores provider rules (C-4).** As built in 7.2. A provider-only rate card is refused (`422`) under the default policy. The readiness report must check channel defaults.
- **R-4: per-attempt over-reservation.** N × max price can hold more than the eventual charges. This is conservative by design; 7.5 releases the remainder.
- **R-5: contract change.** New error responses on `POST /messages` affect clients only when enforcement is on. The web owner receives a contract note.

Verify with a qualified professional before acting on the financial-control aspects of this design.
