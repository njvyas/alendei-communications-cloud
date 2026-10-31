#!/usr/bin/env bash
# D5 encrypted off-host QA backup (owner direction 31-Oct-2026). Runs on the QA host as the operator; no sudo.
#   d5-backup.sh backup          pg_dump -Fc | gpg --encrypt (public key only) -> transfer -> verify hash -> prune
#   d5-backup.sh restore-verify  fetch newest -> verify hash -> gpg --decrypt (custodian key) -> full restore into
#                                scratch DB acc_d5_verify -> compare row counts with the live DB -> drop scratch
# Config (mode 600): D5_CONF (default ~/.config/acc-d5/d5.conf) defining:
#   DEST="user@backup-host:/path"  or a local path (tests only)    GPG_RECIPIENT="<fingerprint>"
#   RETENTION_DAYS=30   COMPOSE="cd ~/acc && docker compose -f deploy/compose.release.yml --env-file deploy/release.env"
# Never writes a plaintext dump to disk. Scratch database name is hard-coded and allowlisted.
set -euo pipefail
umask 077
CONF=${D5_CONF:-$HOME/.config/acc-d5/d5.conf}
[[ -f $CONF && $(stat -c '%a' "$CONF") == 600 ]] || { echo "config $CONF missing or not mode 600" >&2; exit 2; }
# shellcheck disable=SC1090
source "$CONF"
: "${DEST:?}" "${GPG_RECIPIENT:?}" "${RETENTION_DAYS:=30}" "${COMPOSE:?}"
SRC_DB=${SRC_DB:-acc}             # QA: acc (default); tests may point at a local copy
SCRATCH=acc_d5_verify            # hard-coded; never derived from input
LOG=${D5_LOG:-$HOME/acc-d5.log}
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
remote() { [[ $DEST == *:* ]]; }
dest_host() { echo "${DEST%%:*}"; }
dest_path() { echo "${DEST#*:}"; }
c() { bash -c "$COMPOSE $*"; }

backup() {
  local ts f; ts=$(date -u +%Y%m%dT%H%M%SZ); f="acc-qa-$ts.dump.gpg"
  local tmp; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  c "exec -T postgres pg_dump -U postgres -d $SRC_DB -Fc" </dev/null \
    | gpg --batch --yes --trust-model always --encrypt --recipient "$GPG_RECIPIENT" --output "$tmp/$f"
  local sum; sum=$(sha256sum "$tmp/$f" | cut -d' ' -f1)
  printf '%s  %s\n' "$sum" "$f" >"$tmp/$f.sha256"
  if remote; then
    rsync -e "ssh -o BatchMode=yes" --chmod=F600 "$tmp/$f" "$tmp/$f.sha256" "$DEST/"
    local got; got=$(ssh -o BatchMode=yes "$(dest_host)" "cd '$(dest_path)' && sha256sum '$f'" </dev/null | cut -d' ' -f1)
  else
    mkdir -p "$DEST"; cp "$tmp/$f" "$tmp/$f.sha256" "$DEST/"; chmod 600 "$DEST/$f" "$DEST/$f.sha256"
    local got; got=$(sha256sum "$DEST/$f" | cut -d' ' -f1)
  fi
  [[ $got == "$sum" ]] || { log "FAIL transfer hash mismatch for $f"; exit 4; }
  log "OK backup $f sha256=$sum size=$(stat -c %s "$tmp/$f") dest=verified"
  prune
}

prune() {
  local cmd="find . -maxdepth 1 -type f \\( -name 'acc-qa-*.dump.gpg' -o -name 'acc-qa-*.dump.gpg.sha256' \\) -mtime +$RETENTION_DAYS -print -delete"
  local out
  if remote; then out=$(ssh -o BatchMode=yes "$(dest_host)" "cd '$(dest_path)' && $cmd" </dev/null); else out=$(cd "$DEST" && eval "$cmd"); fi
  log "OK prune retention=${RETENTION_DAYS}d removed=$(printf '%s' "$out" | grep -c . || true)"
}

counts() { # counts DB -> "table=rows ..." for every base table in public
  c "exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U postgres -d $1 -At -v ON_ERROR_STOP=1 -f -" <<'SQL'
SELECT string_agg(t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text, ' ' ORDER BY t)
FROM (SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public') s;
SQL
}

restore_verify() {
  RV_TMP=$(mktemp -d); local tmp=$RV_TMP
  trap 'rm -rf "$RV_TMP"; c "exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \"DROP DATABASE IF EXISTS acc_d5_verify WITH (FORCE);\"" </dev/null >/dev/null 2>&1 || true' EXIT
  local f
  if remote; then
    f=$(ssh -o BatchMode=yes "$(dest_host)" "cd '$(dest_path)' && ls -1t acc-qa-*.dump.gpg | head -1" </dev/null)
    rsync -e "ssh -o BatchMode=yes" "$DEST/$f" "$DEST/$f.sha256" "$tmp/"
  else
    f=$(cd "$DEST" && ls -1t acc-qa-*.dump.gpg | head -1); cp "$DEST/$f" "$DEST/$f.sha256" "$tmp/"
  fi
  (cd "$tmp" && sha256sum -c "$f.sha256" >/dev/null) || { log "FAIL hash check for $f"; exit 4; }
  [[ $SCRATCH == acc_d5_verify ]] || exit 9
  c "exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \"DROP DATABASE IF EXISTS acc_d5_verify WITH (FORCE);\"" </dev/null >/dev/null
  c "exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \"CREATE DATABASE acc_d5_verify;\"" </dev/null >/dev/null
  gpg --batch --decrypt "$tmp/$f" 2>/dev/null | c "exec -T postgres pg_restore -U postgres -d acc_d5_verify --no-owner --exit-on-error" \
    || { log "FAIL restore of $f into acc_d5_verify (scratch dropped on exit)"; exit 5; }
  local live scratch; live=$(counts "$SRC_DB"); scratch=$(counts acc_d5_verify)
  if [[ $live == "$scratch" ]]; then log "OK restore-verify $f: row counts identical ($(wc -w <<<"$live") tables)"
  else log "DIFF restore-verify $f: counts differ (live data may have changed since the dump)"; diff <(tr ' ' '\n' <<<"$live") <(tr ' ' '\n' <<<"$scratch") | tee -a "$LOG" || true; fi
}

case ${1:-} in
  backup) backup ;;
  restore-verify) restore_verify ;;
  *) echo "usage: $0 backup|restore-verify" >&2; exit 2 ;;
esac
