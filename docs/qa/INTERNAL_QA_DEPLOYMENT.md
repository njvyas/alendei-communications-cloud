# Internal QA deployment runbook

Purpose: a dedicated, internal-only ACC environment in which the QA team validates the current implementation and records functional, security and usability findings (`QA_TEST_PLAN.md`, `USABILITY_FEEDBACK_TEMPLATE.md`). It is **not** the external MVP and not production. It uses a fresh database; the shared development database is never reused, copied or reset.

Baseline: commit `f4d3cb3ed3a97e24aaa888071929aa4ea4d515e3` on `develop`, CI run 39645113250 green (all five jobs). Deploy only that commit, or a later one with its own green CI run.

Artifacts reused unchanged: `deploy/api.Dockerfile`, `deploy/web.Dockerfile`, `deploy/compose.release.yml`, `deploy/release.env.example`. The general procedure is `docs/RELEASE.md`; this runbook fixes the QA-specific values and adds the QA account, data and verification steps.

```bash
C="docker compose -f deploy/compose.release.yml --env-file deploy/release.env"
```

## 1. Environment and security posture

- `APP_ENV=staging`, compose project `ACC_PROJECT=acc-qa`, its own volumes. What `staging` enforces and what configuration must supply is listed in `RELEASE.md` §1a; every item there applies here.
- **Simulator only.** No real provider, provider credential, webhook, customer contact or customer data. Phone numbers come from the fictional `+1 202 555 01xx` range; email addresses use the reserved `example.test` domain.
- **Internal only.** Reachable from the internal network/VPN; never from the internet.
- Credentials are generated for this environment alone and never reused elsewhere.

## 2. Host requirements

| Item | Requirement |
|---|---|
| OS | Linux x86_64 (Ubuntu 22.04/24.04 LTS or equivalent) |
| Sizing | 2 vCPU, 4 GB RAM, 40 GB disk (images ≈ 2.7 GB each, plus data) |
| Docker Engine | ≥ 24 (rehearsed on 29.8.2) |
| Docker Compose plugin | v2 with `--wait` (rehearsed on 5.5.1) |
| Tools | `git`, `curl`, `jq`, `openssl` (`psql` is not needed on the host; it runs inside the `postgres` container) |
| Access | SSH restricted to named operators; the repository checked out at the baseline commit |

## 3. DNS, HTTPS and reverse proxy

