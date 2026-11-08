#!/usr/bin/env bash
# OD-19 verification: runs the redaction config in a throwaway nginx container and proves
# that no access-log or error-log line carries an ingress key — in the URL form or the
# header form (Phase 5.0 PR-E) — that the header form reaches the upstream with its header
# intact, and that other routes still log their full path. Needs Docker. Touches nothing outside its own temporary directory
# and container (both removed on exit).
#
#   deploy/nginx/verify-webhook-redaction.sh            # exits 0 only if every check passes
#   ACC_OD19_NEGATIVE_CONTROL=1 deploy/nginx/verify-webhook-redaction.sh
#       # runs WITHOUT the redaction (stock `combined` format, error log at `error`) and must
#       # FAIL the key check — proving the check detects a leak
set -euo pipefail
IMAGE="${ACC_NGINX_IMAGE:-nginx:1.27-alpine}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
NAME="acc-tmp-od19-$(openssl rand -hex 4)"
PORT="${ACC_OD19_PORT:-58080}"
KEY="od19-$(openssl rand -hex 16)"
HKEY="od19h-$(openssl rand -hex 16)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/conf.d" "$WORK/log"
# The http-context part of the shipped file, verbatim (comments and the map/log_format).
cp "$HERE/acc-webhook-ingress-redaction.conf" "$WORK/conf.d/acc-webhook-ingress-redaction.conf"
# The shipped location block, uncommented, in a test server whose upstream is a local
# stub (200) — and a second ingress location whose upstream is dead (502), to prove the
# error log never records the request line.
LOCATION="$(sed -n '/^# location ~ \^\/api\/v1\/webhooks\/providers(\/|\$) {/,/^# }/p' "$HERE/acc-webhook-ingress-redaction.conf" | sed 's/^# \{0,1\}//')"
[ -n "$LOCATION" ] || { echo "FAIL: the shipped location block was not found"; exit 1; }
DEAD_LOG="acc_redacted"; DEAD_ERR="crit"
if [ "${ACC_OD19_NEGATIVE_CONTROL:-0}" = "1" ]; then
  echo "NEGATIVE CONTROL: redaction removed (combined format, error log at error)"
  LOCATION="$(echo "$LOCATION" | sed 's/ acc_redacted;/ combined;/; s/ crit;/ error;/')"
  DEAD_LOG="combined"; DEAD_ERR="error"
fi
cat > "$WORK/conf.d/zz-test-server.conf" <<CONF
# The stub upstream stands in for the API (which redacts its own logs); its own access
# log is off so only the proxy under test is measured. On the header-form route it answers
# 200 only if the key header arrived with the exact value (so the proxy forwards it), else 400.
server {
  listen 127.0.0.1:3001; access_log off;
  location = /api/v1/webhooks/providers {
    if (\$http_x_acc_webhook_ingress_key != "$HKEY") { return 400 "header missing\n"; }
    return 200 "stub-header\n";
  }
  location / { return 200 "stub\n"; }
}
server {
  listen 80;
  access_log /var/log/nginx/access.log combined;
  error_log  /var/log/nginx/error.log info;
$(echo "$LOCATION" | sed 's/^/  /')
  location ~ ^/dead/v1/webhooks/providers/ {
    access_log /var/log/nginx/access.log $DEAD_LOG;
    error_log  /var/log/nginx/error.log $DEAD_ERR;
    proxy_pass http://127.0.0.1:9;
  }
  location /api/ { proxy_pass http://127.0.0.1:3001; }
}
CONF
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:80" \
  -v "$WORK/conf.d:/etc/nginx/conf.d:ro" -v "$WORK/log:/var/log/nginx" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/ping" 2>/dev/null && break; sleep 0.2; done
docker exec "$NAME" nginx -t >/dev/null 2>&1 || { echo "FAIL: nginx -t"; exit 1; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
c1=$(code -X POST -H 'content-type: application/json' --data '{"events":[]}' "http://127.0.0.1:$PORT/api/v1/webhooks/providers/$KEY")
c2=$(code -X POST --data '{}' "http://127.0.0.1:$PORT/api/v1/webhooks/providers/$KEY?token=$KEY")
c3=$(code -X POST --data '{}' "http://127.0.0.1:$PORT/dead/v1/webhooks/providers/$KEY")
c4=$(code "http://127.0.0.1:$PORT/api/v1/health-of-something")
c5=$(code -X POST -H 'content-type: application/json' -H "X-Acc-Webhook-Ingress-Key: $HKEY" --data '{"events":[]}' "http://127.0.0.1:$PORT/api/v1/webhooks/providers")
sleep 0.5
docker exec "$NAME" nginx -s reopen >/dev/null 2>&1 || true
sleep 0.3

fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
check "ingress requests reached nginx (200, 200, 502, 200)" '[ "$c1$c2$c3$c4" = "200200502200" ]'
check "the key appears in NO log line (access or error)" '! grep -rq "$KEY" "$WORK/log"'
check "header form: forwarded to the upstream with its key header intact (200)" '[ "$c5" = "200" ]'
check "header form: the header key appears in NO log line" '! grep -rq "$HKEY" "$WORK/log"'
check "header form: the access log records the key-free path" 'grep -q "POST /api/v1/webhooks/providers HTTP/1.1\" 200" "$WORK/log/access.log"'
check "the access log records the redacted ingress path" 'grep -q "POST /api/v1/webhooks/providers/:providerKey HTTP/1.1\" 200" "$WORK/log/access.log"'
check "the query string is dropped on the ingress" '[ "$(grep -c "providers/:providerKey HTTP" "$WORK/log/access.log")" -ge 2 ]'
check "the upstream failure (502) is logged without the request line" 'grep -q "providers/:providerKey HTTP/1.1\" 502" "$WORK/log/access.log"'
check "other routes keep their full path" 'grep -q "GET /api/v1/health-of-something HTTP/1.1\" 200" "$WORK/log/access.log"'
echo "--- access.log (key-free) ---"; cat "$WORK/log/access.log"
echo "--- error.log lines: $(wc -l < "$WORK/log/error.log" 2>/dev/null || echo 0)"
exit $fail
