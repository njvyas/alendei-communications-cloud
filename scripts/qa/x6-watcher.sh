#!/usr/bin/env bash
# =============================================================================
# ACC QA Watcher Diagnostic Script: X-6 BE-DISPATCH-02 Crash Recovery
#
# PURPOSE:
#   Monitors PostgreSQL for a specific synthetic test message reaching 'submitting'
#   status with verified tenant, channel, recipient, testRunId, and provider,
#   then immediately sends SIGKILL to the verified API container to simulate a hard
#   process crash during in-flight provider submission.
#
# REMEDIATION & SAFETY GUARDS (30-Oct-2026):
#   1. Target Identification: requires exact test-run-id, tenant, channel, recipient,
#      expected provider, attempt_number = 1, and dual submitting statuses.
#   2. Persisted Metadata Binding: matches both payload->>'testRunId' AND correlation_id.
#   3. Unambiguous Matching: queries all matches (no LIMIT 1); multiple matches abort safely.
#   4. Rechecked Age Limit: instantaneous message age calculated immediately before kill.
#   5. Time Margin Enforcement: aborts if remaining margin before 3.0s provider timeout < 0.5s.
#   6. Exact Container Target: preflight container ID verified; aborts if container ID changes.
#   7. Structural Safety: dry-run and test-mode redirect kill binaries to safety echo stubs.
#   8. Single-Watcher Concurrency: flock guard enforces strictly one active watcher instance.
#   9. Fail-Closed Error Handling: query errors, malformed outputs, and interruptions fail closed.
#
# RESTRICTIONS:
#   Local preparation only. No QA-host operations permitted without owner approval.
# =============================================================================

set -euo pipefail

# Default configuration values
TARGET_RECIPIENT="+12025550186"
TEST_RUN_ID=""
TENANT_SLUG="qa-org-a2"
CHANNEL_CODE="whatsapp"
EXPECTED_PROVIDER="QA Sim Timeout"
POLL_INTERVAL="0.1"            # 100 ms
MAX_SECONDS="10.0"             # 10.0 s fail-safe limit
MAX_AGE_SECONDS="2.5"          # 2.5 s provider timeout boundary (3.0s timeout)
PROVIDER_TIMEOUT_SECONDS="3.0" # Simulated provider response delay
MIN_MARGIN_SECONDS="0.5"       # Minimum margin required between age and provider timeout
API_SERVICE="api"
PG_CONTAINER="postgres"
DB_USER="postgres"             # acc_app is NOLOGIN and RLS-bound; read-only transaction enforced below
DB_NAME="acc"
LOCK_FILE="/tmp/acc-x6-watcher.lock"

DRY_RUN=false
NON_INTERACTIVE=false
ARMED=false
TEST_MODE=false
DUMP_QUERY=false

# Default Docker commands
DOCKER_COMPOSE_BIN=()
if [[ -n "${C:-}" ]]; then
  read -r -a DOCKER_COMPOSE_BIN <<< "$C"
else
  DOCKER_COMPOSE_BIN=("docker" "compose")
fi
DOCKER_KILL_CMD=("docker" "kill")

