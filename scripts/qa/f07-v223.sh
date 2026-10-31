#!/usr/bin/env bash
# QA-F-07 v2.2.3 driver (v2.2.2 + independent-review corrections: sole-active and template gates in run,
# exact template check, --since with --tail fallback, C3c/C9, routing-check). F07_PROVIDER_ID and F07_TEMPLATE_ID required. Subcommands:
#   preflight            read-only: identity, fingerprint, assignments, circuit, queue, worker, log access
#   run    <BASELINE_GEN>  submits the 10 test messages (requires F07_EXECUTE_AUTHORIZED=yes; owner-gated)
#   verify <RUN_DIR>       read-only: post-run assertions for the run recorded in RUN_DIR
#   routing-check          read-only: current qa-org-a2 WhatsApp routing vs the recorded original (restoration proof)
#
# Host access uses ONLY the operator's existing SSH control socket; no new connection is opened.
# SQL runs as postgres inside a read-only transaction. Output never prints credentials.
set -euo pipefail
umask 077

SOCK="${F07_SOCK:-$HOME/.ssh/cm-acc-qa}"
DEST=acc-qa # placeholder: the multiplexed session is selected by the socket, not by this name
COMPOSE='cd ~/acc && docker compose -f deploy/compose.release.yml --env-file deploy/release.env'
API=http://127.0.0.1:3001/api/v1
ORG_SLUG=qa-org-a2
PROVIDER_NAME="${F07_PROVIDER_NAME:-QA Sim 500 F07}"   # checked against PROVIDER_ID; every query is scoped by id
# Original qa-org-a2 WhatsApp routing (recorded 31-Oct-2026 05:54:41Z), used by routing-check.
ORIG_ACTIVE_1=01a16d33-6c0a-7b7d-9630-92caa633a804     # QA Sim 500, p1, active
ORIG_ACTIVE_2=01a16d33-951a-7950-bc66-4145bee7b879     # QA Sim OK,  p2, active
ORIG_DISABLED_1=01a17683-59d1-7db5-bb49-38b62445cc8b   # QA Sim Timeout, p3, disabled
ORIG_DISABLED_2=01a17685-7fc7-75a8-bdbb-b171902fc902   # QA Sim 429, p11, disabled
PROVIDER_ID="${F07_PROVIDER_ID:-}"
TEMPLATE_ID="${F07_TEMPLATE_ID:-}"
CREDS="$HOME/acc-qa-test-creds/qa-org-a2-admin.env"
OUT_ROOT="${F07_OUT:-$HOME/acc-evidence/2026-10-31-qa-f07}"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

