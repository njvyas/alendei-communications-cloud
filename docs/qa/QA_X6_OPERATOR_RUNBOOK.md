# QA-X6 Operator Runbook: BE-DISPATCH-02 Crash Recovery Verification

**Document Version:** 2.1 (31-Oct-2026: corrected after QA-F-07 preflight findings; see §0)  
**Date:** 30-Oct-2026  
**Status:** PREPARED FOR THE LIVE DRILL (owner direction, 31-Oct-2026). Host execution is **NOT authorized** until every field in §9 is recorded and the owner gives explicit operational authorization. All safeguards in §2 and §7 apply unchanged.  
**Target Release:** Phase 4.3 / Gate F.3 Candidate (`2026.10.24-441a29a` / `554dea3`)  
**Scope:** Internal QA Host (`qa/INTERNAL_QA_DEPLOYMENT.md`), Organization *QA Org A2* only.

---

## 0. Version 2.1 corrections (31-Oct-2026)

The QA-F-07 v2.2 preflight (31-Oct-2026) showed that v2.0 of this runbook and its watcher could not have run as written. These corrections do not change the test design:

| Defect in v2.0 | Effect | Correction |
|---|---|---|
| Every SQL step ran `psql -U acc_app` | `acc_app` is a `NOLOGIN`, RLS-bound role, so every query is refused | SQL runs as `postgres` inside a read-only transaction (`PGOPTIONS='-c default_transaction_read_only=on'`); watcher default `--db-user postgres` |
| `TEST_RUN_ID="x6-run-<timestamp>"` was sent as `X-Correlation-ID` | The API keeps a caller-supplied correlation id only when it is a UUID (`correlation.middleware.ts`), and the watcher matches `correlation_id = TEST_RUN_ID`. The watcher would never see the message and would time out without killing | `TEST_RUN_ID` is a lowercase UUID; the watcher refuses anything else (harness test 2b) |
| `X-Idempotency-Key` header | Silently ignored; the API reads `Idempotency-Key` | Header corrected |
| Expected assignment lists omitted later rows | `QA Sim 500 F07` (priority 4, disabled, created for QA-F-07) and `QA Sim 429` (priority 11, disabled) also exist | Lists completed; priority uniqueness covers disabled rows, so the order of the Step 4.1 changes matters |

Logs: post-outage `docker compose logs --since` is unreliable for the api container; this runbook already uses `--tail`.

## 1. Executive Summary & Authorization Notice

> [!CAUTION]
> **LOCAL PREPARATION ONLY.** Per project owner decision (30-Oct-2026, X-6), this runbook and its companion watcher script (`scripts/qa/x6-watcher.sh`) are prepared for review only. **No QA host operations, service interruptions, container restarts, SIGKILL signals, or provider configuration mutations are authorized by this document.** Execution requires a dedicated, separately authorized operator window.

### Purpose of Test X-6
Verifies the runtime behavior of the **BE-DISPATCH-02** expired submission lease recovery fix on the QA environment:
1. Simulates an abrupt crash of the API/dispatcher worker process while an active message submission is in flight (state = `submitting`).
2. Demonstrates that upon restart, the expired-lease sweeper (`recoverExpiredLeases()`) or subsequent claim cleanly transitions the abandoned message to terminal `outcome_unknown`.
3. Verifies that the in-flight provider attempt on `QA Sim Timeout` is marked `outcome_unknown` and **never resubmitted** to any secondary fallback provider (e.g., `QA Sim OK`), preventing duplicate delivery.

---

## 2. Test Architecture & Safety Bounds