usage() {
  cat <<EOF
Usage: $(basename "$0") --test-run-id <ID> [OPTIONS]

Required:
  --test-run-id <ID>         Exact synthetic test-run identifier (8-64 alphanumeric/hyphen chars)

Target Identification:
  --recipient <phone>        Target synthetic recipient phone (default: +12025550186)
  --tenant <slug>            Target organization slug (default: qa-org-a2)
  --channel <code>           Target channel code (default: whatsapp)
  --expected-provider <name> Expected provider name (default: 'QA Sim Timeout')

Timing and Bounds:
  --poll-interval <sec>      Polling interval in seconds [0.05 - 1.0] (default: 0.1)
  --max-seconds <sec>        Maximum wait timeout in seconds [1.0 - 30.0] (default: 10.0)
  --max-age <sec>            Max message age in seconds before kill abort [0.5 - 2.5] (default: 2.5)
  --min-margin <sec>         Minimum remaining margin before 3.0s timeout [0.2 - 1.0] (default: 0.5)

Environment & Containers:
  --api-service <name>       API service name in compose (default: api)
  --pg-container <name>      Postgres container service name (default: postgres)
  --db-user <user>           Database user for query (default: acc_app)
  --db-name <name>           Database name for query (default: acc)
  --lock-file <path>         Path to single-instance lock file (default: /tmp/acc-x6-watcher.lock)

Modes & Safety:
  --dry-run                  Simulate detection without issuing SIGKILL (structurally stubbed)
  --non-interactive          Run non-interactively (requires --armed)
  --armed                    Acknowledge kill authority for non-interactive mode
  --test-mode                Mock execution for local testing (structurally stubbed)
  --dump-query               Print generated psql query and parameters then exit
  --help|-h                  Show this help message and exit
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test-run-id)
      TEST_RUN_ID="$2"
      shift 2
      ;;
    --recipient)
      TARGET_RECIPIENT="$2"
      shift 2
      ;;
    --tenant)
      TENANT_SLUG="$2"
      shift 2
      ;;
    --channel)
      CHANNEL_CODE="$2"
      shift 2
      ;;
    --expected-provider)
      EXPECTED_PROVIDER="$2"
      shift 2
      ;;
    --poll-interval)
      POLL_INTERVAL="$2"
      shift 2
      ;;
    --max-seconds)
      MAX_SECONDS="$2"
      shift 2
      ;;
    --max-age)
      MAX_AGE_SECONDS="$2"
      shift 2
      ;;
    --min-margin)
      MIN_MARGIN_SECONDS="$2"
      shift 2
      ;;
    --api-service)
      API_SERVICE="$2"
      shift 2
      ;;
    --pg-container)
      PG_CONTAINER="$2"
      shift 2
      ;;
    --db-user)
      DB_USER="$2"
      shift 2
      ;;
    --db-name)
      DB_NAME="$2"
      shift 2
      ;;
    --lock-file)
      LOCK_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
      ;;
    --armed)
      ARMED=true
      shift
      ;;
    --test-mode)
      TEST_MODE=true
      shift
      ;;
    --dump-query)
      DUMP_QUERY=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Enforce Structural Safety: In dry-run or test-mode, overwrite commands with safety echo stubs
if [[ "$DRY_RUN" == true || "$TEST_MODE" == true ]]; then
  DOCKER_COMPOSE_BIN=("echo" "[SAFETY_STUB_COMPOSE]")
  DOCKER_KILL_CMD=("echo" "[SAFETY_STUB_KILL]")
fi

