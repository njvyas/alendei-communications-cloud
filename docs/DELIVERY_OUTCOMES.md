# Delivery outcomes — Phase 5.0 operator and verification guide

> **Status (07-Nov-2026):** Phase 5.0 (PR-A to PR-E) implements delivery-outcome ingestion for
> the **simulator only**. Webhook ingress is **disabled by default** (`DELIVERY_WEBHOOKS_ENABLED=false`)
> and stays disabled in every environment until its enablement is separately authorised (release
> steps S5–S7 below). No real provider adapter, credential or outbound client exists.
> Design: Phase 5.0 design specification Rev 2 and implementation plan (frozen 07-Nov-2026);
> decisions: `DECISIONS.md` §"Phase 5.0".

## 1. The model — two independent axes (Option B)

| Axis | Column | Values | Written by |
|---|---|---|---|
| Submission (unchanged) | `messages.status`, `message_attempts.status` | `queued` … `accepted` / `failed` / `outcome_unknown` | the dispatcher only |
| Delivery (new) | `delivery_status` on messages and attempts | `pending`, `delivered`, `undelivered`, `not_supported`, or `NULL` | settlement (initial value) and receipt ingestion |
| Read | `read_at` (attribute, not a status) | timestamp or `NULL` | receipt ingestion |

- **`NULL` delivery status means *not tracked*:** the record predates Phase 5.0 (no backfill), or the attempt never reached a provider. The read APIs always return the three delivery fields; `null` must be shown as "not tracked", never as "pending".
- **`not_supported`:** the provider or channel declares no delivery receipts (`delivery_receipts` capability absent).
- **A delivery outcome never rewrites the submission status.** A `failed` message whose superseded attempt is later reported delivered shows `status: failed`, `deliveryStatus: delivered`; an `outcome_unknown` message stays `outcome_unknown` when a receipt resolves it on the delivery axis.
- **Monotonic and write-once:** rank `pending`/`not_supported` (0) < `undelivered` (1) < `delivered` (2); `delivered_at`, `read_at` and `provider_message_id` are write-once (database guards, migration 0044).
- **Message aggregate:** any attempt `delivered` makes the message `delivered`; otherwise the message mirrors its current attempt. `read_at` is the earliest across attempts.
- **No new send, ever:** a receipt never creates, requeues or cancels an attempt; `undelivered` triggers no fallback in 5.0.

Read APIs (PR-D): `GET /messages`, `GET /messages/:id` (fields on messages and attempts; `deliveryStatus` list filter), `GET /usage/messages` (`delivery` block), platform support `GET /platform/support/organizations/:id/dispatch?deliveryStatus=` (migration 0049). See `API.md` §2b and `FRONTEND_API_CONTRACT.md` §33c.

## 2. The provider webhook ingress (internal appendix, OD-10)

Excluded from the customer OpenAPI document. Two forms of **one** route, one pipeline:

| Form | Request | Key carried in |
|---|---|---|
| URL form (PR-C; real providers) | `POST /api/v1/webhooks/providers/<key>` | the path |
| Header form (PR-E; owner-approved contract correction, 07-Nov-2026) | `POST /api/v1/webhooks/providers` + `X-Acc-Webhook-Ingress-Key: <key>` | the dedicated header |