```
[Operator: Adjust Org A2 Provider Priorities]
  QA Sim Timeout -> Priority 1 (Enabled)
  QA Sim OK      -> Priority 2 (Active Fallback)
  QA Sim 500     -> Priority 10 (Disabled)
        │
        ▼
[Operator: Arm Watcher Script (scripts/qa/x6-watcher.sh)]
  - Single-instance flock lock (/tmp/acc-x6-watcher.lock)
  - Pre-flight verifies running container ID and empty queue
  - Polls PostgreSQL every 100 ms for status = 'submitting'
  - Fail-safe timeout: 10.0 seconds
  - Enforces 2.5s message age ceiling and 0.5s margin before 3.0s provider timeout
  - Rechecks instantaneous message age and container ID immediately before kill
  - Exactly-once SIGKILL latch targeting exact container ID
        │
        ▼
[Test Driver: Submit Synthetic WhatsApp Message]
  Recipient: +12025550186
  Channel: WhatsApp
  Org: QA Org A2
  testRunId: lowercase UUID (persisted in payload.testRunId and correlation_id; the API discards non-UUID correlation ids)
        │
        ▼
[Dispatcher claims message -> provider submission starts (3s timeout)]
        │
        ▼
[Watcher detects status = 'submitting' at T1]
  Rechecks container ID and remaining time margin (>= 0.5s)
  Issues: docker kill -s SIGKILL <verified-container-id>
  API process killed mid-submission; lease abandoned in DB
        │
        ▼
[Operator: Restart API container]
  $C up -d --wait api
        │
        ▼
[Post-Restart Recovery: Within 30s lease + 5s sweeper cycle]
  Sweeper / claim recovers abandoned lease
  Message -> outcome_unknown
  Attempt #1 (QA Sim Timeout) -> outcome_unknown
  Attempt #2 (QA Sim OK) -> NEVER CREATED (0 attempts)
  Queue -> 0 rows
        │
        ▼
[Operator: Restore Provider Priorities]
  QA Sim 500     -> Priority 1 (Enabled)
  QA Sim OK      -> Priority 2 (Enabled)
  QA Sim Timeout -> Priority 3 (Disabled)
```

---

## 3. Pre-Flight Verification & System State

Before starting the drill, the operator and test driver must establish the clean baseline state. If any pre-flight check fails, **STOP and do not proceed**.

### Step 3.1: Verify Deployment Baseline
Verify that the host is running the expected release image:
```bash
docker inspect --format '{{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' acc-api-1
```
- **Expected:** Image tag `2026.10.24-441a29a`, revision starting with `441a29ad...`.
- Migration proof:
```bash
docker compose exec -T postgres psql -U postgres -d acc -Atc "SELECT count(*), md5(string_agg(hash || ':' || created_at, ',' ORDER BY id)) FROM drizzle.__drizzle_migrations"
```
- **Expected:** `38|04b0fac738f24476e76b88a84fd04850`.

### Step 3.2: Verify Zero Queue & Zero In-Flight Submissions
```bash
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -t -A -c "
SELECT 'queue', COUNT(*) FROM message_dispatch_queue
UNION ALL
SELECT 'submitting_msgs', COUNT(*) FROM messages WHERE status = 'submitting'
UNION ALL
SELECT 'submitting_attempts', COUNT(*) FROM message_attempts WHERE status = 'submitting';
"
```
- **Expected:**
  - `queue|0`
  - `submitting_msgs|0`
  - `submitting_attempts|0`

### Step 3.3: Verify Absence of Orphaned Locks or Transactions
```bash
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -c "
SELECT pid, state, query_start, wait_event_type, wait_event, query 
FROM pg_stat_activity 
WHERE datname = 'acc' AND state != 'idle';
"
```
- **Expected:** No active dispatch queries or ungranted lock waits.

---

### Step 3.4: Verify Provider Circuit and Simulator State (added in v2.1)
```bash
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -c "
SELECT p.name, p.status, p.circuit_state, p.circuit_generation, p.health_state,
  (SELECT value FROM provider_capabilities pc WHERE pc.provider_id = p.id AND pc.capability_key = 'simulator_behavior') AS behavior
FROM providers p JOIN channels c ON c.id = p.channel_id
WHERE c.code = 'whatsapp' AND p.name IN ('QA Sim Timeout', 'QA Sim OK');
"
```
- **Assertion:** both providers `active`, `circuit_state = closed`, `health_state = healthy`; `QA Sim Timeout` behaviour `"TIMEOUT"`; `QA Sim OK` has no behaviour set (default success). An open circuit would refuse the X-6 message or turn it into a half-open probe, so the test would not exercise an in-flight submission.
- Observed read-only on 31-Oct-2026: both `active`, `closed`, generation 0, `healthy`; `QA Sim Timeout` = `"TIMEOUT"`.

## 4. Step-by-Step Operator Procedure

### Step 4.1: Temporary Provider Priority Adjustment (Org A2)
The operator updates the provider assignments for Organization *QA Org A2* on the WhatsApp channel:
- `QA Sim 500`: Priority 1 → 10, Status: Disabled. **Do this first:** priorities are unique even among disabled assignments, so priority 1 must be free before `QA Sim Timeout` takes it.
- `QA Sim Timeout`: Priority 3 → 1, Status: Enabled.
- `QA Sim OK`: Priority 2, Status: Enabled (active fallback candidate).