# Strict input validation
validate_inputs() {
  if [[ -z "$TEST_RUN_ID" ]]; then
    echo "ERROR: --test-run-id is required." >&2
    usage
    exit 1
  fi

  # Must be a lowercase UUID: the API honours a caller-supplied X-Correlation-ID only when it is a UUID
  # (correlation.middleware.ts), and the watcher matches messages on correlation_id = TEST_RUN_ID.
  if [[ ! "$TEST_RUN_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: Invalid --test-run-id '$TEST_RUN_ID'. Must be a lowercase UUID (the API replaces non-UUID correlation ids)" >&2
    exit 1
  fi

  if [[ ! "$TARGET_RECIPIENT" =~ ^\+[1-9][0-9]{7,14}$ ]]; then
    echo "ERROR: Invalid E.164 --recipient '$TARGET_RECIPIENT'." >&2
    exit 1
  fi

  if [[ ! "$TENANT_SLUG" =~ ^[a-z0-9-]+$ ]]; then
    echo "ERROR: Invalid --tenant '$TENANT_SLUG'." >&2
    exit 1
  fi

  if [[ ! "$CHANNEL_CODE" =~ ^(whatsapp|sms|rcs)$ ]]; then
    echo "ERROR: Invalid --channel '$CHANNEL_CODE'. Must be whatsapp, sms, or rcs." >&2
    exit 1
  fi

  if [[ ! "$EXPECTED_PROVIDER" =~ ^[A-Za-z0-9\ _-]+$ ]]; then
    echo "ERROR: Invalid --expected-provider '$EXPECTED_PROVIDER'." >&2
    exit 1
  fi

  # Numeric bounds
  local min_ms="1.0"
  if [[ "$TEST_MODE" == true ]]; then
    min_ms="0.1"
  fi

  local valid_bounds
  valid_bounds=$(awk -v pi="$POLL_INTERVAL" -v ms="$MAX_SECONDS" -v min_ms="$min_ms" -v ma="$MAX_AGE_SECONDS" -v mm="$MIN_MARGIN_SECONDS" '
    BEGIN {
      if (pi < 0.05 || pi > 1.0) { print "poll_interval_out_of_bounds"; exit; }
      if (ms < min_ms || ms > 30.0) { print "max_seconds_out_of_bounds"; exit; }
      if (ma < 0.5 || ma > 2.5) { print "max_age_out_of_bounds"; exit; }
      if (mm < 0.2 || mm > 1.0) { print "min_margin_out_of_bounds"; exit; }
      print "ok";
    }
  ')

  if [[ "$valid_bounds" != "ok" ]]; then
    echo "ERROR: Numeric argument validation failed: $valid_bounds." >&2
    exit 1
  fi
}

validate_inputs

# Calculate maximum iterations
MAX_ITERATIONS=$(awk "BEGIN {print int($MAX_SECONDS / $POLL_INTERVAL)}")
if [[ "$MAX_ITERATIONS" -le 0 ]]; then
  MAX_ITERATIONS=100
fi

# Concurrency Guard: Single-Watcher Lock
LOCK_FD=200
acquire_watcher_lock() {
  if [[ "$TEST_MODE" == true && "${MOCK_LOCK_FAILURE:-false}" == true ]]; then
    echo "ERROR: [CONCURRENCY GUARD] Another X-6 watcher is currently active (mock lock held)." >&2
    exit 1
  fi

  eval "exec $LOCK_FD>\"$LOCK_FILE\""
  if ! flock -n "$LOCK_FD"; then
    echo "ERROR: [CONCURRENCY GUARD] Another X-6 watcher instance is currently active on $LOCK_FILE." >&2
    echo "Simultaneous watcher execution is strictly prohibited." >&2
    exit 1
  fi
}

release_watcher_lock() {
  flock -u "$LOCK_FD" 2>/dev/null || true
  rm -f "$LOCK_FILE" 2>/dev/null || true
}

# Exactly-once kill latch
KILLED=false
VERIFIED_CONTAINER_ID=""

# Safe interrupt cleanup
cleanup_on_interrupt() {
  echo ""
  echo ">>> [ABORT] Interrupted by signal. Kill latch was: KILLED=$KILLED." >&2
  if [[ "$KILLED" == false ]]; then
    echo ">>> [SAFE] No kill command was executed." >&2
  fi
  release_watcher_lock
  exit 130
}
trap cleanup_on_interrupt SIGINT SIGTERM
trap release_watcher_lock EXIT

# Database query helper using psql variable binding and stdin heredoc
query_db_parameterized() {
  local watcher_start="$1"

  if [[ "$TEST_MODE" == true ]]; then
    if [[ "${MOCK_QUERY_ERROR:-false}" == true ]]; then
      echo "psql: error: connection refused" >&2
      return 1
    fi
    if [[ "${MOCK_MALFORMED_OUTPUT:-false}" == true ]]; then
      echo "INVALID_DATA_NOT_ENOUGH_COLUMNS"
      return 0
    fi
    if [[ "${MOCK_AMBIGUOUS_MATCH:-false}" == true ]]; then
      # Return two rows simulating duplicate/multiple active matches
      local age="${MOCK_MESSAGE_AGE:-0.5}"
      local epoch_now
      epoch_now=$(date +%s)
      echo "0192e2b0-msg-001|submitting|att-001|1|QA Sim Timeout|${epoch_now}|${age}"
      echo "0192e2b0-msg-002|submitting|att-002|1|QA Sim Timeout|${epoch_now}|${age}"
      return 0
    fi
    if [[ -n "${MOCK_MESSAGE_STATUS:-}" ]]; then
      # Format: id|status|attempt_id|attempt_number|provider_name|msg_created_epoch|age_seconds
      local age="${MOCK_MESSAGE_AGE:-0.5}"
      local epoch_created
      epoch_created=$(awk -v age="$age" 'BEGIN { printf "%.3f", systime() - age }')
      echo "${MOCK_MESSAGE_ID:-0192e2b0-test}|${MOCK_MESSAGE_STATUS}|${MOCK_ATTEMPT_ID:-att-001}|1|${MOCK_PROVIDER:-QA Sim Timeout}|${epoch_created}|${age}"
    else
      echo ""
    fi
    return 0
  fi

  # SQL query strictly matching unambiguous target criteria without LIMIT 1
  # If multiple matches exist, run_watcher detects multiple rows and aborts safely.
  local sql='
    SELECT 
      m.id, 
      m.status, 
      ma.id, 
      ma.attempt_number, 
      p.name,
      ROUND(EXTRACT(EPOCH FROM m.created_at)::numeric, 3),
      ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - m.created_at))::numeric, 3)
    FROM messages m
    JOIN organizations o ON o.id = m.org_id
    JOIN channels c ON c.id = m.channel_id
    JOIN message_attempts ma ON ma.id = m.current_attempt_id
    JOIN providers p ON p.id = ma.provider_id
    WHERE o.slug = :'"'tenant_slug'"'
      AND c.code = :'"'channel_code'"'
      AND m.recipient_address = :'"'recipient'"'
      AND (m.payload->>'"'testRunId'"' = :'"'test_run_id'"' AND m.correlation_id = :'"'test_run_id'"')
      AND m.created_at >= :'"'watcher_start'"'::timestamptz
      AND m.status = '"'submitting'"'
      AND ma.status = '"'submitting'"'
      AND ma.attempt_number = 1
      AND p.name = :'"'expected_provider'"';
  '

  "${DOCKER_COMPOSE_BIN[@]}" exec -T -e PGOPTIONS="-c default_transaction_read_only=on" "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    -v tenant_slug="$TENANT_SLUG" \
    -v channel_code="$CHANNEL_CODE" \
    -v recipient="$TARGET_RECIPIENT" \
    -v test_run_id="$TEST_RUN_ID" \
    -v expected_provider="$EXPECTED_PROVIDER" \
    -v watcher_start="$watcher_start" \
    -t -A -F'|' <<EOF
$sql
EOF
}

