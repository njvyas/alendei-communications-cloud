# QA-F-07 Test Procedure: Provider Circuit Breaker Tripping and In-Memory Short-Circuiting

> **Executed and accepted.** This is the procedure that ran on 31-Oct-2026 (run `edb1bc78-9b97-4b02-8c29-b074f3cef2e5`; owner acceptance `DECISIONS.md` §1zc.2; record `QA_RELEASE_PREPARATION.md` §5h). Driver: `scripts/qa/f07-v223.sh` (identical to the executed copy). Version history: v2.1 (30-Oct-2026 draft, never executed) → v2.2 (corrections) → v2.2.1 (C3b informational) → v2.2.2 (dedicated provider) → v2.2.3 (independent-review corrections). Earlier versions and their diffs are in the evidence package, outside Git.

**Document version:** 2.2.3 (v2.2.2 plus the independent-review corrections from Gemini, ACCEPT WITH SPECIFIC CORRECTIONS; 31-Oct-2026)
**Date:** 31-Oct-2026
**Status:** Prepared for owner review. Execution requires separate owner authorization.
**Target release:** `2026.10.24-441a29a` (code commit `554dea3`, an ancestor of `441a29a`)
**Scope:** Internal QA host; organization `qa-org-a2` (`01a16d1b-a2da-72bd-8124-3c4b4471b9d5`); channel WhatsApp (`01a162ed-3614-70ea-9f43-d17ab6e7cfd9`); provider **`QA Sim 500 F07`** (id: see §0a); template `qa_f07_circuit_test` (`01a1907a-e323-740e-9fc1-15ca1d1d01a8`, simulator-approved)
**Driver:** `f07-v223.sh` (same folder). Every subcommand requires `F07_PROVIDER_ID` and stops unless that id belongs to the provider named `F07_PROVIDER_NAME` (default `QA Sim 500 F07`). `preflight` and `run` also require `F07_TEMPLATE_ID`. Subcommands: `preflight` (read-only), `run <BASELINE_GEN>` (owner-gated), `verify <RUN_DIR>` (read-only), `routing-check` (read-only restoration proof)

The objective and the timing parameters are unchanged from v2.1 §1–§2. Everything below corrects or replaces v2.1 §3–§8.

---

## 0a. Dedicated provider and temporary routing (v2.2.2)

- **Why a dedicated provider:** the original `QA Sim 500` circuit has been `open` (generation 9) since 26-Oct-2026, and the application has no supported way to close it. `QA Sim 500 F07` was created through the supported provider API: simulator adapter, `simulator_behavior "500"`, starting `closed`, generation 0, `healthy`. Expected `BASELINE_GEN` is therefore **0**.
- **Template approval:** the template's `approved` status is a QA simulator approval only (`simulate-approval`). It is not external WhatsApp or Meta approval.
- **Temporary routing for the test window** (owner-approved). QA Sim 500 F07 is the only active qa-org-a2 WhatsApp assignment:

| Assignment | Priority | Original status | Test window |
|---|---|---|---|
| `01a16d33-6c0a-7b7d-9630-92caa633a804` (QA Sim 500) | 1 | active | disabled |
| `01a16d33-951a-7950-bc66-4145bee7b879` (QA Sim OK) | 2 | active | disabled |
| QA Sim 500 F07 assignment (id recorded at setup) | 4 | disabled (created) | active |
| `01a17683-59d1-7db5-bb49-38b62445cc8b` (QA Sim Timeout) | 3 | disabled | unchanged |
| `01a17685-7fc7-75a8-bdbb-b171902fc902` (QA Sim 429) | 11 | disabled | unchanged |

- **Restoration after the test** (platform admin, `POST /api/v1/organizations/01a16d1b-a2da-72bd-8124-3c4b4471b9d5/provider-assignments/<id>/…`). Afterwards `f07-v223.sh routing-check` must report `RESTORED` for every row:
  1. `…/01a16d33-6c0a-7b7d-9630-92caa633a804/enable`
  2. `…/01a16d33-951a-7950-bc66-4145bee7b879/enable`
  3. `…/<F07 assignment id>/disable`

  Priorities are kept on disabled rows, so the original order returns exactly. Then verify the assignment fingerprint against the pre-setup baseline.