Verify in database:
```bash
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -c "
SELECT opa.priority, opa.status, p.name 
FROM organization_provider_assignments opa
JOIN providers p ON p.id = opa.provider_id
JOIN organizations o ON o.id = opa.org_id
JOIN channels c ON c.id = opa.channel_id
WHERE o.slug = 'qa-org-a2' AND c.code = 'whatsapp'
ORDER BY opa.priority ASC;
"
```
- **Expected Order:**
  1. Priority 1: `QA Sim Timeout` (`active`)
  2. Priority 2: `QA Sim OK` (`active`)
  3. Priority 4: `QA Sim 500 F07` (`disabled`)
  4. Priority 10: `QA Sim 500` (`disabled`)
  5. Priority 11: `QA Sim 429` (`disabled`)

### Step 4.2: Start the Bounded Watcher Diagnostic Script
In Operator Terminal 1, generate a unique test-run identifier and start the remediated watcher script:
```bash
TEST_RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
echo "Test Run Identifier: $TEST_RUN_ID"

./scripts/qa/x6-watcher.sh \
  --test-run-id "$TEST_RUN_ID" \
  --recipient "+12025550186" \
  --tenant "qa-org-a2" \
  --channel "whatsapp" \
  --expected-provider "QA Sim Timeout" \
  --poll-interval 0.1 \
  --max-seconds 10.0 \
  --max-age 2.5 \
  --min-margin 0.5 \
  --api-service "api"
```

The script acquires `/tmp/acc-x6-watcher.lock`, inspects the running container ID, checks the empty dispatch queue, and prompts:
```
Type 'yes' to confirm arming:
```
The operator confirms by typing `yes`. The watcher begins bounded 100 ms polling.

### Step 4.3: Dispatch the Synthetic Test Message
In Test Driver Terminal 2, immediately dispatch the synthetic test message using the `qa-org-a2-admin` credentials, binding the unique `$TEST_RUN_ID` into both the request correlation ID and payload:
```bash
curl -sS -X POST "https://<QA_HOST>/api/v1/messages" \
  -H "Authorization: Bearer $ORG_A2_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Acc-Organization: $ORG_A2_ID" \
  -H "Idempotency-Key: x6-$TEST_RUN_ID" \
  -H "X-Correlation-ID: $TEST_RUN_ID" \
  -d '{
    "channelCode": "whatsapp",
    "recipient": "+12025550186",
    "templateId": "'"$APPROVED_WA_TEMPLATE_ID"'",
    "payload": { 
      "text": "X6 crash recovery test verification",
      "testRunId": "'"$TEST_RUN_ID"'"
    }
  }' | jq .
```
- Record the returned message ID as `$MSG_ID` and the dispatch timestamp as $T0$.

### Step 4.4: Observe Watcher Trigger and Process Termination
1. The dispatcher worker claims `$MSG_ID` and begins submission to `QA Sim Timeout`.
2. Status transitions to `submitting`.
3. Within 100 ms, the watcher detects status `submitting`.
4. The watcher verifies that:
   - Exactly 1 matching message exists (fails closed with exit code 6 if ambiguous/multiple).
   - Instantaneous message age <= 2.5s and remaining margin before 3.0s timeout >= 0.5s (fails closed with exit code 3 if insufficient).
   - Container ID matches the pre-flight verified container ID (fails closed with exit code 7 if mismatched).
5. The watcher sends SIGKILL directly to the verified container ID:
   ```bash
   docker kill -s SIGKILL <verified-container-id>
   ```
6. Record timestamp $T1$. The watcher prints:
   `SIGKILL successfully delivered (docker command latency: <N> ms, total detect-to-kill: <M> ms)` and exits cleanly with return code 0.

### Step 4.5: Restart the API Container
The operator immediately restarts the API service:
```bash
docker compose up -d --wait api
```
- Record timestamp $T2$ when the container reports healthy (`/health/ready` returns 200).