# Pre-flight checks
preflight_checks() {
  echo "=== ACC X-6 Watcher: Pre-Flight Verification ==="
  echo "Target Recipient    : $TARGET_RECIPIENT"
  echo "Test Run ID         : $TEST_RUN_ID"
  echo "Target Tenant       : $TENANT_SLUG"
  echo "Target Channel      : $CHANNEL_CODE"
  echo "Expected Provider   : $EXPECTED_PROVIDER"
  echo "Poll Interval       : ${POLL_INTERVAL}s"
  echo "Max Timeout         : ${MAX_SECONDS}s (${MAX_ITERATIONS} iterations)"
  echo "Max Message Age     : ${MAX_AGE_SECONDS}s (within ${PROVIDER_TIMEOUT_SECONDS}s provider timeout)"
  echo "Min Time Margin     : ${MIN_MARGIN_SECONDS}s remaining margin"
  echo "API Service         : $API_SERVICE"
  echo "Dry Run Mode        : $DRY_RUN"
  echo "Test Mode           : $TEST_MODE"

  # 1. Acquire single-watcher lock
  echo -n "Checking concurrency lock... "
  acquire_watcher_lock
  echo "OK (lock acquired)"

  # 2. Check DB connectivity and clean queue
  echo -n "Checking database connectivity and queue... "
  if [[ "$TEST_MODE" == false ]]; then
    local queue_count
    queue_count=$("${DOCKER_COMPOSE_BIN[@]}" exec -T -e PGOPTIONS="-c default_transaction_read_only=on" "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "SELECT COUNT(*) FROM message_dispatch_queue;")
    if [[ "$queue_count" != "0" ]]; then
      echo "FAILED" >&2
      echo "ERROR: Dispatch queue is not empty (found $queue_count rows). Cannot run X-6 with dirty queue." >&2
      exit 1
    fi
  fi
  echo "OK (queue = 0)"

  # 3. Verify exactly one running API container
  echo -n "Verifying running API container... "
  if [[ "$TEST_MODE" == false ]]; then
    local container_ids
    container_ids=$("${DOCKER_COMPOSE_BIN[@]}" ps -q "$API_SERVICE" 2>/dev/null || true)
    local count
    count=$(echo "$container_ids" | grep -c . || true)
    if [[ "$count" -ne 1 || -z "$container_ids" ]]; then
      echo "FAILED" >&2
      echo "ERROR: Expected exactly 1 running API container for service '$API_SERVICE', found: $count." >&2
      exit 1
    fi
    VERIFIED_CONTAINER_ID="$container_ids"
    echo "OK ($VERIFIED_CONTAINER_ID)"
  else
    VERIFIED_CONTAINER_ID="mock-container-id-001"
    echo "OK (mock: $VERIFIED_CONTAINER_ID)"
  fi

  echo "Pre-flight checks passed."
  echo ""
}

# Operator confirmation
confirm_arming() {
  if [[ "$DRY_RUN" == true ]]; then
    echo ">>> Running in DRY RUN mode. Kill signal is structurally disabled."
    return 0
  fi

  if [[ "$TEST_MODE" == true ]]; then
    echo ">>> Running in TEST mode. Kill signal is structurally disabled."
    return 0
  fi

  if [[ "$NON_INTERACTIVE" == true ]]; then
    if [[ "$ARMED" != true ]]; then
      echo "ERROR: Non-interactive mode requires explicit --armed flag." >&2
      exit 1
    fi
    echo ">>> ARMED via --non-interactive --armed. Kill command authorized."
    return 0
  fi

  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "WARNING: YOU ARE ABOUT TO ARM A HARD SIGKILL TRIGGER ON CONTAINER '$VERIFIED_CONTAINER_ID'."
  echo "TARGET IDENTIFIER : testRunId = '$TEST_RUN_ID', recipient = '$TARGET_RECIPIENT'"
  echo "PROVIDER BOUNDARY : '$EXPECTED_PROVIDER' (timeout 3.0s, safe age limit: ${MAX_AGE_SECONDS}s)"
  echo "THIS COMMAND IS ONLY AUTHORIZED DURING A DEDICATED QA OPERATOR WINDOW."
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  read -r -p "Type 'yes' to confirm arming: " confirmation
  if [[ "$confirmation" != "yes" ]]; then
    echo "ABORTED: Operator did not type 'yes'. Watcher not armed." >&2
    exit 1
  fi
  echo ">>> Watcher ARMED by operator confirmation."
  echo ""
}

# Execute kill action with instantaneous age recheck and container identity assertion
execute_kill() {
  local msg_id="$1"
  local status="$2"
  local attempt_id="$3"
  local attempt_num="$4"
  local provider="$5"
  local msg_epoch="$6"
  local age_sec="$7"

  # Exactly-once protection latch
  if [[ "$KILLED" == true ]]; then
    echo ">>> [BLOCKED] Duplicate kill invocation prevented by latch." >&2
    return 0
  fi
  KILLED=true

  local t_detect_epoch
  t_detect_epoch=$(date +%s%N)
  local t_detect_iso
  t_detect_iso=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

  echo ""
  echo "=============================================================================="
  echo ">>> TARGET MATCH VERIFIED AT T_detect = $t_detect_iso"
  echo ">>> Message ID       : $msg_id"
  echo ">>> Status           : $status"
  echo ">>> Attempt ID       : $attempt_id (Attempt #$attempt_num)"
  echo ">>> Provider         : $provider"
  echo ">>> Message DB Age   : ${age_sec}s (limit: ${MAX_AGE_SECONDS}s)"
  echo "=============================================================================="

  # 1. Recheck instantaneous message age right before kill
  local now_epoch_sec
  now_epoch_sec=$(date +%s.%3N)
  local instantaneous_age
  instantaneous_age=$(awk -v now="$now_epoch_sec" -v created="$msg_epoch" 'BEGIN { printf "%.3f", (now - created) }')

  # 2. Recheck message-age limit
  local age_exceeded
  age_exceeded=$(awk -v age="$instantaneous_age" -v max="$MAX_AGE_SECONDS" 'BEGIN { print (age > max) ? 1 : 0 }')
  if [[ "$age_exceeded" -eq 1 ]]; then
    echo ">>> [ABORT] Instantaneous message age (${instantaneous_age}s) exceeds threshold (${MAX_AGE_SECONDS}s)." >&2
    echo ">>> Approaching 3.0s provider timeout boundary. Killing now risks race condition." >&2
    echo ">>> SIGKILL ABORTED. Exiting safely." >&2
    exit 3
  fi

  # 3. Check remaining time margin against provider timeout boundary (3.0s)
  local remaining_margin
  remaining_margin=$(awk -v age="$instantaneous_age" -v timeout="$PROVIDER_TIMEOUT_SECONDS" 'BEGIN { printf "%.3f", (timeout - age) }')
  local margin_insufficient
  margin_insufficient=$(awk -v margin="$remaining_margin" -v min_m="$MIN_MARGIN_SECONDS" 'BEGIN { print (margin < min_m) ? 1 : 0 }')
  if [[ "$margin_insufficient" -eq 1 ]]; then
    echo ">>> [ABORT] Remaining time margin (${remaining_margin}s) is below minimum safe margin (${MIN_MARGIN_SECONDS}s)." >&2
    echo ">>> Insufficient margin before provider timeout (3.0s). Killing now risks race condition." >&2
    echo ">>> SIGKILL ABORTED. Exiting safely." >&2
    exit 3
  fi

  # 4. Structural Safety Check: Test mode and Dry run are incapable of calling real Docker kill
  if [[ "$DRY_RUN" == true ]]; then
    echo ">>> [DRY RUN] Target container: $VERIFIED_CONTAINER_ID"
    echo ">>> [DRY RUN] Would execute: ${DOCKER_KILL_CMD[*]} -s SIGKILL $VERIFIED_CONTAINER_ID"
    echo ">>> [DRY RUN] Kill skipped."
    return 0
  fi

  if [[ "$TEST_MODE" == true ]]; then
    if [[ "${MOCK_CONTAINER_MISMATCH:-false}" == true ]]; then
      echo "ERROR: [CONTAINER MISMATCH] Target container identity changed between preflight and kill time!" >&2
      echo "  Preflight container ID: '$VERIFIED_CONTAINER_ID'" >&2
      echo "  Current container ID  : 'mock-container-id-999'" >&2
      echo ">>> SIGKILL ABORTED. Exiting safely." >&2
      exit 7
    fi
    echo ">>> [TEST MODE] Mocked kill executed successfully against $VERIFIED_CONTAINER_ID."
    return 0
  fi

  # 5. Container Identity Verification: Ensure container ID hasn't changed since preflight
  local current_container_id
  current_container_id=$("${DOCKER_COMPOSE_BIN[@]}" ps -q "$API_SERVICE" 2>/dev/null || true)
  local current_count
  current_count=$(echo "$current_container_id" | grep -c . || true)
  if [[ "$current_count" -ne 1 || "$current_container_id" != "$VERIFIED_CONTAINER_ID" ]]; then
    echo "ERROR: [CONTAINER MISMATCH] Target container identity changed between preflight and kill time!" >&2
    echo "  Preflight container ID: '$VERIFIED_CONTAINER_ID'" >&2
    echo "  Current container ID  : '$current_container_id'" >&2
    echo ">>> SIGKILL ABORTED. Exiting safely." >&2
    exit 7
  fi

  # 6. Execute kill against exact verified container ID
  local t_kill_start
  t_kill_start=$(date +%s%N)
  echo ">>> Sending SIGKILL to verified container ID: $VERIFIED_CONTAINER_ID..."
  "${DOCKER_KILL_CMD[@]}" -s SIGKILL "$VERIFIED_CONTAINER_ID"
  local t_kill_end
  t_kill_end=$(date +%s%N)

  local docker_latency_ms
  docker_latency_ms=$(( (t_kill_end - t_kill_start) / 1000000 ))
  local total_latency_ms
  total_latency_ms=$(( (t_kill_end - t_detect_epoch) / 1000000 ))
  echo ">>> SIGKILL successfully delivered (docker command latency: ${docker_latency_ms} ms, total detect-to-kill: ${total_latency_ms} ms)."
  echo ">>> Watcher execution complete."
}

# Main polling loop
run_watcher() {
  local watcher_start
  watcher_start=$(date -u +"%Y-%m-%d %H:%M:%S+00")
  echo "Starting polling loop at $watcher_start (UTC)..."
  echo "Watching for testRunId: '$TEST_RUN_ID', recipient: '$TARGET_RECIPIENT', provider: '$EXPECTED_PROVIDER'"

  local iteration=0
  while [[ $iteration -lt $MAX_ITERATIONS ]]; do
    iteration=$((iteration + 1))

    # Query DB with parameterization
    local result
    if ! result=$(query_db_parameterized "$watcher_start"); then
      echo "ERROR: Database query failed. Aborting watcher safely." >&2
      exit 4
    fi

    local non_empty_lines
    non_empty_lines=$(echo "$result" | grep -v '^[[:space:]]*$' || true)

    if [[ -n "$non_empty_lines" ]]; then
      local row_count
      row_count=$(echo "$non_empty_lines" | wc -l)

      # Unambiguous matching check: duplicate or multiple active matches cause a safe abort
      if [[ "$row_count" -gt 1 ]]; then
        echo "ERROR: [AMBIGUOUS MATCH] Found $row_count active matching messages/attempts." >&2
        echo "Duplicate or multiple active submissions detected. Aborting kill safely to prevent accidental target damage." >&2
        echo "$non_empty_lines" >&2
        exit 6
      fi

      local msg_id status attempt_id attempt_num provider msg_epoch age_sec
      IFS='|' read -r msg_id status attempt_id attempt_num provider msg_epoch age_sec <<< "$non_empty_lines"

      # Fail closed on malformed output
      if [[ -z "$msg_id" || -z "$status" || -z "$attempt_id" || -z "$attempt_num" || -z "$provider" || -z "$msg_epoch" || -z "$age_sec" ]]; then
        echo "ERROR: Malformed query output received: '$non_empty_lines'. Aborting." >&2
        exit 5
      fi

      if [[ "$status" == "submitting" ]]; then
        execute_kill "$msg_id" "$status" "$attempt_id" "$attempt_num" "$provider" "$msg_epoch" "$age_sec"
        return 0
      fi
    fi

    # Heartbeat
    if (( iteration % 10 == 0 )); then
      local elapsed
      elapsed=$(awk "BEGIN {printf \"%.1f\", $iteration * $POLL_INTERVAL}")
      echo -n "[${elapsed}s / ${MAX_SECONDS}s] "
    fi

    if [[ "$TEST_MODE" == false ]]; then
      sleep "$POLL_INTERVAL"
    fi
  done

  echo ""
  echo "=============================================================================="
  echo "ERROR: FAIL-SAFE TIMEOUT EXPIRED ($MAX_SECONDS seconds reached)." >&2
  echo "Target message ($TEST_RUN_ID) did not reach 'submitting' status in window." >&2
  echo "KILL SIGNAL WAS NOT EXECUTED." >&2
  echo "=============================================================================="
  exit 1
}

dump_sql_query() {
  local watcher_start="2026-10-30 00:00:00+00"
  local sql='
    SELECT 
      m.id, 
      m.status, 
      ma.id, 
      ma.attempt_number, 
      p.name,
      ROUND(EXTRACT(EPOCH FROM m.created_at)::numeric, 3),
      ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - m.created_at))::numeric, 3)
    FROM messages m
    JOIN organizations o ON o.id = m.org_id
    JOIN channels c ON c.id = m.channel_id
    JOIN message_attempts ma ON ma.id = m.current_attempt_id
    JOIN providers p ON p.id = ma.provider_id
    WHERE o.slug = :'"'tenant_slug'"'
      AND c.code = :'"'channel_code'"'
      AND m.recipient_address = :'"'recipient'"'
      AND (m.payload->>'"'testRunId'"' = :'"'test_run_id'"' AND m.correlation_id = :'"'test_run_id'"')
      AND m.created_at >= :'"'watcher_start'"'::timestamptz
      AND m.status = '"'submitting'"'
      AND ma.status = '"'submitting'"'
      AND ma.attempt_number = 1
      AND p.name = :'"'expected_provider'"';
  '
  echo "=== DUMP PSQL PARAMETERS ==="
  echo "ON_ERROR_STOP=1"
  echo "tenant_slug=$TENANT_SLUG"
  echo "channel_code=$CHANNEL_CODE"
  echo "recipient=$TARGET_RECIPIENT"
  echo "test_run_id=$TEST_RUN_ID"
  echo "expected_provider=$EXPECTED_PROVIDER"
  echo "watcher_start=$watcher_start"
  echo "=== DUMP SQL QUERY ==="
  echo "$sql"
}

main() {
  if [[ "$DUMP_QUERY" == true ]]; then
    dump_sql_query
    exit 0
  fi
  preflight_checks
  confirm_arming
  run_watcher
}

main "$@"