## 0. Changes from v2.1

| v2.1 finding | v2.2 correction |
|---|---|
| B2: SQL ran as `psql -U acc_app` (a NOLOGIN, RLS-bound role); every query is refused | All SQL runs as `postgres` inside a read-only transaction (`PGOPTIONS=-c default_transaction_read_only=on`), the method approved for the D-08 client |
| B3: non-UUID `TEST_RUN_ID` used as `X-Correlation-ID`; the API replaces it, so the 5.1 filter matches 0 rows | `TEST_RUN_ID` is a random UUID. The driver stops before message 2 unless the API echoes it as `correlationId`. Test messages are selected by `org_id`, `correlation_id` **and** `payload.testRunId` |
| B4: header `X-Idempotency-Key` is ignored | Header `Idempotency-Key: <TEST_RUN_ID>-msg-<n>`, which matches `^[A-Za-z0-9_.:-]{16,255}$` |
| B5: Step 3.3 checked only priority 1 | Precondition P4: QA Sim 500 must be the **only** active qa-org-a2 WhatsApp assignment. Otherwise STOP; provider configuration is never changed |
| B6: provider calls counted by grepping a string that is never logged | Calls are counted from `message_attempts`: one row per executor invocation (§6.2). The log is used only as corroboration |
| B7: `docker compose logs --since` is unreliable on QA | `verify` first reads each log with `--since` (window start minus 120 s). If both bracket markers are not present, it falls back to `--tail 20000` and records the method used (`v0-log-method.txt`). The run-window filter is applied in both cases. Coverage is proven by the bracket markers (§4.3); without them the log criteria are NOT PROVEN |
| New (safeguard 3): `dispatchBatch` processes a claimed batch concurrently (`Promise.allSettled`, up to 10) | The driver submits one message at a time and waits until it is terminal before submitting the next (§4.2). Validity is checked by timing guard C0 |
| New: v2.1 globally required zero `outcome_unknown` and zero queue rows | Criteria are scoped to the run's messages. Global counts are recorded as information. Unrelated QA traffic is excluded, and its presence in the window is reported |

---

## 1. Access and credentials

- **Host access:** only through the operator's SSH control socket `~/.ssh/cm-acc-qa`, which the operator opens in their own terminal. The driver never opens a new connection (`ControlMaster=no`, `ProxyCommand=/bin/false`, `BatchMode=yes`). If the socket is missing or dead, the driver stops before any request.
- **API:** QA loopback `http://127.0.0.1:3001/api/v1`, reached on the host with `curl -K -`. Tokens and bodies are passed on stdin, never as process arguments.
- **Test identity:** `qa-org-a2-admin`, from `~/acc-qa-test-creds/qa-org-a2-admin.env` (mode 600). The file is parsed, never sourced or printed. It is used only by `run`.

## 2. Read-only preflight (`f07-v223.sh preflight`)

Every precondition must PASS before `run` is authorized. A precondition that fails means STOP and report.