- **Exactly one credential form.** A key in the path *and* the header, in neither, an empty or a repeated header: all resolve to no provider and receive the **same uniform 401** (`WEBHOOK_NOT_ACCEPTED`) as an unknown key or a bad signature (AC-SV-2).
- **Pipeline, identical for both forms:** global and per-IP rate limits (before any key handling) → `application/json` and the 64 KiB body limit (raw bytes captured on this route only) → key resolution (HMAC-SHA256(pepper, key); current key or previous key within its rotation grace) → per-provider limits → the adapter's signature check over the raw bytes and the ±300 s replay window → per-element insert-or-count deduplication (`provider_event_id`, else the element hash) → strict correlation within the provider (every supplied reference must name the same attempt) → ingestion as `acc_delivery` under the message-then-attempt lock order.
- **Disabled** (`DELIVERY_WEBHOOKS_ENABLED=false`): both forms answer the uniform path-free 404 and touch nothing; no `acc_delivery` connection exists.
- **Per-provider kill switch:** `POST /providers/:id/webhook-ingress/disable` (a disabled provider's key answers exactly like an unknown key).

### 2a. Where the key can never appear (OD-19)

| Surface | Control |
|---|---|
| Application logs | on both forms the pino request serializer drops the query string, fragment and params, and on the URL form replaces the key with `:providerKey`; the header is redacted (`req.headers`, and any logged `headers` object) |
| Traces | on both forms the HTTP instrumentation request hook overwrites every URL attribute of the span with the query-free redacted path (`url.query` empty) and sets `http.route` to the form's template; no request header is ever captured as a span attribute |
| Error bodies | uniform, path-free 401/404/413/415; the middleware answers non-POST or extra-segment requests itself |
| Database | only the peppered hash (`providers.webhook_ingress_key_hash`); `webhook_events` holds a redacted normalised envelope, never headers |
| Audit | rotation/enable/disable and the simulator trigger are audited without the key or its hash |
| Reverse proxy | `deploy/nginx/acc-webhook-ingress-redaction.conf`: the ingress location (both forms) logs with `acc_redacted` and keeps its error log at `crit`; nginx forwards the header unchanged and never logs request headers. Proven by `deploy/nginx/verify-webhook-redaction.sh` (with `ACC_OD19_NEGATIVE_CONTROL=1` as the negative control) |

## 3. Enablement prerequisites (per environment; each step separately authorised)

| Step | What | Evidence |
|---|---|---|
| S0 | Fresh backup, off-host copy, test restore (pre-create `acc_delivery` NOLOGIN for a fresh-cluster restore, `RELEASE.md` §7) | backup verified |
| S1–S2 | Load images; `migrate` (0044–0049) | history proof `50\|36a91c1259daa5bcf6ec6847880dea98` |
| S3 | Owner/operator provisions the `acc_delivery` password reference; `db:roles:reconcile` | `acc_delivery` LOGIN and RLS-bound |
| S4 | Start `api`/`web` with `DELIVERY_WEBHOOKS_ENABLED=false` | health 200; smoke and regression unchanged |
| S5 | Apply and verify the nginx redaction on that host — **both forms** (OD-19) | log sample shows `:providerKey`, no key, no header value |
| S6 | Set `WEBHOOK_INGRESS_KEY_PEPPER_REF` (and, simulator testing only, `SIMULATOR_WEBHOOK_SIGNING_KEY_REF`); issue keys (`POST /providers/:id/webhook-ingress-key`, shown once) and enable providers | audit shows the rotation, without the key |
| S7 | `DELIVERY_WEBHOOKS_ENABLED=true`; restart the API (fails closed unless `acc_delivery` connects RLS-bound) | startup lists `acc_delivery` |
| S8 | Acceptance run (QA, separately authorised) — §4 and §6 | QA record |

## 4. Operator simulator trigger (T11, OD-16)

Generates the receipts of a scripted simulator scenario for **one attempt** and sends them through the **real public ingress over loopback**, so they meet every check a provider's receipts meet.

**Prerequisites:** a platform user holding `providers.test_send` (session sign-in; API keys are not accepted); a `simulator` provider with an ingress key issued and its ingress enabled; `DELIVERY_WEBHOOKS_ENABLED=true` (S7); the simulator signing key configured (S6); the target attempt's id (`attempts[].id` in the tenant's message detail, `GET /messages/:id`; platform support diagnostics do not expose attempt ids, so for a tenant's message it is obtained from the tenant).

**Invocation** (placeholders in angle brackets; never paste a real key into a ticket, log or chat):

```bash
curl -sS -X POST "https://<console-host>/api/v1/providers/<providerId>/simulator/delivery-events" \
  -H "Authorization: Bearer <session access token>" \
  -H "X-Acc-Webhook-Ingress-Key: <the provider's ingress key>" \
  -H "Content-Type: application/json" \
  -d '{"attemptId":"<attemptId>","scenario":{"outcome":"DELIVERED","read":true}}'
```

- **Body:** `attemptId` (required) and an optional `scenario` — a `simulator_delivery` value: `outcome` (`DELIVERED` / `UNDELIVERED` / `NONE`), `read`, `delayMs` (offsets `occurredAt` only — nothing sleeps), `duplicates` (0–3), `order` (`IN_ORDER` / `REVERSED`), `signature` (`VALID` / `INVALID` / `STALE` / `REPLAY`), `clientReferenceOnly`, `batch`, `withEventIds`. Omitted: the provider's configured `simulator_delivery` capability. `read` is refused on SMS. Any other property — including `messageId` or a URL — is refused (400).
- **Key handling:** the key is used only to forward each signed request, in the same header, over **loopback only** — `127.0.0.1` (IPv4 wildcard or loopback bind) or `::1` (IPv6 wildcard or loopback bind) — to the port this deployment listens on, on the fixed path `/api/v1/webhooks/providers`. A server bound only to a specific non-loopback address is refused (503) with nothing sent. It is never stored, logged, audited, traced or returned; a wrong key simply yields 401 answers from the ingress.
- **Response (200):** `{ providerId, attemptId, scenario, elementCount, requests: [{ index, elements, status, received, errorCode }] }` — the ingress answer to each signed request, in order. A refused receipt (for example `401` for `signature: INVALID`) is reported inside a 200.
- **Errors:** 400 invalid body, scenario or missing key header; 401 no session; 403 not a platform `providers.test_send` holder; 404 unknown provider; 409 `WEBHOOK_INGRESS_DISABLED`; 422 not a simulator provider; 503 signing key not configured or loopback unavailable.
- **Audit:** `provider.test_sent` (the existing action and policy) with `metadata.tool = "simulator_delivery_events"`, the attempt id, the scenario, the element and request counts and the per-request outcomes.
- **Idempotent by construction:** event ids derive from the attempt and the event kind, so re-running a scenario is recorded as duplicates and changes nothing more.

### 4a. Expected results (spec §F.3; asserted by `phase5_0-simulator-trigger.sec-spec.ts`)

| Scenario | Expected state |
|---|---|
| `DELIVERED` | attempt and message `pending` → `delivered`; submission status unchanged; `message.delivered` |
| `DELIVERED` + `read` (WhatsApp/RCS) | `delivered` and `read_at` set; `message.read` |
| `read` on SMS | refused (400) |
| `UNDELIVERED` | → `undelivered`; `message.undelivered`; no fallback |
| `REVERSED` (read first) | `delivered` (flag `inferred_from_read`) and `read_at` |
| `duplicates: 2` | three requests accepted; one `webhook_events` row with `duplicate_count` 2; state written once |
| `signature: INVALID` / `STALE` | each request answered 401; no row; no change |
| `signature: REPLAY` | second request a duplicate; no change |
| `withEventIds: false` + duplicates | deduplicated by the element hash |
| `batch` | one request carrying every element |
| `NONE` | nothing sent; still audited |
| attempt after a submission timeout | delivery `delivered`; status stays `outcome_unknown` |
| unknown attempt, or another provider's attempt | `unmatched`; nothing changes |
| same scenario again | duplicates only; nothing changes |

## 5. Escalation-race fixture (T11; spec §B.7, §B.8)

A **test fixture only** (`apps/api/test/phase5_0-escalation-fixture.ts`) — Phase 5.0 has **no** timer, poller, worker, escalation or fallback on delivery evidence. It runs the escalation statement the future Phase 5 engine will use, in one transaction under the §B.8 lock order (message, then current attempt), and only affects a message when all of:

- **E1** `messages.current_attempt_id` is the expected attempt;
- **E2** `messages.status = 'accepted'`;
- **E3** the current attempt is `accepted` with `delivery_status = 'pending'`;
- **E4** `messages.delivery_status` is not `delivered` (no attempt has delivered).

**What it proves** (`phase5_0-escalation.int-spec.ts`): eligibility exactly as above and a no-op for `queued`, `routing`, `submitting`, `failed`, `outcome_unknown`, `not_supported`, `undelivered`, a stale expected attempt and any delivered attempt (AC-LT-5); against the real ingestion of a delivered receipt — forced in both orders and in 40 concurrent races — exactly one side acts on the eligible state first, the escalation's verdict matches what it saw under its locks, the delivery outcome is never lost, the submission status is never rewritten, no attempt is created or requeued, and no deadlock or unhandled failure occurs (AC-LT-3).

**What it does not prove:** a real escalation. The 0044 terminal guard refuses every non-delivery change to an `accepted` message, so the fixture's `UPDATE` writes only `updated_at` (a marker); superseding the attempt and sending again require a Phase 5 design and guard change. Consequently `message.delivered_after_escalation` is defined in the contracts but never emitted in 5.0, and the fixture's principal (the test owner connection) is not a production principal.

## 6. Verification evidence (how to reproduce)

All database suites run on a disposable clone through `scripts/with-db-clone.mjs` (never on a shared database).

| Suite | Proves |
|---|---|
| `packages/db` `phase5_0-delivery-schema.int-spec.ts` | delivery columns, guards, grants, strict correlation resolver |
| `apps/api` `phase5_0-settlement.int-spec.ts` | settlement writes the initial delivery status and provider message id per attempt (AC-SIM-2) and applies deferred receipts |
| `phase5_0-webhook-ingress.sec-spec.ts`, `phase5_0-webhook-ratelimit.sec-spec.ts` | the URL-form pipeline, signatures, replay, deduplication, isolation, late receipts (AC-LT-1/2/4), rate limits — and the header form's rate limiting |
| `phase5_0-ingress-header-form.sec-spec.ts` | the header form: same pipeline, the exactly-one-form rule and uniform 401, key absent from bodies, metrics and rows |
| `provider-webhook-key.sec-spec.ts` | key administration; with ingress disabled: 404 for both forms, trigger 409 |
| `phase5_0-simulator-trigger.sec-spec.ts` | §4a end to end, authorization, audit, key non-disclosure |
| `phase5_0-escalation.int-spec.ts` | §5 |
| `phase5_0-delivery-read-api.int-spec.ts`, `platform-support` suites | the read APIs and filters |
| unit `ingress-header-form.spec.ts`, `ingress-redaction.spec.ts` | credential-form rules, log redaction with the real pino options, no header capture in tracing, the trigger's fixed loopback destination |
| `deploy/nginx/verify-webhook-redaction.sh` | proxy logs carry neither form's key; the header reaches the upstream |

## 7. Simulator-only verification vs real-provider behaviour

| Topic | In Phase 5.0 (simulator) | For a real provider (not implemented) |
|---|---|---|
| Who sends receipts | the simulator factory (tests) or the operator trigger | the provider, over the internet, through the proxy |
| Key transport | header form (trigger) or URL form | URL form unless the provider can set the header |
| Signature | simulator HMAC scheme (`x-acc-sim-signature`) with a non-production key from `SecretsPort` | the provider's own scheme, in its adapter — none exists |
| Receipt timing | immediate; `delayMs` only offsets timestamps | arbitrary delays, retries, out-of-order delivery by the provider |
| Payload variety | the scenario set of §4a | provider-specific statuses and error codes |
| Evidence | proves ACC's pipeline, state rules, isolation and redaction | real carrier behaviour is **not** evidenced by any simulator run |

## 8. Limitations and open items

- **Real adapters and credentials:** none (Credential Reference Architecture not started).
- **Trigger targeting:** `attemptId` only; a `messageId` form would need a new definer resolver and migration (not authorised in 5.0).
- **Retention of `webhook_events` (OD-15):** not implemented.
- **`expired` delivery state (OD-2), Phase 5 triggers on `undelivered` / `not_supported` (OD-20), suppression of an unsent fallback once delivery evidence exists (OD-17):** Phase 5 decisions.
- **`message.delivered_after_escalation`:** defined, not emitted (§5).
- **Platform view of `webhook_events`:** a redacted definer function exists (`app_platform_support_webhook_events`, migration 0044); no API route exposes it yet.
- **Customer-facing outbound webhooks, event publishing, billing:** out of scope (`EVENTS.md`).