1. Internal DNS name, e.g. `acc-qa.<internal domain>`, resolving only on the internal network.
2. Certificate from the internal CA (or the organization's certificate service) trusted by QA browsers.
3. Reverse proxy on the host (nginx shown; any equivalent):

```nginx
server {
  listen 443 ssl;
  server_name acc-qa.<internal domain>;
  ssl_certificate     /etc/ssl/acc-qa/fullchain.pem;
  ssl_certificate_key /etc/ssl/acc-qa/privkey.pem;

  location = /metrics { return 404; }
  location /health    { allow 127.0.0.1; deny all; proxy_pass http://127.0.0.1:3001; }
  location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

With exactly this one proxy, `TRUSTED_PROXY_HOPS=1`.

## 4. Firewall and access restrictions

- Inbound: 443 from the internal network/VPN ranges only; 22 from operator addresses only. Nothing else.
- `compose.release.yml` publishes only `127.0.0.1:3001` (API) and `127.0.0.1:3000` (console); PostgreSQL and Redis have no published port. Verify after start: `docker ps --filter name=acc-qa --format '{{.Names}} {{.Ports}}'` lists only those two loopback bindings.
- No outbound access is required by the application (simulator only).

## 5. Configuration (`deploy/release.env`)

Create from `deploy/release.env.example`, `chmod 600`, every secret generated with `openssl rand -hex 24` (JWT secret: `openssl rand -hex 32`). QA-specific values:

| Variable | QA value |
|---|---|
| `ACC_PROJECT` | `acc-qa` |
| `ACC_VERSION` | the image tag built from the baseline commit |
| `APP_ENV` / `NODE_ENV` | `staging` / `production` |
| `CORS_ORIGINS` | `https://acc-qa.<internal domain>` |
| `AUTH_JWT_ISSUER` | `https://acc-qa.<internal domain>` |
| `TRUSTED_PROXY_HOPS` | `1` |
| `DATABASE_*`, `REDIS_URL` | as in the template (private compose network) |
| `DATABASE_DISPATCH_PASSWORD` | generated; never the development value (refused) |
| `AUTH_BOOTSTRAP_EMAIL` | the named QA platform operator |
| `RATE_LIMIT_AUTH_MAX` | default `10` sign-ins per minute **per client address** — see decision D3 in §12 |

Never run `docker compose … config` where the output is shared: it prints resolved secrets.

## 6. Build and fresh installation

1. Build both images from the baseline commit (`RELEASE.md` §5.1), with `NEXT_PUBLIC_API_BASE_URL=https://acc-qa.<internal domain>/api/v1`. Record both image IDs.
2. Run `RELEASE.md` §5.2 steps 1–7 exactly: data services, `migrate`, history proof (`37|dc08b3f0bf5bfc870f8bc442f132c5f3`), `roles`, `seed`, `bootstrap`, start `api` and `web`.
3. Confirm in `$C logs api`: `Database principals verified RLS-bound: acc_app, acc_auth, acc_dispatch` and `message dispatch started`.

## 7. QA accounts and the five-scope RBAC setup

All accounts are created through the console or API as described, then activated by the operator (`RELEASE.md` §5a). Passwords are generated per person and handed over out of band. Use one account per tester per persona; never share accounts.

| Scope | Persona | How it is created | Notes |
|---|---|---|---|
| PLATFORM | `qa-platform-admin` (`alendei_super_admin`) | `bootstrap` (the operator) | Creates organizations, appoints org admins, manages providers |
| PLATFORM | `qa-platform-support` (`alendei_support`, read-only) | operator: `POST /users` with a platform initial role is **not** supported by `activate-user` (platform grants are refused) | **Limited:** a second platform persona can only be created by the bootstrap path or an owner-run step; treat platform-support tests as deferred unless approved |
| RESELLER | `qa-reseller-admin` (`reseller_admin` on *Alendei Direct*) | platform admin: create user with reseller-scope initial role | **Limited:** `activate-user` refuses users holding reseller grants (tenant users only), so this persona cannot be activated in this release. Reseller-scope tests are **deferred** (decision D4). There is also no API to create a second reseller |
| ORGANIZATION | `qa-org-a-admin`, `qa-org-b-admin` (`org_admin`) | platform admin creates *QA Org A* and *QA Org B*, then each admin with initial role `org_admin` | Then `activate-user` |
| WORKSPACE | `qa-org-a-ws-manager` (`workspace_manager` at workspace scope) | org A admin creates workspace *QA WS 2* and the user | `activate-user` |
| TEAM | `qa-org-a-team-reader` (`read_only` at team scope), `qa-org-a-agent` (`agent` at team scope) | org A admin creates team *QA Team 1* in *QA WS 2* and the users | `activate-user` |
| ORGANIZATION | `qa-org-a-reader` (`read_only` at organization scope) | org A admin | `activate-user` |

Activation example (operator, on the host):

```bash
read -rs PW; printf '%s\n' "$PW" | $C run --rm -T activate-user \
  --operator <qa platform admin email> --organization <org slug> --email <user email> --password-stdin; unset PW
```

## 8. Synthetic data and simulator providers

Created by the testers themselves as part of `QA_TEST_PLAN.md` (sections C–F), so creation is tested too. Reference set:

- Providers (platform admin): WhatsApp simulator providers `QA Sim OK` (no capability), `QA Sim 500` (`simulator_behavior: 500`), `QA Sim Timeout` (`TIMEOUT`), `QA Sim 429` (`429`); enabled. Assignments: Org A → `QA Sim 500` priority 1, `QA Sim OK` priority 2; Org B → `QA Sim OK`.
- Contacts: 10 per organization, names `QA Contact NN`, phones `+1202555 01NN`, consent recorded for half of them.
- Templates: 3 per organization (`qa_welcome`, `qa_otp`, `qa_promo`), moved through draft → pending → approved / rejected with the simulated approval.
- Messages: sent from the WhatsApp console; nothing leaves the host.

### 8a. Suppressions and API steps

**Suppressions** (QA-C-10) is fully available in the console:
- **Route:** `/suppressions`
- **Permissions required:** `suppressions.read` (viewing catalogue-enriched list and record details), `suppressions.manage` (adding and lifting suppressions).
- **Supported workflows:** Catalogue-enriched list, filtering by status (`active` / `cleared`) and channel, adding manual suppressions (E.164 phone or RFC 5322 email), inspecting full immutable record details, lifting active suppressions with mandatory justification reason.

**Provider assignments** (QA-D-08, E-06, F-02–F-05) have a console panel on `/organizations/[id]`, implemented in Batch 1 but not yet exercised and accepted in QA; until it is accepted, these steps use the API. In addition, suppressions can optionally be created via API by calling with an organization admin session token:

```bash
API=https://acc-qa.<internal domain>/api/v1
read -rp 'email: ' EMAIL; read -rsp 'password: ' PW; echo
TOKEN=$(curl -fsS "$API/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg e "$EMAIL" --arg p "$PW" '{email:$e,password:$p}')" | jq -r .data.accessToken); unset PW

# Assign a provider to an organization (platform admin)
curl -fsS "$API/organizations/<orgId>/provider-assignments" -H "authorization: Bearer $TOKEN" \
  -H "x-acc-organization: <orgId>" -H 'content-type: application/json' -d '{"providerId":"<providerId>","priority":1}'
# Disable / enable an assignment
curl -fsS -X POST "$API/organizations/<orgId>/provider-assignments/<assignmentId>/disable" \
  -H "authorization: Bearer $TOKEN" -H "x-acc-organization: <orgId>"
# Suppress a number in an organization (org admin token; all channels when channelId is omitted)
curl -fsS "$API/suppressions" -H "authorization: Bearer $TOKEN" -H "x-acc-organization: <orgId>" \
  -H 'content-type: application/json' -d '{"rawAddress":"+12025550103","reason":"QA suppression test"}'
unset TOKEN
```

Organization, provider and assignment IDs are shown in the console URLs and detail pages. The access token expires after 15 minutes; never paste it into tickets.

## 9. Health, logs and troubleshooting

| Need | Command / place |
|---|---|
| Liveness / readiness | `curl -fsS http://127.0.0.1:3001/health/live` · `…/health/ready` (PostgreSQL + Redis) |
| Container state | `$C ps` |
| API logs (JSON) | `$C logs -f --since 30m api` |
| Console logs | `$C logs -f --since 30m web` |
| Queue depth | `$C exec -T postgres psql -U postgres -d acc -Atc "SELECT count(*) FROM message_dispatch_queue"` |
| Message states | `$C exec -T postgres psql -U postgres -d acc -Atc "SELECT status, count(*) FROM messages GROUP BY 1"` |

| Symptom | Likely cause | Check |
|---|---|---|
| Sign-in returns 429 | auth rate limit (10/min per client address) | decision D3; wait 60 s |
| `TENANCY_CONTEXT_REQUIRED` (400) | user can see several organizations and none is selected | select the organization in the console |
| `AUTHZ_SCOPE_DENIED` / `AUTHZ_PERMISSION_DENIED` (403) | the persona lacks the permission at that scope | expected for least-privilege tests |
| `422 NO_ACTIVE_PROVIDER_ASSIGNMENT` on send | the organization has no active WhatsApp assignment | platform admin assigns a provider |
| Message stays `QUEUED` > 5 s | dispatch loop not running or failing | `$C logs api` for `dispatch cycle failed`; check `DISPATCH_WORKER_ENABLED` |
| Message `OUTCOME_UNKNOWN` | provider timeout or recovered lease (by design, never resubmitted) | provider `QA Sim Timeout` or a restart during submission |
| API container unhealthy at start | configuration refused or a principal check failed | `$C logs api` — the message names the variable or principal |

## 10. Backup, restart and recovery verification

- Data is synthetic. Take a dump before each QA round and before any upgrade: `$C exec -T postgres pg_dump -U postgres -d acc -Fc > acc-qa-<date>.dump` (store off-host; mode 600).
- Restart check (part of acceptance): `$C stop api && $C up -d --wait api` — log ends `Shutdown complete`, API healthy again, queued messages are dispatched, the queue is empty afterwards.
- Recovery: restore a dump into a fresh volume (`RELEASE.md` §7). Recovery point = last dump.

## 11. Cleanup and rollback

- Upgrade to a newer commit: `RELEASE.md` §6 (backup → `migrate` → start). Roll back the application by setting the previous `ACC_VERSION` (no migration in between) or restoring the pre-upgrade dump.
- Stop the environment, keeping data: `$C down`.
- Destroy the environment and its data: `$C down -v` — **irreversible; requires explicit approval**. Afterwards delete `deploy/release.env` and the dumps securely, and revoke any operator SSH access granted for QA.

## 12. Decisions required before deployment

| # | Decision | Recommendation |
|---|---|---|
| D1 | Host, internal DNS name, certificate source, VPN/IP ranges, operator SSH access | owner/infra to provide |
| D2 | Named QA platform operator (bootstrap email) | one named person |
| D3 | Sign-in rate limit for a QA team behind one egress address | keep the default first; if 429s block testing, raise `RATE_LIMIT_AUTH_MAX` for this environment only (configuration, no code) |
| D4 | Reseller and second platform personas cannot be activated in this release (`activate-user` is tenant-only) | accept as deferred for QA round 1, or approve a bounded change to admit them |
| D5 | Backup destination and retention for QA dumps | an internal location, kept for the QA phase |

## 13. Internal deployment acceptance checklist

| # | Check | Pass when |
|---|---|---|
| 1 | Baseline | deployed commit = CI-green commit; image IDs recorded |
| 2 | Exposure | only 443 internal/VPN and restricted 22 inbound; `docker ps` shows only the two loopback ports |
| 3 | TLS | `https://acc-qa.<internal domain>/login` loads with a trusted certificate; `/metrics` returns 404 through the proxy |
| 4 | Fresh install | migrate 36, history proof exact, roles, seed, bootstrap (re-run reports *Already bootstrapped*) |
| 5 | Startup controls | principals verified line; a deliberately invalid dispatch credential (`RELEASE.md` §9.2) refuses start |
| 6 | Health | `/health/ready` ok from the host |
| 7 | Accounts | every persona in §7 that is supported is created, activated and can sign in |
| 8 | Smoke | Org A admin sends a message that reaches `PROVIDER_ACCEPTED`; Org B admin gets 404 for it |
| 9 | Restart | §10 restart check passes |
| 10 | Secrets | `$C logs` contains none of the values in `release.env` (operator check with a local script; never paste values) |
| 11 | Backup | first dump taken and restorable |
| 12 | Handover | QA team has the URL, their accounts, `QA_TEST_PLAN.md` and `USABILITY_FEEDBACK_TEMPLATE.md` |