| ID | Check | PASS when |
|---|---|---|
| P1 | Running images, `ACC_VERSION`, `org.opencontainers.image.revision` labels | `ACC_VERSION=2026.10.24-441a29a`; the api and web revision labels resolve to `441a29a`; containers running and healthy |
| P2 | Migration fingerprint `count(*), md5(string_agg(hash:created_at))` | `38 \| 04b0fac738f24476e76b88a84fd04850` |
| P3 | `qa-org-a2` exists | Exactly 1 row, status `active` |
| P4 | qa-org-a2 WhatsApp assignments | QA Sim 500 F07 (`F07_PROVIDER_ID`) is `active` and the **count of other active assignments is 0** |
| P5 | QA Sim 500 F07 state (scoped by id) | Exactly 1 row: provider `active`, `circuit_state = closed`, `health_state = healthy`. Record `circuit_generation` as `BASELINE_GEN` (expected 0) |
| P5b | QA Sim 500 F07 simulator capability | Capability `simulator_behavior` = `"500"` |
| P5c | Platform circuit policy | `window_ms 60000`, `min_samples 5`, `failure_percent 50`, `cooldown_ms 30000`, `half_open_max_probes 1`, `half_open_successes_to_close 2` |
| P6 | Dispatch queue rows; `submitting` attempts; messages `queued`, `routing` or `submitting` | All 0 |
| P7 | QA Sim 500 F07 activity in the last 10 minutes: attempts, plus audit rows `provider.test_sent`, `provider.health_checked`, `provider.circuit_changed`, `provider.health_changed` | All 0. A test-send also feeds circuit and health samples, and prior samples would move the trip point. Re-check immediately before `run` |
| P8 | An approved qa-org-a2 WhatsApp template | At least 1 |
| P8b | The exact `F07_TEMPLATE_ID` (gate, also enforced by `run`) | Template organization `qa-org-a2`, channel `whatsapp`, `approved`, not deleted |
| P9 | Active suppressions for `+12025550301`–`+12025550310` in qa-org-a2 | 0 |
| P10 | Dispatch worker | Exactly one running container from the api image. Its most recent start line reads `message dispatch started` (batch size and poll interval recorded), not `is disabled`. Earlier start lines from container restarts are expected. The `web` container does not run the dispatcher |
| P11 | Log retrieval | A 404 probe carrying a UUID correlation id is found in the api log, and a failing read-only marker query is found in the postgres log, by the `--tail` method. The `--since` result is recorded for comparison only |
| P4c | Sole-active routing (gate, also enforced by `run`) | Active `F07_PROVIDER_ID` assignments = 1, other active qa-org-a2 WhatsApp assignments = 0 |

## 3. Request validation (safeguard 4, verified in code at `441a29a`)

- **DTO:** `channelCode` is a string of 1–50 characters; `recipient` is 3–100 characters; `templateId` is an optional UUID; `payload` is any object.
- **WhatsApp:** the service validates payloads only for `sms` (`messages.service.ts:361`) and `rcs` (`:542`). A WhatsApp payload, including `text`, `testRunId` and `sequence`, is stored as sent.
- **Template:** `templateId` must belong to qa-org-a2, match the WhatsApp channel and be `approved`. Otherwise the API returns 404 or 422 and the driver stops.
- **Recipients:** must be E.164. Contacts are created automatically; only *revoked* consent blocks a send (P9 covers suppressions).
- **Responses:** `POST /messages` returns HTTP 202 with `{data:{id,status:"queued",correlationId,...}}`. `GET /messages/{id}` returns `status`, `failureReason` and `attempts[]`.

## 4. Execution (`F07_EXECUTE_AUTHORIZED=yes F07_PROVIDER_ID=<id> F07_TEMPLATE_ID=<id> f07-v223.sh run <BASELINE_GEN>`)

### 4.1 Start
**Pre-run gates** (any failure means STOP, with nothing submitted): provider name matches; template exact (P8b); sole active (P4c); provider `active`, `closed`, generation `BASELINE_GEN`, `healthy`; dispatch queue 0. Routing is recorded before message 1 and again after message 10.

The driver generates `TEST_RUN_ID` (a UUID), logs in, records `test-start-utc`, and emits the start markers (§4.3).

### 4.2 Gated sequential submission (safeguard 3)
For n = 1..10:
1. POST the message: recipient `+120255503nn`, `Idempotency-Key: <TEST_RUN_ID>-msg-n`, `X-Correlation-ID: <TEST_RUN_ID>`, payload `{text, testRunId, sequence:n}`.
2. **STOP** if the response is not HTTP 202, has no UUID id, or has a `correlationId` other than `TEST_RUN_ID`.
3. Poll `GET /messages/{id}` every 0.2 s for up to 15 s, until the status is terminal (`failed`, `accepted` or `outcome_unknown`).
4. **STOP** if the message is not `failed` within 15 s.
5. After n = 5: **STOP** unless the database shows QA Sim 500 F07 `open` at `BASELINE_GEN + 1`.

