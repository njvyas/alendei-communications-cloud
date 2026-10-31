#!/usr/bin/env bash
# =============================================================================
# Automated Test Suite for X-6 Watcher Diagnostic Script
# Tests all safety guards, boundary conditions, concurrency protections,
# parameter validations, timing checks, and fail-closed behaviors locally
# without connecting to Docker daemon or PostgreSQL host.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHER="$SCRIPT_DIR/x6-watcher.sh"

PASSED=0
FAILED=0

assert_exit() {
  local test_name="$1"
  local expected_code="$2"
  shift 2
  local cmd=("$@")

  echo -n "Test: $test_name... "
  set +e
  local output
  output=$("${cmd[@]}" 2>&1)
  local actual_code=$?
  set -e

  if [[ "$actual_code" -eq "$expected_code" ]]; then
    echo "PASS (exit $actual_code)"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (expected $expected_code, got $actual_code)"
    echo ">>> Command Output:"
    echo "$output"
    echo "--------------------------------------------------------"
    FAILED=$((FAILED + 1))
  fi
}

assert_output_contains() {
  local test_name="$1"
  local pattern="$2"
  shift 2
  local cmd=("$@")

  echo -n "Test: $test_name... "
  set +e
  local output
  output=$("${cmd[@]}" 2>&1)
  set -e

  if echo "$output" | grep -qE "$pattern"; then
    echo "PASS (matched '$pattern')"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (did not match '$pattern')"
    echo ">>> Command Output:"
    echo "$output"
    echo "--------------------------------------------------------"
    FAILED=$((FAILED + 1))
  fi
}

echo "=== Running X-6 Watcher Safety & Validation Test Suite ==="
echo ""

# 1. Reject missing mandatory --test-run-id argument
assert_exit "1. Reject missing --test-run-id (Input Safety)" 1 \
  "$WATCHER"

# 2. Reject malformed test-run-id argument (non-alphanumeric, too short)
assert_exit "2. Reject invalid test-run-id characters (Input Safety)" 1 \
  "$WATCHER" --test-run-id "short"

# 2b. Reject a non-UUID run id (the API would replace it as correlation id, so the watcher could never match)
assert_exit "2b. Reject non-UUID legacy run id (Correlation Safety)" 1 \
  "$WATCHER" --test-run-id "x6-run-1730350000"

# 3. Reject malformed recipient phone (non-E.164)
assert_exit "3. Reject invalid E.164 recipient phone (Input Safety)" 1 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --recipient "invalid-phone"

# 4. Reject unsupported channel code
assert_exit "4. Reject unsupported channel code (Channel Guard)" 1 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --channel "email"

# 5. Reject out-of-bounds poll interval (<0.05s)
assert_exit "5. Reject out-of-bounds poll interval <0.05s (Timing Bounds)" 1 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --poll-interval 0.01

# 6. Reject out-of-bounds max seconds (>30s)
assert_exit "6. Reject out-of-bounds max seconds >30s (Timing Bounds)" 1 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --max-seconds 35.0

# 7. Reject out-of-bounds max message age (>2.5s)
assert_exit "7. Reject out-of-bounds max message age >2.5s (Timing Bounds)" 1 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --max-age 3.5

# 8. Reject out-of-bounds min margin (<0.2s or >1.0s)
assert_exit "8. Reject out-of-bounds min margin <0.2s (Margin Guard)" 1 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --min-margin 0.1

# 9. Missing message causes fail-safe timeout without kill
assert_exit "9. Fail-safe timeout when message never appears (Timeout Safety)" 1 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.1 --poll-interval 0.05

# 10. Concurrency protection: Mock lockfile collision fails immediately
assert_exit "10. Concurrency mock lock collision fails immediately (Concurrency Guard)" 1 \
  env MOCK_LOCK_FAILURE=true "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode

# 11. Concurrency protection: Real flock mutual exclusion
TEST_LOCK="/tmp/test-flock-$$.lock"
(
  exec 201>"$TEST_LOCK"
  flock -n 201
  assert_exit "11. Real flock lock contention fails immediately (Concurrency Guard)" 1 \
    "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --lock-file "$TEST_LOCK"
)
rm -f "$TEST_LOCK"

