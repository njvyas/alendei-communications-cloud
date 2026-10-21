# Controlled-MVP release runbook (first release)

Scope: the first, controlled release of ACC on a single Linux host with Docker Compose. It covers WhatsApp sending through the provider **simulator** only: no real provider, credential or webhook exists yet (`ROADMAP.md` §6–7). Kubernetes/Helm remain the PLANNED production topology (`DEPLOYMENT.md` §3); nothing here replaces them.

Artifacts: `deploy/api.Dockerfile`, `deploy/web.Dockerfile`, `deploy/compose.release.yml`, `deploy/release.env.example`. Every command below is run from the repository root with

```bash
C="docker compose -f deploy/compose.release.yml --env-file deploy/release.env"
```

## 1. Environments and the deployment mode

| Environment | How it runs | Configuration | Credentials |
|---|---|---|---|
| Local development | `docker-compose.yml` (infrastructure) + `npm run dev:api` / `dev:web` on the host | `.env` (from `.env.example`) | Well-known development passwords; the dispatch credential may be omitted (`APP_ENV=development`) |
| Test / CI | Ephemeral service containers (`.github/workflows/ci.yml`), disposable clones locally (`scripts/with-db-clone.mjs`) | `APP_ENV=test` | CI-generated; dispatch loop off except in its own suites |
| **Controlled MVP** | `deploy/compose.release.yml` on the release host | `deploy/release.env`, **`APP_ENV=staging`** | Generated per host |
| Production | Not runnable yet | `APP_ENV=production` | Refuses to start with `SECRETS_BACKEND=env`; no other secrets backend exists |

### 1a. Why the controlled MVP runs as `staging`

`APP_ENV=production` deliberately refuses to read secrets from environment variables (`SECURITY.md` §3, `env.schema.ts`), and no secrets-manager backend (Vault or a cloud KMS) is implemented. The production safeguards are not weakened for this release; the controlled MVP runs as `staging` instead.

**Controls that hold in `staging` exactly as in production:**

- Configuration is validated before startup; any problem refuses the start and names the variable, never its value.
- **Dispatch credential (B3):** `DATABASE_DISPATCH_PASSWORD` or `DATABASE_DISPATCH_URL` is mandatory; the development password and a URL for another principal are refused; at startup the API proves the dispatch pool logs in as `acc_dispatch` and that `acc_app`, `acc_auth` and `acc_dispatch` are RLS-bound (not superuser, no `BYPASSRLS`, no table ownership, no role membership).
- Tenant isolation (PostgreSQL RLS beneath the authorization layer), five-scope RBAC, R-6 delegation, the audit trail, rate limits, the `Secure` refresh cookie (only development and test omit it) and the protected OpenAPI document (served to signed-in sessions only, no UI).

**Production rules that `staging` does not enforce by itself, so `release.env` must set them** (the template does):

| Rule | Setting |
|---|---|
| https-only CORS, no wildcard | `CORS_ORIGINS=https://<console host>` |
| explicit proxy hop count | `TRUSTED_PROXY_HOPS=1` (one TLS proxy) |
| structured logs | `LOG_PRETTY=false` |
| database TLS | `DATABASE_SSL=false` is acceptable **only** because PostgreSQL is on the private compose network of the same host; a managed or remote database requires `true` |

**Known `staging` differences (accepted for the MVP):** the API sends no Content-Security-Policy header (helmet enables it only in production; API responses are JSON), and API keys carry the `ak_test_` prefix instead of `ak_live_`.

### 1b. Before a future production-mode deployment

1. A non-env secrets backend implemented behind `SecretsPort` (Vault or a cloud KMS) and `SECRETS_BACKEND` set to it.
2. `DATABASE_SSL=true` with a TLS-capable database.
3. https-only `CORS_ORIGINS` and an explicit `TRUSTED_PROXY_HOPS` (then enforced by validation).
4. Bootstrap run with its production confirmation; credentials rotated from the controlled-MVP values.
5. Real provider credentials and webhooks, if leaving the simulator, under their own decisions (ADR-013 F-1).

## 2. MVP onboarding scope (frozen)

- **Platform administrators** create organizations, create each organization's administrator with the seeded `org_admin` role (an audited R-6 delegation), assign providers, and activate users (§5a).
- **Organization administrators** run their organization: they create its users (`POST /users`, e.g. `read_only`), templates, contacts and messages. Their new users still need the operator activation in §5a.
- **Reseller administrators do not appoint organization administrators.** `org_admin` carries the tenant-content permissions, which a reseller administrator does not hold, and delegation is platform-only (`RBAC.md` §7b). No reseller onboarding or new delegation path is part of this release.
- There is no self-service invitation link or email delivery.