Because each message is terminal before the next is submitted, no batch can hold two test messages. This makes concurrent admission before the trip impossible without changing worker configuration. The expected duration is about 1–3 s per message, well inside the 60 s window and the 30 s cooldown; C0 enforces both bounds.

### 4.3 Log-coverage markers
Immediately before message 1 and after message 10, the driver emits, with no state change:
- a failing read-only query `SELECT f07_mark_<uuid>()`, which logs an ERROR in postgres;
- `GET /api/v1/f07-mark` with that marker UUID as `X-Correlation-ID`, which logs a 404.

`verify` treats the logs as covering the run only if both markers are present in each tail.

### 4.4 Abort handling
Any STOP ends submission and leaves all state as it is. There is no retry, no improvised recovery and no provider change. Run `verify` on the partial run and report it.

## 5. Acceptance criteria (`f07-v223.sh verify <RUN_DIR>`, read-only)

| ID | Criterion | Source |
|---|---|---|
| C0 | **Validity:** messages 1–5 complete within 60 s of message 1's creation; message 10 completes within 30 s of the trip (`circuit_changed_at`). If false, the run is **INVALID** (re-run with owner approval), not FAIL | DB |
| C1 | Exactly 10 run messages, with sequences 1–10 unique | DB |
| C2 | Messages 1–5: exactly 1 attempt each, on QA Sim 500 F07, attempt `failed`, message `failed` | DB |
| C3 | QA Sim 500 F07 `open`, `circuit_generation = BASELINE_GEN + 1`, `health_state = offline`, `circuit_changed_at ≥ test start` | DB |
| C3b | **Informational only, not part of the verdict.** Number of `provider.circuit_changed` audit rows for the provider inside the window. Expected **0** under the current design (R-AUD-1). It must not be read as evidence that circuit transitions are audited | DB |
| C3c | **Informational corroboration.** Dispatcher log lines `provider circuit closed -> open` for `F07_PROVIDER_ID` with `circuitGeneration = BASELINE_GEN + 1` inside the window (the warning the state store emits on T1) | Logs |
| C4 | Zero `42501` / `insufficient_privilege` lines in postgres (C4a), and zero `insufficient_privilege` / `QueryFailedError` / `42501` lines in the api log (C4b), inside the window. If the coverage markers are missing (L0a/L0b), C4 is **NOT PROVEN** (BLOCKED), never PASS | Logs |
| C5 | Messages 6–10: 0 attempts, `failed`, `failure_reason = NO_ELIGIBLE_PROVIDER`, plus a `message.failed` event with reason `NO_ELIGIBLE_PROVIDER` and details `All assigned provider circuits refused admission` | DB |
| C6 | Exactly 5 `message_attempts` rows for QA Sim 500 F07 inside the window, all belonging to run messages | DB |
| C6b | At least 5 `Provider circuit refused admission` warnings referencing run messages (corroboration) | Logs |
| C6c | Zero `provider submission refused: no valid circuit admission` lines in the window. This guarantees each attempt row reached the adapter | Logs |
| C7 | All 10 run messages `failed`; none `outcome_unknown` | DB |
| C8 | No queue rows for run messages (the global queue count is recorded) | DB |
| C9 | **Validity:** no qa-org-a2 WhatsApp assignment was updated inside the run window, and no assignment other than the provider is active at verification. If false, the run is **INVALID** | DB |

**Verdict:**
- **PASS:** C0, C9 and every one of C1–C8 are true (C3b and C3c are informational), and the coverage checks L0a and L0b are `yes`.
- **INVALID:** C0 or C9 is false.
- **BLOCKED:** L0a or L0b is `NO`.
- **FAIL:** anything else.

## 5a. Residuals carried by this procedure