# 12. Database query failure fails closed
assert_exit "12. Database connection/query error fails closed (Fail-Closed Safety)" 4 \
  env MOCK_QUERY_ERROR=true "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.2 --poll-interval 0.05

# 13. Malformed query output fails closed
assert_exit "13. Malformed DB output fails closed (Fail-Closed Safety)" 5 \
  env MOCK_MALFORMED_OUTPUT=true "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.2 --poll-interval 0.05

# 14. Unambiguous match check: Multiple active matches abort safely
assert_exit "14. Multiple active matching messages abort safely (Unambiguous Matching)" 6 \
  env MOCK_AMBIGUOUS_MATCH=true "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.2 --poll-interval 0.05

# 15. Instantaneous message age exceeds 2.5s safe boundary aborts without kill
assert_exit "15. Abort without kill when instantaneous message age > 2.5s (Timing Boundary)" 3 \
  env MOCK_MESSAGE_STATUS="submitting" MOCK_MESSAGE_AGE="2.8" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.5 --poll-interval 0.05

# 16. Insufficient remaining time margin (<0.5s) aborts without kill
assert_exit "16. Abort without kill when remaining time margin < 0.5s (Margin Boundary)" 3 \
  env MOCK_MESSAGE_STATUS="submitting" MOCK_MESSAGE_AGE="2.6" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.5 --poll-interval 0.05 --min-margin 0.5

# 17. Container mismatch between preflight and kill time aborts without kill
assert_exit "17. Container mismatch between preflight and kill aborts (Target Identity Guard)" 7 \
  env MOCK_MESSAGE_STATUS="submitting" MOCK_MESSAGE_AGE="0.5" MOCK_CONTAINER_MISMATCH=true \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.5 --poll-interval 0.05

# 18. Dry-run mode: Skips kill command and never executes real kill
assert_output_contains "18. Dry-run mode skips kill command (Dry-Run Safety)" "\[DRY RUN\] Kill skipped" \
  env MOCK_MESSAGE_STATUS="submitting" MOCK_MESSAGE_AGE="0.5" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --dry-run --max-seconds 0.5 --poll-interval 0.05

# 19. Structural safety: Real Docker kill command is never reachable in test mode
assert_output_contains "19. Structural safety: Real kill command unreachable in test mode" "Mocked kill executed successfully" \
  env MOCK_MESSAGE_STATUS="submitting" MOCK_MESSAGE_AGE="0.5" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.5 --poll-interval 0.05

# 20. Valid detection triggers simulated mock kill with detect-to-kill latency
assert_output_contains "20. Valid detection triggers simulated kill (End-to-End Simulation)" "TARGET MATCH VERIFIED" \
  env MOCK_MESSAGE_STATUS="submitting" MOCK_MESSAGE_AGE="0.5" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --test-mode --max-seconds 0.5 --poll-interval 0.05

# 21. SQL Parameterization: psql quoted variables (:'var') and strict AND binding
assert_output_contains "21a. SQL parameterization uses :'tenant_slug'" ":'tenant_slug'" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --dump-query

assert_output_contains "21b. SQL parameterization uses :'recipient'" ":'recipient'" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --dump-query

assert_output_contains "21c. SQL parameterization uses :'test_run_id'" ":'test_run_id'" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --dump-query

assert_output_contains "21d. SQL parameterization uses :'expected_provider'" ":'expected_provider'" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --dump-query

assert_output_contains "21e. SQL parameterization binds payload testRunId and correlation_id" "payload->>'testRunId'.*AND.*correlation_id" \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --dump-query

# 22. Verify query dump mode exits 0
assert_exit "22. Query dump mode exits 0 (Query Inspection)" 0 \
  "$WATCHER" --test-run-id "6f1c2a9e-3b7d-4c1e-9a2f-0d4b5e6f7a81" --dump-query

echo ""
echo "=== Test Suite Summary ==="
echo "Total Tests Executed: $((PASSED + FAILED))"
echo "Passed: $PASSED"
echo "Failed: $FAILED"

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