### Step 4.6: Monitor Recovery and Lease Settlement
The lease timeout is 30 seconds (`DISPATCH_LEASE_MS = 30000`). The sweeper polls every 5 seconds.  
Wait approximately 35–45 seconds following $T1$, then inspect the API logs:
```bash
docker compose logs --tail=100 api | grep -E "recovered expired dispatch leases|settleAbandonedSubmission"
```
- **Expected Log:** `recovered expired dispatch leases` or claim settlement for `$MSG_ID`.

---

## 5. Post-Flight Assertions & Verification Queries

Run the post-flight verification query:
```bash
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -c "
SELECT 
  m.id, 
  m.status AS message_status, 
  m.current_attempt_id,
  m.failure_reason,
  COUNT(ma.id) AS total_attempts
FROM messages m
LEFT JOIN message_attempts ma ON ma.message_id = m.id
WHERE m.id = '$MSG_ID'
GROUP BY m.id, m.status, m.current_attempt_id, m.failure_reason;
"
```

### Required Verification Assertions:
1. **Message Status:** `m.status` MUST be `outcome_unknown`.
2. **Total Attempts:** `total_attempts` MUST be exactly `1`.
3. **Attempt Details:** Inspect the single attempt:
   ```bash
   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -c "
   SELECT ma.attempt_number, ma.status, p.name AS provider_name 
   FROM message_attempts ma
   JOIN providers p ON p.id = ma.provider_id
   WHERE ma.message_id = '$MSG_ID';
   "
   ```
   - **Expected:** Attempt 1, `status = 'outcome_unknown'`, `provider_name = 'QA Sim Timeout'`.
4. **Duplicate Fallback Blocked:**
   - Provider `QA Sim OK` was active at priority 2, but must have **zero attempts** logged.
5. **Queue Row Removed:**
   ```bash
   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -t -A -c "
   SELECT COUNT(*) FROM message_dispatch_queue WHERE message_id = '$MSG_ID';
   "
   ```
   - **Expected:** `0`.
6. **Lifecycle Events:**
   ```bash
   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -c "
   SELECT event_type, payload 
   FROM message_events 
   WHERE message_id = '$MSG_ID' 
   ORDER BY created_at ASC;
   "
   ```
   - **Expected:** `message.created` → `message.submitting` → `message.outcome_unknown`. No `message.accepted` or `message.failed`.

---

## 6. Provider Configuration Restoration

Immediately following verification, restore the Org A2 WhatsApp assignments:
- `QA Sim 500`: Priority 1, Status: Enabled.
- `QA Sim OK`: Priority 2, Status: Enabled.
- `QA Sim Timeout`: Priority 3, Status: Disabled.

Verify restoration in database:
```bash
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -c "
SELECT opa.priority, opa.status, p.name 
FROM organization_provider_assignments opa
JOIN providers p ON p.id = opa.provider_id
JOIN organizations o ON o.id = opa.org_id
JOIN channels c ON c.id = opa.channel_id
WHERE o.slug = 'qa-org-a2' AND c.code = 'whatsapp'
ORDER BY opa.priority ASC;
"
```
- **Expected Baseline Restored:**
  1. Priority 1: `QA Sim 500` (`active`)
  2. Priority 2: `QA Sim OK` (`active`)
  3. Priority 3: `QA Sim Timeout` (`disabled`)
  4. Priority 4: `QA Sim 500 F07` (`disabled`)
  5. Priority 11: `QA Sim 429` (`disabled`)

  Restore in reverse order: `QA Sim Timeout` priority 1 → 3 and disabled first, then `QA Sim 500` priority 10 → 1 and enabled.

---

## 7. Pass / Fail Criteria & Watcher Exit Codes

### Watcher Script Exit Codes:
| Exit Code | Name | Description |
|---|---|---|
| `0` | `SUCCESS` | Target detected, verified, and kill executed (or dry-run/mock complete) |
| `1` | `FAIL_SAFE_TIMEOUT / INVALID_ARG` | Arguments invalid, lock contention, dirty queue, or 10s timeout reached without target |
| `3` | `AGE_EXCEEDED / INSUFFICIENT_MARGIN` | Message age > 2.5s or remaining time margin < 0.5s; SIGKILL safely aborted |
| `4` | `DB_QUERY_ERROR` | Database connection failure, syntax error, or query failure |
| `5` | `MALFORMED_OUTPUT` | Output missing expected pipe-delimited fields |
| `6` | `AMBIGUOUS_MATCH` | Multiple matching messages or attempts found; SIGKILL safely aborted |
| `7` | `CONTAINER_MISMATCH` | Running container ID differs from pre-flight verified ID; SIGKILL safely aborted |
| `130`| `INTERRUPTED` | SIGINT / SIGTERM caught; lock cleanly released, kill avoided if unlatched |