## 3. Release host prerequisites (owner-provided)

1. A Linux host (x86_64; 2 vCPU / 4 GB RAM / 40 GB disk is ample) with Docker Engine and the Compose plugin, and the repository checked out at the release commit.
2. A DNS name for the console, e.g. `acc.<domain>`.
3. A TLS certificate for it and a reverse proxy on the host terminating HTTPS (nginx, Caddy or the organization's standard). It forwards `/api/` → `http://127.0.0.1:3001` (keep the `/api/v1` prefix) and everything else → `http://127.0.0.1:3000`, and does **not** expose `/metrics` or `/health*` publicly.
4. Firewall: inbound 443 (and 80 only for ACME, if used) and restricted SSH. `compose.release.yml` publishes only the API and console, only on `127.0.0.1`; PostgreSQL and Redis have no published port.
5. A backup location off the host for `pg_dump` output (§7).

## 4. Secrets and configuration

1. `cp deploy/release.env.example deploy/release.env && chmod 600 deploy/release.env`; fill every `<…>`, generating each secret independently (`openssl rand -hex 24`). Never reuse a development value.
2. `deploy/release.env` is excluded by `.gitignore` and `.dockerignore` (`deploy/*.env`). Never commit it, attach it to a ticket or paste it into chat.
3. Do not run `docker compose … config` where its output is logged or shared: it prints the resolved environment, including secrets.
4. User passwords are given to `activate-user` on stdin only (§5a); never as an argument or environment variable.

## 5. Build and first installation

### 5.1 Build

From a commit whose CI run is green:

```bash
VERSION=$(date +%Y.%m.%d)-$(git rev-parse --short HEAD)
docker build -f deploy/api.Dockerfile -t acc-api:$VERSION .
docker build -f deploy/web.Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://<console host>/api/v1 \
  --build-arg NEXT_PUBLIC_APP_ENV=staging -t acc-web:$VERSION .
docker image inspect --format '{{.Id}}' acc-api:$VERSION acc-web:$VERSION   # record both
```

Set `ACC_VERSION=$VERSION` in `deploy/release.env`. The console image is built per environment because `NEXT_PUBLIC_API_BASE_URL` is compiled into it.

### 5.2 Fresh database installation

| Step | Command | Pass criterion |
|---|---|---|
| 1. Data services | `$C up -d --wait postgres redis` | both healthy |
| 2. Schema | `$C run --rm migrate` | `Applied 36 migration(s) after 0 verified` and `Roles were not changed` |
| 3. History proof | `$C exec -T postgres psql -U postgres -d acc -Atc "SELECT count(*), md5(string_agg(hash \|\| ':' \|\| created_at, ',' ORDER BY id)) FROM drizzle.__drizzle_migrations"` | `36\|093bfe92208baf0ff073f6b154c00c68` — exactly the committed migrations `0000`–`0035` |
| 4. Role logins | `$C run --rm roles` | `Roles reconciled … acc_app, acc_auth, acc_relay, acc_dispatch` |
| 5. Seed | `$C run --rm seed` | completes (idempotent) |
| 6. First operator | `$C run --rm bootstrap` | `Platform administrator created` (a re-run: `Already bootstrapped`) |
| 7. Start | `$C up -d --wait api web` | both healthy; `$C logs api` shows `Database principals verified RLS-bound: acc_app, acc_auth, acc_dispatch` and `message dispatch started` |
| 8. Acceptance | §9 | every item passes |

Migrations run as a **single** one-off container: `db:migrate` verifies the full history against the committed files before applying anything and refuses on any mismatch, but takes no lock.

### 5a. Activating a user (operator)

Users created through the API are `invited` and have no password. A platform administrator activates each one on the host:

```bash
read -rs PW                                   # typed, not echoed, not in shell history
printf '%s\n' "$PW" | $C run --rm -T activate-user \
  --operator <platform admin email> --organization <organization id or slug> \
  --email <user email> --password-stdin
unset PW
```

It refuses (exit 1, `user activation refused: <reason>`) unless the operator is an active platform administrator holding `users.reactivate`, the organization is active, and the user is `invited`, has no credential, holds a grant in that organization and no platform or reseller grant. The password must be 12–256 characters without surrounding whitespace. Success and refusals are audited as `user.activated` (outcome `success` / `denied`, actor = the operator, label `user_activation_cli`); the password is never logged or stored in plaintext. Hand the password to the user over a separate channel.

## 6. Upgrade

1. Build and record new images (§5.1) from a green commit.
2. Back up: `$C exec -T postgres pg_dump -U postgres -d acc -Fc > acc-<date>-pre-<version>.dump`, copied off-host.
3. Set `ACC_VERSION=<new>`; `$C run --rm migrate` — refuses before applying anything if the recorded history does not match the committed files.
4. `$C up -d --wait api web`; re-run §9.

## 7. Rollback and recovery

- **Application only**: set `ACC_VERSION` back to the previous recorded tag; `$C up -d --wait api web`. Safe whenever no migration ran in between.
- **After a migration**: migrations are forward-only. Stop `api` and `web`, restore the pre-upgrade dump (`$C exec -T postgres pg_restore -U postgres -d acc --clean --if-exists < <dump>`), start the previous version. Data written after the backup is lost — the point of no return; take the dump immediately before migrating.
- **Crash or host restart**: containers restart (`unless-stopped`). A message left mid-submission is settled by lease recovery within ~30 s as `outcome_unknown` and never resubmitted; queued messages are dispatched on the next poll.
- **Redis loss**: rate-limit counters and short-lived WebSocket tickets only; all business state is in PostgreSQL.
- **Database loss**: restore the latest dump; the recovery point is the backup interval.

## 8. Shutdown

`$C stop` sends SIGTERM. The API stops taking requests, lets the dispatch cycle in progress finish, closes its pools and exits within `SHUTDOWN_TIMEOUT_SECONDS` (compose grace: 30 s); its log ends `Shutdown complete`.

## 9. Release acceptance (pass/fail)

1. **Health**: `curl -fsS http://127.0.0.1:3001/health/ready` → `"status":"ok"` (PostgreSQL and Redis up); the console answers on `https://<console host>/login`.
2. **Credential refusal**: `$C run --rm --no-deps -e DATABASE_DISPATCH_PASSWORD=acc_dispatch_dev_password api` exits with `DATABASE_DISPATCH_PASSWORD must not be the development password when APP_ENV=staging`; with an empty value it is refused as too short.
3. **Operator sign-in** over HTTPS.
4. **Onboarding**: the operator creates an organization, its administrator (`org_admin`) and a provider assignment; activates the administrator (§5a).
5. **Send**: the organization administrator sends a WhatsApp message; the console's settlement monitor reaches `PROVIDER_ACCEPTED` with no other action.
6. **Isolation**: another organization's administrator gets `404` for that message.
7. **Least privilege**: a `read_only` member gets `403` on send.
8. **Failure handling**: a provider error falls back to the next provider (accepted, 2 attempts); with every provider failing the message ends `FAILED`.
9. **Audit**: the organization administrator's Audit Logs show the organization, the invitation and the grant.
10. **Restart**: `$C stop api && $C up -d --wait api` — the log shows `Shutdown complete`, the API is healthy again, and every message is in a final state with an empty dispatch queue.

Automated equivalents run against disposable clones: `apps/api/test/org-admin-onboarding.sec-spec.ts`, `user-activation.sec-spec.ts`, `dispatch-worker.int-spec.ts`, `messages-api.int-spec.ts`, the full API security suite, `env.schema.spec.ts` / `dispatch-credential.spec.ts`, and `apps/web/e2e/whatsapp-console.spec.ts` (WA-01–WA-06).

## 10. Deployment checklist

| # | Item | Done when |
|---|---|---|
| 1 | Host | Docker Engine + Compose plugin; repository at the release commit; CI green on it |
| 2 | DNS | `acc.<domain>` resolves to the host |
| 3 | TLS + proxy | certificate installed; proxy routes `/api/` → 127.0.0.1:3001, rest → 127.0.0.1:3000; `/metrics`, `/health*` not public |
| 4 | Firewall | only 443 (+80 for ACME) and restricted SSH inbound |
| 5 | Secrets | `deploy/release.env` filled, mode 600, every secret generated for this host |
| 6 | Images | both built (§5.1), IDs recorded, `ACC_VERSION` set |
| 7 | Database | §5.2 steps 1–6 pass, history proof exact |
| 8 | Start + health | §5.2 step 7 and §9.1 |
| 9 | Acceptance | §9.2–9.10 pass |
| 10 | Backups | first `pg_dump` taken and copied off-host; schedule set |
| 11 | Post-deployment | 24 h: health green, no `dispatch cycle failed` or `recovered expired dispatch leases` in `$C logs api` beyond isolated cases, queue empty between sends |
| 12 | Rollback ready | previous image IDs recorded (none on first install) and §7 understood |

## 11. Known limitations of the controlled MVP

- Simulator only: nothing reaches a real WhatsApp, SMS or RCS recipient.
- Users are activated by the operator (§5a); no self-service invitation or password reset.
- Reseller administrators cannot appoint organization administrators (§2).
- `APP_ENV=production` cannot start until a secrets-manager backend exists (§1b).
- One host, one API instance, no high availability; images are not slimmed or digest-pinned.