- **R-AUD-1 (audit/observability, informational):** circuit and health transitions made by the system dispatcher are **intentionally not audited** under the current privilege design. `provider-state.store.ts` skips the `audit_logs` insert when `principal.actorType === 'system'` (HIGH-6: the dispatcher holds no `audit_logs` INSERT privilege; lines 488–489 for `provider.circuit_changed` and 532–533 for `provider.health_changed`). Metrics and a warning log line are still emitted (C3c). This was observed on QA on 31-Oct-2026 (zero rows for the original QA Sim 500 at generation 9). It is an observability gap carried as a residual, not a defect found by this test. C0, C3, C5, C6 and C9 remain mandatory. Evidence: `code-evidence/c10-system-transition-audit-skip.txt`.

## 6. Code basis for the attempt-counting criteria (safeguard 2, at `441a29a`)

- `message_attempts` is the only attempt table; `submission_attempts` does not exist.
- For each candidate, `processClaim` follows this order:
  1. Circuit admission (`dispatcher.service.ts:465`). If every candidate is refused, the message is failed with `NO_ELIGIBLE_PROVIDER`, the refusal event is written, and the queue row is deleted. **No attempt row is created** (`:489–516`).
  2. Otherwise one `message_attempts` row is inserted as `submitting` (`:546`) and committed (`:589`).
  3. Then `executor.execute` is called exactly once (`:594`).
- **Attempt rows versus adapter calls:** each attempt row equals exactly one executor call. The only way the executor can skip the adapter is its own admission check, which logs `provider submission refused: no valid circuit admission`; C6c requires zero such lines.
- **Fallback:** with QA Sim 500 F07 as the only active assignment (P4), a 500 (`PROVIDER_ERROR`) finds no remaining candidate. The message terminates `failed` with `NO_ELIGIBLE_PROVIDER` after one attempt (`:797–869`).
- **State transitions:** the trip moves `generation` to +1 (`provider-state-machine.ts:137`). Health becomes `offline` after 5 consecutive failures (`OFFLINE_CONSECUTIVE_FAILURES = 5`, `MIN_SAMPLES = 5`).

### 6a. Messages 6–10: zero provider calls and zero attempt rows (implementation, at `441a29a`)

- **No attempt row:** for each candidate, `processClaim` calls `providerStateStore.admit` (`dispatcher.service.ts:465`). When every candidate is refused, it fails the message (`:489–513`) and **returns** with outcome `circuit_refused` (`:516–522`) **before** the only `INSERT INTO message_attempts` (`:546`) and the only dispatcher call to `executor.execute` (`:594`). Evidence: `code-evidence/c8-refusal-no-attempt-no-call.txt`.
- **No physical call:** adapters extend `GuardedProviderAdapter`, whose `send()` refuses any call that lacks a permit minted by circuit admission for that adapter instance, provider and submission. `submit()` (the provider call) is reachable only through `send()` (`circuit-admission.ts:427–470`, ADR-015 R-13). A refused admission mints no permit, so the adapter cannot be reached.
- **No other caller:** the only callers of `executor.execute` are the dispatcher (`:594`) and provider test-send (`provider-registry.service.ts:527`), and P7 requires zero test-sends. There is no background provider prober (no scheduler in `providers/` or `provider-adapters/`). Evidence: `code-evidence/c9-adapter-permit-guard.txt`.
- **Test criteria:** C5 (0 attempt rows for each of messages 6–10), C6 (exactly 5 provider attempt rows in the window, all from messages 1–5) and C6c (no executor admission refusals) together prove zero physical calls for messages 6–10 in the run itself.

## 7. After the run

- No provider configuration, assignment or circuit change is made.
- QA Sim 500 F07 is left `open`. It moves to `half_open` only on the next admission attempt after the 30 s cooldown, and Sim 500 can never close it, because it always fails.
- Restoring the circuit (if wanted) is a separate owner decision. v2.1 §7.2 ("reset via platform admin API") is **removed** from this procedure because it changes provider state.
- The test leaves 10 failed messages and 10 synthetic contacts in qa-org-a2.

## 8. Evidence

- **Folders:** `preflight-<UTC>/` and `run-<TEST_RUN_ID>/` under `~/acc-evidence/2026-10-31-qa-f07/`.
- **Run folder contents:** run id, baseline, submissions and settlements (TSV), message ids, markers, assertion output, raw log tails and `MANIFEST.sha256`.