### Overall Test Pass Criteria (All Must Be Satisfied):
- Watcher triggers kill during `submitting` status within the 10-second window.
- Exactly one SIGKILL command executed against the exact verified API container.
- Container successfully recovers to healthy status within 60 seconds of restart.
- Message settles terminally as `outcome_unknown` within 90 seconds of restart.
- Exactly 1 provider attempt recorded (`QA Sim Timeout`); exactly 0 attempts on `QA Sim OK`.
- Dispatch queue row deleted (queue count = 0).
- Provider assignments restored to exact baseline.

### Fail Criteria:
- Message remains stuck in `submitting` or `queued` status after 90 seconds.
- Secondary provider attempt occurs on `QA Sim OK` (duplicate delivery defect).
- API container fails to become healthy within 120 seconds.
- Orphaned PostgreSQL locks or dispatch sessions remain active.

### Safe Abort & Emergency Recovery:
- **Watcher Timeout:** If the message is never detected within 10 seconds, the watcher automatically aborts with exit code 1. **Do NOT kill the API container manually.** Restore provider assignments and investigate why the message did not reach `submitting`.
- **Container Failure to Start:** If the API fails to recover, execute emergency restore:
  ```bash
  docker compose down api && docker compose up -d --wait api
  ```
  Capture full logs:
  ```bash
  docker compose logs api > ~/acc-evidence/x6-emergency-api.log
  ```
- **Rule of Non-Intervention:** NEVER manually edit the database (`UPDATE messages ...`) to force a test to pass.

---

## 8. Evidence Packaging & Security Invariants

1. Package all command outputs, database query results, and bounded log tails into:
   `~/acc-evidence/2026-10-xx-qa-x6/`
2. Generate SHA-256 manifest:
   ```bash
   sha256sum * > MANIFEST.sha256
   ```
3. **Zero Credential Exposure:** Ensure no bearer tokens, API keys, database passwords, or private environment variables are included in saved log files or transcripts.

## 9. Authorization record (complete before execution)

No step in §3–§6 may start until every field below is filled and the owner's explicit operational authorization is recorded. The window, operator identity and approvals are recorded **outside Git** (release record or access register); only the reference goes here.

| # | Field | Value |
|---|---|---|
| 1 | Window (date; start and end, UTC) | *not yet set* |
| 2 | Named QA operator present throughout; opens the SSH control socket | *not yet named* (identity outside Git) |
| 3 | Platform administrator performing the §4.1 and §6 assignment changes | *not yet named* |
| 4 | Approval of this runbook (version 2.1) and of `scripts/qa/x6-watcher.sh` | *pending* |
| 5 | Approval of the temporary assignment change (order in §4.1) and its restoration (§6) | *pending* |
| 6 | Approval of exactly one SIGKILL of the api container, issued only by the watcher | *pending* |
| 7 | Approval of the api restart (`$C up -d --wait api`) and the brief QA outage | *pending* |
| 8 | Acceptance that one QA message ends `outcome_unknown` | *pending* |
| 9 | Acknowledgement of scope: X-6 shows sweeper recovery of an abandoned submission, not the BE-DISPATCH-02 claim-time race (that remains evidenced by the automated suite, PR #14) | *pending* |
| 10 | Optional, same window: I-01, I-02, I-03 (`QA_RELEASE_PREPARATION.md` §5e; I-03 expected result as decided 31-Oct-2026) | *pending* |
| 11 | Owner's explicit operational authorization (reference and time) | *not given* |

**Before the window (Claude Code, read-only, with the operator's socket):**
- Step 3.1 – 3.4 checks: release identity, queue, sessions and locks, and provider circuit and simulator state.
- The watcher's offline harness: `bash scripts/qa/test-x6-watcher.sh`, which must report all tests passed.

Any deviation means STOP; nothing is improvised.

**Known environment facts (31-Oct-2026):**
- the QA host booted at 28-Oct-2026 09:37:44 UTC, and the api container has run since 09:37:55;
- API `--since` log reads are unreliable, so this runbook uses `--tail`;
- whether Docker's `unless-stopped` policy restarts a killed container on its own is **unverified**, so step 4.5 restarts it explicitly.