die() { printf 'STOP: %s\n' "$*" >&2; exit 3; }
need_template() { # exact template: qa-org-a2, whatsapp, approved, not deleted
  [[ $TEMPLATE_ID =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "F07_TEMPLATE_ID (approved qa-org-a2 WhatsApp template) is required"
  local t; t=$(psql_ro <<<"SELECT o.slug || '|' || c.code || '|' || t.approval_status || '|' || (t.deleted_at IS NULL) FROM templates t JOIN organizations o ON o.id = t.org_id JOIN channels c ON c.id = t.channel_id WHERE t.id = '$TEMPLATE_ID';")
  [[ $t == "$ORG_SLUG|whatsapp|approved|true" ]] || die "template $TEMPLATE_ID is '$t', expected '$ORG_SLUG|whatsapp|approved|true'"
}
routing_state() { # "<active F07 assignments>|<other active assignments>" for qa-org-a2 WhatsApp
  psql_ro <<<"SELECT count(*) FILTER (WHERE opa.provider_id = '$PROVIDER_ID' AND opa.status = 'active') || '|' || count(*) FILTER (WHERE opa.provider_id <> '$PROVIDER_ID' AND opa.status = 'active') FROM organization_provider_assignments opa JOIN organizations o ON o.id = opa.org_id JOIN channels c ON c.id = opa.channel_id WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp';"
}
need_sole_active() { local r; r=$(routing_state); [[ $r == '1|0' ]] || die "QA Sim 500 F07 is not the sole active qa-org-a2 WhatsApp assignment (active F07|others = $r)"; }
need_provider() {
  [[ $PROVIDER_ID =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "F07_PROVIDER_ID (UUID of QA Sim 500 F07) is required"
  local n; n=$(psql_ro <<<"SELECT name FROM providers WHERE id = '$PROVIDER_ID';")
  [[ $n == "$PROVIDER_NAME" ]] || die "provider $PROVIDER_ID is '$n', not '$PROVIDER_NAME'"
}
now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
redact() { sed -u -E -e 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+#<redacted>#g' -e 's#[0-9]{1,3}(\.[0-9]{1,3}){3}#<address>#g'; }

remote() {
  [[ -S $SOCK ]] || die "operator control socket is not open"
  ssh -o ControlPath="$SOCK" -O check "$DEST" >/dev/null 2>&1 || die "operator control socket is not open"
  { ssh -o ControlPath="$SOCK" -o ControlMaster=no -o BatchMode=yes -o ProxyCommand=/bin/false \
      -o ConnectTimeout=5 "$DEST" "$@" 2>&1 1>&3 3>&- | redact >&2; } 3>&1
}
# Host command that takes no input (stdin closed so nothing local is forwarded or awaited).
remote_n() { remote "$@" </dev/null; }
# SQL from stdin; postgres role, read-only transaction, stop on first error.
psql_ro() {
  remote "$COMPOSE exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d acc -At -F '|' -v ON_ERROR_STOP=1 -f -"
}
# curl on the QA host against the API loopback; curl config (headers, body) comes from stdin so
# tokens and passwords never appear in a process argument list.
api() { remote "curl -sS -K -"; }
# Emit one marker into the postgres log (a failing read-only query) and one into the api log (a 404
# carrying the marker as a UUID correlation id). Neither changes state; both prove log coverage.
bracket() {
  local m=$1
  psql_ro <<<"SELECT f07_mark_${m//-/_}();" >/dev/null 2>&1 || true
  printf 'url = "%s/f07-mark"\nheader = "X-Correlation-ID: %s"\nsilent\noutput = "/dev/null"\n' "$API" "$m" | api >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------------------------------------
# Read-only preflight
# ------------------------------------------------------------------------------------------------
preflight() {
  remote_n true # fail closed before creating any evidence folder
  need_provider
  need_template
  local dir; dir="$OUT_ROOT/preflight-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$dir"
  echo "preflight evidence: $dir"
  now >"$dir/00-started-utc.txt"

  # P1 release identity (only the ACC_VERSION line of release.env is read on the host)
  remote_n "$COMPOSE ps --format '{{.Service}}|{{.Image}}|{{.State}}|{{.Health}}' && grep -E '^ACC_VERSION=' ~/acc/deploy/release.env && \
    for s in api web; do id=\$($COMPOSE ps -q \$s); docker inspect --format \"\$s|{{.Image}}|{{index .Config.Labels \\\"org.opencontainers.image.revision\\\"}}|{{.State.StartedAt}}\" \$id; done" \
    >"$dir/p1-release-identity.txt"

  # P2 migration fingerprint
  psql_ro <<<"SELECT count(*), md5(string_agg(hash || ':' || created_at, ',' ORDER BY id)) FROM drizzle.__drizzle_migrations;" \
    >"$dir/p2-migration-fingerprint.txt"

  # P3..P9 database state (one read-only transaction)
  psql_ro >"$dir/p3-p9-db-state.txt" <<SQL
\\echo '## P3 qa-org-a2 organization'
SELECT id, slug, status FROM organizations WHERE slug = '$ORG_SLUG';
\\echo '## P4 qa-org-a2 WhatsApp assignments (all statuses)'
SELECT opa.priority, opa.status, p.name, p.status, p.id
FROM organization_provider_assignments opa
JOIN providers p ON p.id = opa.provider_id
JOIN organizations o ON o.id = opa.org_id
JOIN channels c ON c.id = opa.channel_id
WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp' ORDER BY opa.priority;
\\echo '## P4b active assignments other than QA Sim 500 F07 (must be 0)'
SELECT count(*) FROM organization_provider_assignments opa
JOIN providers p ON p.id = opa.provider_id
JOIN organizations o ON o.id = opa.org_id
JOIN channels c ON c.id = opa.channel_id
WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp' AND opa.status = 'active' AND p.id <> '$PROVIDER_ID';
\\echo '## P5 QA Sim 500 F07 circuit/health (scoped; must be exactly 1 row)'
SELECT p.id, p.name, c.code, p.status, p.circuit_state, p.circuit_generation, p.health_state, p.circuit_changed_at, opa.status AS assignment_status, opa.priority
FROM providers p
JOIN channels c ON c.id = p.channel_id
JOIN organization_provider_assignments opa ON opa.provider_id = p.id
JOIN organizations o ON o.id = opa.org_id
WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp' AND p.id = '$PROVIDER_ID';
\\echo '## P5b QA Sim 500 F07 simulator capability'
SELECT pc.capability_key, pc.value FROM provider_capabilities pc JOIN providers p ON p.id = pc.provider_id WHERE p.id = '$PROVIDER_ID';
\\echo '## P5c platform circuit policy'
SELECT * FROM provider_circuit_policy;
\\echo '## P6 dispatch queue rows / submitting attempts / non-terminal messages (all must be 0)'
SELECT 'queue', count(*) FROM message_dispatch_queue
UNION ALL SELECT 'submitting_attempts', count(*) FROM message_attempts WHERE status = 'submitting'
UNION ALL SELECT 'nonterminal_messages', count(*) FROM messages WHERE status IN ('queued','routing','submitting');
\\echo '## P7 QA Sim 500 F07 activity in the last 10 minutes (must be 0: circuit window 60 s, health window 300 s)'
SELECT 'attempts', count(*) FROM message_attempts ma JOIN providers p ON p.id = ma.provider_id
  WHERE p.id = '$PROVIDER_ID' AND ma.created_at > now() - interval '10 minutes'
UNION ALL SELECT 'audit_' || action, count(*) FROM audit_logs
  WHERE action IN ('provider.test_sent','provider.health_checked','provider.circuit_changed','provider.health_changed')
    AND resource_id = '$PROVIDER_ID'::uuid AND created_at > now() - interval '10 minutes'
  GROUP BY action;
\\echo '## P7b last circuit_changed audit rows for QA Sim 500 F07 (format reference)'
SELECT created_at, action, outcome, before, after FROM audit_logs
  WHERE action = 'provider.circuit_changed' AND resource_id = '$PROVIDER_ID'::uuid
  ORDER BY created_at DESC LIMIT 3;
\\echo '## P8 approved WhatsApp templates in qa-org-a2'
SELECT t.id, t.name, t.approval_status FROM templates t
JOIN organizations o ON o.id = t.org_id JOIN channels c ON c.id = t.channel_id
WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp' AND t.approval_status = 'approved' AND t.deleted_at IS NULL ORDER BY t.created_at;
\\echo '## P9 active suppressions for +12025550301..+12025550310 in qa-org-a2 (must be 0)'
SELECT count(*) FROM suppressions s JOIN organizations o ON o.id = s.org_id
WHERE o.slug = '$ORG_SLUG' AND s.status = 'active'
  AND s.normalized_address IN ($(for i in $(seq 1 10); do printf "'+120255503%02d'%s" "$i" "$([[ $i -lt 10 ]] && echo ,)"; done));
SQL

  # P8b exact template, P4c sole-active (gate form)
  { echo "P8b template $TEMPLATE_ID: qa-org-a2|whatsapp|approved|live verified"; echo "P4c routing active F07|others = $(routing_state)"; } >"$dir/p8b-p4c-gates.txt"

  # P10 worker state: containers running the api image, and dispatcher start lines (tail-read)
  remote_n "img=\$(docker inspect --format '{{.Image}}' \$($COMPOSE ps -q api)); docker ps --no-trunc --format '{{.ID}}|{{.Image}}|{{.Names}}' | while IFS='|' read -r id im nm; do [ \"\$(docker inspect --format '{{.Image}}' \$id)\" = \"\$img\" ] && echo \"api-image-container|\$nm\"; done; \
    $COMPOSE logs --no-color --tail 5000 api 2>&1 | grep -E 'message dispatch (started|is disabled)' | tail -5" \
    >"$dir/p10-worker-state.txt"

  # P11 log access proof: unique markers must be retrievable from api and postgres logs
  local marker; marker=$(cat /proc/sys/kernel/random/uuid)
  echo "$marker" >"$dir/p11-marker.txt"
  local t0; t0=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$t0" >>"$dir/p11-marker.txt"
  printf 'url = "%s/f07-log-probe"\nheader = "X-Correlation-ID: %s"\nsilent\noutput = "/dev/null"\nwrite-out = "%%{http_code}\\n"\n' "$API" "$marker" |
    api >"$dir/p11-api-probe-status.txt"
  psql_ro <<<"SELECT f07_log_probe_${marker//-/_}();" >"$dir/p11-pg-probe.txt" 2>&1 || true
  sleep 2
  remote_n "echo '--- api --tail 5000'; $COMPOSE logs --no-color --tail 5000 api 2>&1 | grep -c '$marker'; \
          echo '--- api --since $t0'; $COMPOSE logs --no-color --since '$t0' api 2>&1 | grep -c '$marker'; \
          echo '--- postgres --tail 5000'; $COMPOSE logs --no-color --tail 5000 postgres 2>&1 | grep -c '${marker//-/_}'; \
          echo '--- postgres --since $t0'; $COMPOSE logs --no-color --since '$t0' postgres 2>&1 | grep -c '${marker//-/_}'" \
    >"$dir/p11-log-retrieval.txt" 2>&1 || true

  now >"$dir/99-finished-utc.txt"
  (cd "$dir" && sha256sum ./* >MANIFEST.sha256)
  echo "done: $dir"
}

# ------------------------------------------------------------------------------------------------
# Execution (owner-gated; never run during preflight)
# ------------------------------------------------------------------------------------------------
run() {
  [[ ${F07_EXECUTE_AUTHORIZED:-} == yes ]] || die "execution requires F07_EXECUTE_AUTHORIZED=yes (owner authorization)"
  need_provider
  need_template
  need_sole_active
  local base_gen=${1:?BASELINE_GEN required}; [[ $base_gen =~ ^[0-9]+$ ]] || die "BASELINE_GEN must be an integer"
  [[ -f $CREDS && $(stat -c '%a' "$CREDS") == 600 ]] || die "credential file missing or not mode 600"
  local run_id; run_id=$(cat /proc/sys/kernel/random/uuid); [[ $run_id =~ $UUID_RE ]] || die "bad uuid"
  local dir="$OUT_ROOT/run-$run_id"; mkdir -p "$dir"
  echo "$run_id" >"$dir/test-run-id.txt"; echo "$base_gen" >"$dir/baseline-gen.txt"

  # Parse (never source or print) the credential file.
  local email pw org_id tpl_id token
  email=$(sed -n 's/^EMAIL=//p' "$CREDS"); pw=$(sed -n 's/^PASSWORD=//p' "$CREDS")
  org_id=$(psql_ro <<<"SELECT id FROM organizations WHERE slug = '$ORG_SLUG';")
  tpl_id=$TEMPLATE_ID
  [[ $org_id =~ $UUID_RE && $tpl_id =~ $UUID_RE ]] || die "org/template id is not a UUID"
  token=$(jq -n --arg e "$email" --arg p "$pw" '{email:$e,password:$p}' |
    { body=$(cat); printf 'url = "%s/auth/login"\nrequest = "POST"\nheader = "Content-Type: application/json"\ndata-binary = %s\n' "$API" "$(jq -Rs . <<<"$body")"; } |
    api | jq -r '.data.accessToken // empty')
  unset pw
  [[ -n $token ]] || die "login failed"

  # Gate immediately before message 1: circuit at baseline, closed, healthy; no queue; sole active.
  local g; g=$(psql_ro <<<"SELECT status || '|' || circuit_state || '|' || circuit_generation || '|' || health_state FROM providers WHERE id = '$PROVIDER_ID';")
  [[ $g == "active|closed|$base_gen|healthy" ]] || die "pre-run gate: provider is '$g', expected active|closed|$base_gen|healthy"
  [[ $(psql_ro <<<"SELECT count(*) FROM message_dispatch_queue;") == 0 ]] || die "pre-run gate: dispatch queue not empty"
  need_sole_active; echo "$(routing_state)" >"$dir/routing-before-msg1.txt"
  local mark_start mark_end; mark_start=$(cat /proc/sys/kernel/random/uuid); mark_end=$(cat /proc/sys/kernel/random/uuid)
  echo "$mark_start" >"$dir/marker-start.txt"; echo "$mark_end" >"$dir/marker-end.txt"
  bracket "$mark_start"; sleep 1
  local start; start=$(date -u +%Y-%m-%dT%H:%M:%S.%6NZ); echo "$start" >"$dir/test-start-utc.txt"
  local i ids=() t_trip=""
  for i in $(seq 1 10); do
    local rcpt key body resp id cid st
    rcpt=$(printf '+120255503%02d' "$i"); key="$run_id-msg-$i"
    body=$(jq -cn --arg r "$rcpt" --arg t "$tpl_id" --arg id "$run_id" --argjson s "$i" \
      '{channelCode:"whatsapp",recipient:$r,templateId:$t,payload:{text:("QA-F-07 circuit breaker test msg " + ($s|tostring)),testRunId:$id,sequence:$s}}')
    resp=$(printf 'url = "%s/messages"\nrequest = "POST"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\nheader = "X-Acc-Organization: %s"\nheader = "Idempotency-Key: %s"\nheader = "X-Correlation-ID: %s"\ndata-binary = %s\nwrite-out = "\\n%%{http_code}"\n' \
      "$API" "$token" "$org_id" "$key" "$run_id" "$(jq -Rs . <<<"$body")" | api)
    printf '%s\t%s\t%s\n' "$(now)" "$i" "$(tr '\n' ' ' <<<"$resp")" >>"$dir/submissions.tsv"
    st=$(tail -n1 <<<"$resp"); id=$(head -n -1 <<<"$resp" | jq -r '.data.id // empty'); cid=$(head -n -1 <<<"$resp" | jq -r '.data.correlationId // empty')
    [[ $st == 202 ]] && [[ $id =~ $UUID_RE ]] || die "msg $i not accepted for queueing (HTTP $st); stopping further submissions"
    [[ $cid == "$run_id" ]] || die "msg $i correlationId was not honoured; stopping further submissions"
    ids+=("$id")
    # Gate: wait until message i is terminal before submitting i+1 (defeats batch concurrency).
    local deadline=$((SECONDS + 15)) status=""
    while ((SECONDS < deadline)); do
      status=$(printf 'url = "%s/messages/%s"\nheader = "Authorization: Bearer %s"\nheader = "X-Acc-Organization: %s"\n' "$API" "$id" "$token" "$org_id" | api | jq -r '.data.status // empty')
      [[ $status == failed || $status == accepted || $status == outcome_unknown ]] && break
      sleep 0.2
    done
    printf '%s\t%s\t%s\t%s\n' "$(now)" "$i" "$id" "$status" >>"$dir/settlements.tsv"
    [[ $status == failed ]] || die "msg $i did not settle as failed within 15 s (status '$status'); stopping further submissions"
    if ((i == 5)); then
      t_trip=$(now); echo "$t_trip" >"$dir/msg5-settled-utc.txt"
      local cs; cs=$(psql_ro <<<"SELECT circuit_state || '|' || circuit_generation FROM providers WHERE id = '$PROVIDER_ID';")
      echo "$cs" >"$dir/circuit-after-msg5.txt"
      [[ $cs == "open|$((base_gen + 1))" ]] || die "circuit is '$cs' after msg 5, expected open|$((base_gen + 1)); stopping further submissions"
    fi
  done
  printf '%s\n' "${ids[@]}" >"$dir/message-ids.txt"
  date -u +%Y-%m-%dT%H:%M:%S.%6NZ >"$dir/test-end-utc.txt"
  sleep 1; bracket "$mark_end"
  echo "$(routing_state)" >"$dir/routing-after-msg10.txt"
  unset token
  echo "run complete: $dir (now run: $0 verify $dir)"
}

# ------------------------------------------------------------------------------------------------
# Post-run verification (read-only)
# ------------------------------------------------------------------------------------------------
verify() {
  local dir=${1:?RUN_DIR required}
  need_provider
  local run_id base_gen start end; run_id=$(<"$dir/test-run-id.txt"); base_gen=$(<"$dir/baseline-gen.txt")
  start=$(<"$dir/test-start-utc.txt"); end=$(<"$dir/test-end-utc.txt")
  [[ $run_id =~ $UUID_RE && $base_gen =~ ^[0-9]+$ ]] || die "bad run record"
  psql_ro >"$dir/v1-assertions.txt" <<SQL
WITH sim AS (SELECT id FROM providers WHERE id = '$PROVIDER_ID'),
org AS (SELECT id FROM organizations WHERE slug = '$ORG_SLUG'),
tm AS (
  SELECT m.id, (m.payload->>'sequence')::int AS seq, m.status, m.failure_reason, m.created_at, m.completed_at,
    (SELECT count(*) FROM message_attempts a WHERE a.message_id = m.id) AS attempts,
    (SELECT count(*) FROM message_attempts a WHERE a.message_id = m.id AND a.status = 'failed' AND a.provider_id = (SELECT id FROM sim)) AS sim_failed,
    EXISTS (SELECT 1 FROM message_events e WHERE e.message_id = m.id AND e.event_type = 'message.failed'
      AND e.payload->>'reason' = 'NO_ELIGIBLE_PROVIDER' AND e.payload->>'details' = 'All assigned provider circuits refused admission') AS refusal_event
  FROM messages m
  WHERE m.org_id = (SELECT id FROM org) AND m.correlation_id::text = '$run_id' AND m.payload->>'testRunId' = '$run_id'
)
SELECT 'C0_timing_valid_window60_cooldown30', coalesce((
  (SELECT max(m.completed_at) FROM tm m WHERE m.seq = 5) - (SELECT min(m2.created_at) FROM messages m2 WHERE m2.id IN (SELECT id FROM tm WHERE seq = 1)) < interval '60 seconds'
  AND (SELECT max(m.completed_at) FROM tm m WHERE m.seq = 10) - (SELECT circuit_changed_at FROM providers WHERE id = (SELECT id FROM sim)) < interval '30 seconds')::text, 'false')
UNION ALL SELECT 'C1_sequence_integrity', (count(*) = 10 AND count(DISTINCT seq) = 10 AND min(seq) = 1 AND max(seq) = 10)::text FROM tm
UNION ALL SELECT 'C2_msgs_1_5_one_failed_attempt_on_provider', (count(*) FILTER (WHERE seq BETWEEN 1 AND 5 AND attempts = 1 AND sim_failed = 1 AND status = 'failed') = 5)::text FROM tm
UNION ALL SELECT 'C3_circuit_open_gen_plus_1_offline', coalesce((SELECT (circuit_state = 'open' AND circuit_generation = $base_gen + 1 AND health_state = 'offline' AND circuit_changed_at >= '$start'::timestamptz)::text FROM providers WHERE id = (SELECT id FROM sim)), 'false')
UNION ALL SELECT 'info_C3b_circuit_changed_audit_rows_in_window (informational, R-AUD-1)', (SELECT count(*) FROM audit_logs WHERE action = 'provider.circuit_changed' AND resource_id = (SELECT id FROM sim) AND created_at BETWEEN '$start'::timestamptz AND '$end'::timestamptz)::text
UNION ALL SELECT 'C5_msgs_6_10_zero_attempts_refused', (count(*) FILTER (WHERE seq BETWEEN 6 AND 10 AND attempts = 0 AND status = 'failed' AND failure_reason = 'NO_ELIGIBLE_PROVIDER' AND refusal_event) = 5)::text FROM tm
UNION ALL SELECT 'C6_exactly_5_provider_attempts_in_window_all_from_run', ((SELECT count(*) FROM message_attempts a WHERE a.provider_id = (SELECT id FROM sim) AND a.created_at BETWEEN '$start'::timestamptz AND '$end'::timestamptz) = 5
   AND (SELECT count(*) FROM message_attempts a WHERE a.provider_id = (SELECT id FROM sim) AND a.created_at BETWEEN '$start'::timestamptz AND '$end'::timestamptz AND a.message_id NOT IN (SELECT id FROM tm)) = 0)::text
UNION ALL SELECT 'C7_all_terminal_failed_none_outcome_unknown', (count(*) FILTER (WHERE status = 'failed') = 10 AND count(*) FILTER (WHERE status = 'outcome_unknown') = 0)::text FROM tm
UNION ALL SELECT 'C8_queue_drained_for_run', ((SELECT count(*) FROM message_dispatch_queue WHERE message_id IN (SELECT id FROM tm)) = 0)::text
UNION ALL SELECT 'C9_sole_active_throughout_window', ((SELECT count(*) FROM organization_provider_assignments opa JOIN organizations o ON o.id = opa.org_id JOIN channels c ON c.id = opa.channel_id
   WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp' AND opa.updated_at BETWEEN '$start'::timestamptz AND '$end'::timestamptz) = 0
   AND (SELECT count(*) FROM organization_provider_assignments opa JOIN organizations o ON o.id = opa.org_id JOIN channels c ON c.id = opa.channel_id
   WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp' AND opa.status = 'active' AND opa.provider_id <> '$PROVIDER_ID') = 0)::text
UNION ALL SELECT 'info_global_queue', (SELECT count(*) FROM message_dispatch_queue)::text
UNION ALL SELECT 'info_other_messages_in_window', (SELECT count(*) FROM messages WHERE created_at BETWEEN '$start'::timestamptz AND '$end'::timestamptz AND id NOT IN (SELECT id FROM tm))::text;
\\echo '## per-message lifecycle'
SELECT (m.payload->>'sequence')::int, m.id, m.status, m.failure_reason, m.created_at, m.completed_at,
  (SELECT count(*) FROM message_attempts a WHERE a.message_id = m.id),
  (SELECT string_agg(e.event_type || ':' || coalesce(e.payload->>'reason',''), ',' ORDER BY e.created_at) FROM message_events e WHERE e.message_id = m.id)
FROM messages m WHERE m.correlation_id::text = '$run_id' ORDER BY 1;
\\echo '## attempts'
SELECT (m.payload->>'sequence')::int, a.id, a.attempt_number, a.status, a.failure_reason, a.latency_ms, a.created_at, a.completed_at
FROM message_attempts a JOIN messages m ON m.id = a.message_id WHERE m.correlation_id::text = '$run_id' ORDER BY 1, a.attempt_number;
\\echo '## circuit_changed audit rows in window'
SELECT created_at, actor_type, outcome, before, after FROM audit_logs WHERE action = 'provider.circuit_changed'
  AND resource_id = '$PROVIDER_ID'::uuid AND created_at BETWEEN '$start'::timestamptz AND '$end'::timestamptz;
SQL
  # Logs: method chosen from the preflight P11 proof (tail-read, filtered to the run window client-side).
  # Logs: --since (window start - 120 s) first; if the bracket markers are not both present, fall back to
  # --tail 20000. The run-window filter (inwin) is applied to whichever source is used.
  local since; since=$(date -u -d "${start:0:19}Z - 120 seconds" +%Y-%m-%dT%H:%M:%SZ)
  fetch_log() { # fetch_log SERVICE OUTFILE MARKERFORM(pg|api)
    remote_n "$COMPOSE logs --no-color --timestamps --since '$since' $1 2>&1" >"$2"
    local a b; a=$(<"$dir/marker-start.txt"); b=$(<"$dir/marker-end.txt"); [[ $3 == pg ]] && { a=${a//-/_}; b=${b//-/_}; }
    if grep -q -- "$a" "$2" && grep -q -- "$b" "$2"; then echo "$1: --since $since" >>"$dir/v0-log-method.txt"
    else remote_n "$COMPOSE logs --no-color --timestamps --tail 20000 $1 2>&1" >"$2"; echo "$1: --tail 20000 (fallback; --since lacked markers)" >>"$dir/v0-log-method.txt"; fi
  }
  fetch_log api "$dir/v2-api-log-tail.txt" api
  fetch_log postgres "$dir/v3-postgres-log-tail.txt" pg
  # compose --timestamps lines look like "api-1  | 2026-10-31T05:00:00.123456789Z message"; take the ISO token.
  inwin() { awk -v s="${start:0:19}" -v e="${end:0:19}" '{for(i=1;i<=NF;i++) if($i ~ /^20[0-9][0-9]-[01][0-9]-[0-3][0-9]T/){t=substr($i,1,19); if(t>=s && t<=e) print; break}}' "$1"; }
  covered() { # both bracket markers must be present in the retrieved log ($2: "pg" uses underscores)
    local f=$1 a b; a=$(<"$dir/marker-start.txt"); b=$(<"$dir/marker-end.txt")
    [[ ${2:-} == pg ]] && { a=${a//-/_}; b=${b//-/_}; }
    grep -q -- "$a" "$f" && grep -q -- "$b" "$f" && echo yes || echo NO
  }
  {
    echo "window: $start .. $end"
    local ids; ids=$(tr '\n' '|' <"$dir/message-ids.txt"); ids=${ids%|}
    echo "L0a api log covers window: $(covered "$dir/v2-api-log-tail.txt")  (NO => C4b/C6b/C6c NOT PROVEN)"
    echo "L0b postgres log covers window: $(covered "$dir/v3-postgres-log-tail.txt" pg)  (NO => C4a NOT PROVEN)"
    echo "C6b circuit-refusal warns for run messages (>=5): $(inwin "$dir/v2-api-log-tail.txt" | grep -E 'Provider circuit refused admission' | grep -cE "$ids" || true)"
    echo "info_C3c dispatcher trip log lines 'provider circuit closed -> open' for provider at gen $((base_gen + 1)): $(inwin "$dir/v2-api-log-tail.txt" | grep -F 'provider circuit closed -> open' | grep -F "$PROVIDER_ID" | grep -cE "\"circuitGeneration\":$((base_gen + 1))[,}]" || true)"
    echo "C6c executor admission refusals in window (must be 0): $(inwin "$dir/v2-api-log-tail.txt" | grep -c 'provider submission refused: no valid circuit admission' || true)"
    echo "C4a postgres 42501/insufficient_privilege lines in window (must be 0): $(inwin "$dir/v3-postgres-log-tail.txt" | grep -cE '42501|insufficient_privilege' || true)"
    echo "C4b api insufficient_privilege/QueryFailedError lines in window (must be 0): $(inwin "$dir/v2-api-log-tail.txt" | grep -cE 'insufficient_privilege|QueryFailedError|42501' || true)"
  } >"$dir/v4-log-assertions.txt"
  (cd "$dir" && sha256sum ./* >MANIFEST.sha256)
  cat "$dir/v1-assertions.txt" "$dir/v4-log-assertions.txt"
}

routing_check() { # read-only restoration proof against the recorded original routing
  remote_n true; need_provider
  psql_ro <<SQL
SELECT opa.id, opa.priority, opa.status, p.name,
  CASE opa.id::text
    WHEN '$ORIG_ACTIVE_1' THEN 'active'
    WHEN '$ORIG_ACTIVE_2' THEN 'active'
    WHEN '$ORIG_DISABLED_1' THEN 'disabled'
    WHEN '$ORIG_DISABLED_2' THEN 'disabled'
    ELSE CASE WHEN opa.provider_id = '$PROVIDER_ID' THEN 'disabled' ELSE 'unexpected' END END AS original,
  CASE WHEN opa.status::text = (CASE opa.id::text
    WHEN '$ORIG_ACTIVE_1' THEN 'active'
    WHEN '$ORIG_ACTIVE_2' THEN 'active'
    WHEN '$ORIG_DISABLED_1' THEN 'disabled'
    WHEN '$ORIG_DISABLED_2' THEN 'disabled'
    ELSE CASE WHEN opa.provider_id = '$PROVIDER_ID' THEN 'disabled' ELSE 'unexpected' END END) THEN 'RESTORED' ELSE 'NOT RESTORED' END AS verdict
FROM organization_provider_assignments opa JOIN providers p ON p.id = opa.provider_id
JOIN organizations o ON o.id = opa.org_id JOIN channels c ON c.id = opa.channel_id
WHERE o.slug = '$ORG_SLUG' AND c.code = 'whatsapp' ORDER BY opa.priority;
SQL
}

case ${1:-} in
  preflight) preflight ;;
  run) shift; run "$@" ;;
  verify) shift; verify "$@" ;;
  routing-check) routing_check ;;
  *) echo "usage: $0 preflight | run <BASELINE_GEN> | verify <RUN_DIR> | routing-check" >&2; exit 2 ;;
esac
